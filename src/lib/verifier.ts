import { verifyMessage } from "viem";
import type { Address, Hex } from "viem";
import { z } from "zod";
import { chainLoopConfigured, readOnChainReceipt, verifierOnChain } from "./chain";
import { getEnv } from "./env";
import { appendEvent, getJob, transitionJob, updateJob } from "./jobs";
import type { Job } from "./types";

/**
 * The verifier's verdict (docs/job-spec.md section 10.3). Misbah's verifier worker re-computes a seeded sample of tiles. It
 * signs and sends `finalize` / `postFraud` itself, then reports here. The report is authenticated by the verifier key (the same
 * key the contract trusts) and, when the chain is configured, cross-checked against the on-chain receipt.
 */

export const MAX_CLOCK_SKEW_SECONDS = 120;

export const verdictMessage = (jobId: string, result: string, timestamp: number) => `mesh-verdict:${jobId}:${result}:${timestamp}`;

const hex = (len?: number) => z.string().regex(len ? new RegExp(`^0x[0-9a-f]{${len}}$`) : /^0x[0-9a-fA-F]*$/);
const tx = hex(64);

export const verdictBodySchema = z.object({
  jobId: hex(64),
  result: z.enum(["ok", "fraud"]),
  timestamp: z.number().int(),
  signature: hex(),
  sample: z.object({ beacon: z.string(), seed: z.string(), k: z.number().int().nonnegative(), indices: z.array(z.number().int().nonnegative()).max(64) }).nullish(),
  fraud: z
    .object({
      tileIndex: z.number().int().nonnegative(),
      owner: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
      expectedTileHash: z.string(),
      claimedTileHash: z.string(),
      proof: z.array(z.string()).max(16).optional(),
    })
    .nullish(),
  finalizeTx: tx.nullish(),
  fraudTx: tx.nullish(),
});
export type VerdictBody = z.infer<typeof verdictBodySchema>;

export class VerdictError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: "unauthorized" | "stale_timestamp" | "job_not_found" | "invalid_state" | "verifier_unknown" | "fraud_details_missing" | "chain_mismatch",
    message: string,
  ) {
    super(message);
    this.name = "VerdictError";
  }
}

let verifierCache: string | null = null;
export function resetVerifierCache(): void {
  verifierCache = null;
}

/** The address allowed to report verdicts: VERIFIER_ADDRESS, or the `verifier` the receipt contract trusts. */
export async function verifierAddress(): Promise<string> {
  const env = getEnv();
  if (env.VERIFIER_ADDRESS) return env.VERIFIER_ADDRESS;
  if (verifierCache) return verifierCache;
  if (!env.RECEIPT_ADDRESS) throw new VerdictError(503, "verifier_unknown", "set VERIFIER_ADDRESS (or RECEIPT_ADDRESS so it can be read from the contract)");
  verifierCache = await verifierOnChain();
  return verifierCache;
}

async function authenticate(b: VerdictBody): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - b.timestamp) > MAX_CLOCK_SKEW_SECONDS) throw new VerdictError(401, "stale_timestamp", `timestamp is more than ${MAX_CLOCK_SKEW_SECONDS}s off the server clock`);
  const address = (await verifierAddress()) as Address;
  let ok = false;
  try {
    ok = await verifyMessage({ address, message: verdictMessage(b.jobId, b.result, b.timestamp), signature: b.signature as Hex });
  } catch {
    ok = false;
  }
  if (!ok) throw new VerdictError(401, "unauthorized", "the signature is not from the verifier");
}

/** Finish a rejected job: the contract slashes the provider and refunds the requester in the same transaction as `postFraud`. */
export async function reconcileRejected(jobId: string): Promise<boolean> {
  const job = getJob(jobId);
  if (!job || job.status !== "rejected") return false;
  if (chainLoopConfigured()) {
    const r = await readOnChainReceipt(jobId);
    if (r.status !== "Rejected") return false; // the verifier has not posted the fraud proof on chain yet
  } else if (!job.fraudTx) {
    return false;
  }
  const tx = job.fraudTx ?? "rejected-on-chain";
  transitionJob(jobId, "slashed", { fraudTx: tx, slashTx: tx });
  appendEvent(jobId, "settlement", { kind: "slashed", tx, split: "50% requester, 25% verifier, 25% retained" });
  transitionJob(jobId, "refunded", { refundTx: tx });
  appendEvent(jobId, "settlement", { kind: "refunded", tx });
  return true;
}

/**
 * A pending job the contract already marks Rejected: the verifier posted the fraud proof on chain but has not (or could not)
 * report it. The chain is the source of truth, so adopt it.
 */
export async function adoptOnChainFraud(jobId: string): Promise<boolean> {
  const job = getJob(jobId);
  if (!job || job.status !== "pending" || !job.claimTx || !chainLoopConfigured()) return false;
  if ((await readOnChainReceipt(jobId)).status !== "Rejected") return false;
  updateJob(jobId, { verdict: "fraud" });
  transitionJob(jobId, "rejected");
  appendEvent(jobId, "verdict", { result: "fraud", source: "chain" });
  await reconcileRejected(jobId);
  return true;
}

export async function applyVerdict(raw: unknown): Promise<Job> {
  const b = verdictBodySchema.parse(raw);
  await authenticate(b);
  const job = getJob(b.jobId);
  if (!job) throw new VerdictError(404, "job_not_found", "job not found");

  // idempotent: the same verdict again is a no-op, never a second state change
  if (job.verdict === b.result) {
    if (b.result === "fraud") await reconcileRejected(job.jobId);
    return getJob(job.jobId) as Job;
  }
  if (job.status !== "pending" || job.verdict !== null) throw new VerdictError(409, "invalid_state", `a verdict can only be recorded for a pending job without one (this job is ${job.status})`);

  const sample = b.sample ?? job.sample;
  if (b.sample) appendEvent(job.jobId, "sample", { beacon: b.sample.beacon, seed: b.sample.seed, k: b.sample.k, indices: b.sample.indices });
  if (b.result === "ok") {
    updateJob(job.jobId, { verdict: "ok", sample: sample ?? null });
    appendEvent(job.jobId, "verdict", { result: "ok" });
    if (b.finalizeTx) {
      // the verifier finalized itself; with a chain configured, only believe it if the contract says so
      const done = !chainLoopConfigured() || (await readOnChainReceipt(job.jobId)).status === "Final";
      if (done) {
        transitionJob(job.jobId, "final", { finalTx: b.finalizeTx, releaseTx: b.finalizeTx });
        appendEvent(job.jobId, "settlement", { kind: "released", tx: b.finalizeTx });
      }
    }
    return getJob(job.jobId) as Job;
  }

  if (!b.fraud) throw new VerdictError(400, "fraud_details_missing", "a fraud verdict needs the fraud payload (tile, owner, expected and claimed hashes)");
  updateJob(job.jobId, { verdict: "fraud", sample: sample ?? null, ...(b.fraudTx ? { fraudTx: b.fraudTx } : {}) });
  transitionJob(job.jobId, "rejected");
  appendEvent(job.jobId, "verdict", { result: "fraud", tileIndex: b.fraud.tileIndex, owner: b.fraud.owner, expectedTileHash: b.fraud.expectedTileHash, claimedTileHash: b.fraud.claimedTileHash, fraudTx: b.fraudTx ?? null });
  await reconcileRejected(job.jobId);
  return getJob(job.jobId) as Job;
}
