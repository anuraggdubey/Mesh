import { flushHcs } from "./hcs";
import { autoReview } from "./review";
import { chainLoopConfigured, chainNow, escrowStatus, finalizeOnChain, lockEscrowOnChain, postClaimOnChain, refundOnChain } from "./chain";
import { getDb } from "./db";
import { getEnv } from "./env";
import { appendEvent, getJob, transitionJob, updateJob } from "./jobs";
import { markTasksFailed } from "./matcher";
import type { Job } from "./types";
import { adoptOnChainFraud, reconcileRejected } from "./verifier";

/**
 * The chain loop (docs/job-spec.md sections 7.6, 8). One pass (`chainTick`) does, for every job that needs it:
 *   1. lock the requester's payment in escrow           (paid -> assigned/running/pending jobs)
 *   2. post the claim on chain, opening the window      (pending jobs with a Merkle root)
 *   3. finalize once the window has passed AND the job is approved (the contract pays the providers)
 * Every step is idempotent and re-reads chain state, so a crash or a repeated tick never double-spends.
 * A job whose chain step keeps failing is refunded instead of hanging forever.
 */

export const MAX_CHAIN_ATTEMPTS = 4;

export interface TickReport {
  locked: string[];
  claimsPosted: string[];
  finalized: string[];
  refunded: string[];
  errors: { jobId: string; step: string; message: string }[];
}

const message = (e: unknown) => (e instanceof Error ? e.message.split("\n")[0] : String(e)).slice(0, 300);

function jobsNeeding(statuses: string[]): Job[] {
  const marks = statuses.map(() => "?").join(",");
  const rows = getDb().prepare(`SELECT job_id FROM jobs WHERE status IN (${marks}) ORDER BY created_at, rowid`).all(...statuses) as { job_id: string }[];
  return rows.map((r) => getJob(r.job_id)).filter((j): j is Job => j !== null);
}

/** A verifier verdict of "ok" approves finalization. DEV_AUTO_APPROVE skips the verifier (dev only). */
export function isApproved(job: Job): boolean {
  return job.verdict === "ok" || getEnv().MESH_DEV_AUTO_APPROVE;
}

async function failChainStep(job: Job, step: string, err: unknown, report: TickReport): Promise<void> {
  const attempts = (job.chainAttempts ?? 0) + 1;
  updateJob(job.jobId, { chainAttempts: attempts });
  report.errors.push({ jobId: job.jobId, step, message: message(err) });
  appendEvent(job.jobId, "error", { code: `chain_${step}`, message: message(err), attempt: attempts });
  if (attempts < MAX_CHAIN_ATTEMPTS) return;

  // give up: refund whatever was locked and end the job
  try {
    const fresh = getJob(job.jobId)!;
    if (fresh.status === "pending") transitionJob(job.jobId, "expired");
    else if (fresh.status === "paid") transitionJob(job.jobId, "expired");
    else if (fresh.status === "assigned" || fresh.status === "running") transitionJob(job.jobId, "failed");
    markTasksFailed(job.jobId);
    const tx = await refundOnChain(job.jobId);
    transitionJob(job.jobId, "refunded", tx ? { refundTx: tx } : {});
    appendEvent(job.jobId, "settlement", { kind: "refunded", tx });
    report.refunded.push(job.jobId);
  } catch (e) {
    report.errors.push({ jobId: job.jobId, step: "refund", message: message(e) });
  }
}

export async function chainTick(): Promise<TickReport> {
  const report: TickReport = { locked: [], claimsPosted: [], finalized: [], refunded: [], errors: [] };
  if (!chainLoopConfigured()) return report;
  const env = getEnv();

  // 1. lock escrow
  for (const job of jobsNeeding(["paid", "assigned", "running", "pending"])) {
    if (job.lockTx) continue;
    try {
      // x402 payments settle to the treasury account on Hedera; the escrow mirrors them (docs/TRACKS.md 2.4, option B)
      const r = await lockEscrowOnChain(job, { devFund: env.MESH_DEV_SKIP_PAYMENT || job.payment !== null });
      updateJob(job.jobId, { lockTx: r.txHash ?? "already-locked" });
      appendEvent(job.jobId, "chain", { kind: "locked", tx: r.txHash });
      report.locked.push(job.jobId);
    } catch (e) {
      await failChainStep(job, "lock", e, report);
    }
  }

  // 2. post claims
  for (const job of jobsNeeding(["pending"])) {
    if (job.claimTx || !job.lockTx || !job.merkleRoot) continue;
    try {
      const r = await postClaimOnChain(job);
      updateJob(job.jobId, { claimTx: r.txHash ?? "posted", windowEnd: r.windowEnd });
      appendEvent(job.jobId, "claim", { claimTx: r.txHash, merkleRoot: job.merkleRoot, windowEnd: r.windowEnd });
      report.claimsPosted.push(job.jobId);
    } catch (e) {
      await failChainStep(job, "claim", e, report);
    }
  }

  // 3a. fraud the verifier proved on chain: finish the slash and refund (and adopt fraud that was never reported to the API)
  for (const job of jobsNeeding(["pending", "rejected"])) {
    try {
      if (job.status === "pending" ? await adoptOnChainFraud(job.jobId) : await reconcileRejected(job.jobId)) report.refunded.push(job.jobId);
    } catch (e) {
      report.errors.push({ jobId: job.jobId, step: "fraud", message: message(e) });
    }
  }

  // 3. finalize approved jobs whose window has passed
  const due = jobsNeeding(["pending"]).filter((j) => j.claimTx && j.windowEnd && isApproved(j));
  if (due.length > 0) {
    // Use the later of chain time and host time: an idle dev chain (anvil) only advances its clock when it mines a block,
    // while Hedera's clock tracks real time. If we guess early, the contract rejects it with WindowOpen (handled below).
    const now = Math.max(await chainNow(), Math.floor(Date.now() / 1000));
    for (const job of due) {
      if (now <= (job.windowEnd as number)) continue;
      try {
        const tx = await finalizeOnChain(job.jobId);
        transitionJob(job.jobId, "final", { finalTx: tx, releaseTx: tx });
        appendEvent(job.jobId, "settlement", { kind: "released", tx });
        report.finalized.push(job.jobId);
      } catch (e) {
        if (/WindowOpen/.test(message(e))) continue; // the chain says the window is still open: try again next tick, not a failure
        // already finalized by someone else? reconcile from chain state instead of retrying forever
        try {
          if ((await escrowStatus(job.jobId)) === "Released") {
            transitionJob(job.jobId, "final", { finalTx: "finalized-elsewhere" });
            appendEvent(job.jobId, "settlement", { kind: "released", tx: null });
            report.finalized.push(job.jobId);
            continue;
          }
        } catch {
          // fall through to the normal failure path
        }
        await failChainStep(job, "finalize", e, report);
      }
    }
  }
  return report;
}

// ───────────────────────── background loop ─────────────────────────

type Loop = { timer: ReturnType<typeof setTimeout> | null; running: boolean; stopped: boolean };
const g = globalThis as typeof globalThis & { __meshChainLoop?: Loop };

/** Start the loop once per server process (safe against dev hot reloads). Returns false if it is off or unconfigured. */
export function startChainLoop(): boolean {
  const env = getEnv();
  if (!env.MESH_CHAIN_LOOP) return false;
  if (!chainLoopConfigured()) {
    console.warn("[mesh] MESH_CHAIN_LOOP is on but API_PRIVATE_KEY / contract addresses are missing; chain loop not started");
    return false;
  }
  if (g.__meshChainLoop && !g.__meshChainLoop.stopped) return true;

  const loop: Loop = { timer: null, running: false, stopped: false };
  g.__meshChainLoop = loop;
  const every = env.CHAIN_TICK_SECONDS * 1000;
  const run = async () => {
    if (loop.stopped) return;
    if (!loop.running) {
      loop.running = true; // single flight: a slow tick never overlaps the next one
      try {
        const r = await chainTick();
        for (const e of r.errors) console.warn(`[mesh] chain ${e.step} failed for ${e.jobId.slice(0, 10)}: ${e.message}`);
        const rv = await autoReview(); // 0G AI review of newly final jobs (a no-op unless OG_ENABLED)
        for (const e of rv.errors) console.warn(`[mesh] 0G review failed for ${e.jobId.slice(0, 10)}: ${e.message}`);
        const h = await flushHcs(); // mirror new job events to the HCS audit topic (a no-op without HCS_TOPIC_ID)
        if (h.error) console.warn(`[mesh] HCS publish failed: ${h.error}`);
      } catch (e) {
        console.warn("[mesh] chain tick failed:", message(e));
      } finally {
        loop.running = false;
      }
    }
    loop.timer = setTimeout(run, every);
  };
  loop.timer = setTimeout(run, every);
  console.log(`[mesh] chain loop started (every ${env.CHAIN_TICK_SECONDS}s${env.MESH_DEV_AUTO_APPROVE ? ", DEV auto-approve ON" : ""})`);
  return true;
}

export function stopChainLoop(): void {
  const loop = g.__meshChainLoop;
  if (loop) {
    loop.stopped = true;
    if (loop.timer) clearTimeout(loop.timer);
  }
  g.__meshChainLoop = undefined;
}
