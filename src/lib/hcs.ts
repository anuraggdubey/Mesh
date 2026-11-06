import { createHash } from "node:crypto";
import { Client, PrivateKey, TopicId, TopicMessageSubmitTransaction } from "@hiero-ledger/sdk";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { getDb, transaction } from "./db";
import { getEnv } from "./env";
import { getJob, updateJob } from "./jobs";

/**
 * HCS audit log (docs/job-spec.md section 12). Every job event that matters is mirrored, in order, to one Hedera Consensus
 * Service topic, and the sequence number is stored on the job. The log is built FROM the `job_events` table, so no call site has
 * to remember to publish, and a failed submission is retried on the next flush instead of being lost.
 */

export type AuditType = "PAID" | "ASSIGNED" | "CLAIM" | "SAMPLE" | "VERDICT" | "SLASH" | "RELEASE" | "REFUND" | "APPROVAL" | "INFERENCE";

export interface AuditMessage {
  v: 1;
  t: AuditType;
  jobId: string;
  ts: number;
  data: Record<string, unknown>;
}

export const MAX_MESSAGE_BYTES = 1000;

export interface EventRow {
  id: number;
  jobId: string;
  type: string;
  data: Record<string, unknown>;
  ts: number;
}

/** Map one job event to an audit message, or null when the event is not part of the public log (tiles, progress, status noise). */
export function toAudit(e: EventRow, extra: { signatures?: { provider: string; signature: string }[] } = {}): AuditMessage | null {
  const d = e.data;
  const msg = (t: AuditType, data: Record<string, unknown>): AuditMessage => ({ v: 1, t, jobId: e.jobId, ts: e.ts, data });
  switch (e.type) {
    case "payment":
      return msg("PAID", d);
    case "assigned":
      return msg("ASSIGNED", d);
    case "claim":
      return msg("CLAIM", { ...d, ...(extra.signatures?.length ? { signatures: extra.signatures } : {}) });
    case "sample":
      return msg("SAMPLE", d);
    case "verdict":
      return msg("VERDICT", d);
    case "approval":
      return msg("APPROVAL", d);
    case "inference":
      // the 0G request id and how it was verified; the description stays off the public log
      return msg("INFERENCE", { requestId: d.requestId, provider: d.provider, model: d.model, verification: d.verification, teeVerified: d.teeVerified, signer: d.signer, digest: d.digest, quality: d.quality });
    case "settlement":
      switch (d.kind) {
        case "released":
          return msg("RELEASE", d);
        case "slashed":
          return msg("SLASH", d);
        case "refunded":
          return msg("REFUND", d);
      }
      return null;
    default:
      return null;
  }
}

/** HCS messages are small. If one is too big, keep the type and a digest of the full data so it stays verifiable. */
export function encode(m: AuditMessage): string {
  let s = JSON.stringify(m);
  if (Buffer.byteLength(s) <= MAX_MESSAGE_BYTES) return s;
  const digest = createHash("sha256").update(JSON.stringify(m.data)).digest("hex");
  s = JSON.stringify({ ...m, data: { truncated: true, sha256: digest } });
  return s;
}

export function hcsConfigured(): boolean {
  const env = getEnv();
  return Boolean(env.HCS_TOPIC_ID && env.API_PRIVATE_KEY);
}

export type Submit = (message: string) => Promise<number>;

// ───────────────────────── real submitter ─────────────────────────

let clientCache: { key: string; client: Client } | null = null;
let accountCache: { evm: string; id: string } | null = null;

export function resetHcs(): void {
  clientCache?.client.close();
  clientCache = null;
  accountCache = null;
}

/** The API wallet's Hedera account id (an ECDSA key's EVM address resolves through the mirror node). */
export async function apiAccountId(fetchImpl: typeof fetch = fetch): Promise<string> {
  const env = getEnv();
  const evm = privateKeyToAccount(env.API_PRIVATE_KEY as Hex).address.toLowerCase();
  if (accountCache?.evm === evm) return accountCache.id;
  const res = await fetchImpl(`${env.MIRROR_NODE_URL}/api/v1/accounts/${evm}`);
  if (!res.ok) throw new Error(`the API wallet has no Hedera account yet (mirror node ${res.status}); fund it first`);
  const id = ((await res.json()) as { account?: string }).account;
  if (!id) throw new Error("mirror node returned no account for the API wallet");
  accountCache = { evm, id };
  return id;
}

export async function hederaClient(): Promise<Client> {
  const env = getEnv();
  const key = `${env.HEDERA_CHAIN_ID}|${env.API_PRIVATE_KEY}`;
  if (clientCache?.key === key) return clientCache.client;
  clientCache?.client.close();
  const client = env.HEDERA_CHAIN_ID === 295 ? Client.forMainnet() : Client.forTestnet();
  client.setOperator(await apiAccountId(), PrivateKey.fromStringECDSA((env.API_PRIVATE_KEY as string).replace(/^0x/, "")));
  clientCache = { key, client };
  return client;
}

export const realSubmit: Submit = async (message) => {
  const env = getEnv();
  const client = await hederaClient();
  const resp = await new TopicMessageSubmitTransaction().setTopicId(TopicId.fromString(env.HCS_TOPIC_ID as string)).setMessage(message).execute(client);
  const receipt = await resp.getReceipt(client);
  if (receipt.topicSequenceNumber === null) throw new Error("the receipt carried no topic sequence number");
  return receipt.topicSequenceNumber.toNumber();
};

// ───────────────────────── flush ─────────────────────────

interface Pending {
  id: number;
  job_id: string;
  type: string;
  data: string;
  ts: number;
}

const flushing = { on: false };

export interface FlushReport {
  published: { eventId: number; sequence: number; type: AuditType }[];
  skipped: number;
  error: string | null;
}

/**
 * Publish unpublished events in order, up to `limit`. Events that are not part of the log are marked skipped (0). A failed
 * submission stops the flush so order is kept, and the event is retried next time. Single flight.
 */
export async function flushHcs(opts: { submit?: Submit; limit?: number } = {}): Promise<FlushReport> {
  const report: FlushReport = { published: [], skipped: 0, error: null };
  if (flushing.on) return report;
  const submit = opts.submit ?? (hcsConfigured() ? realSubmit : null);
  if (!submit) return report;
  flushing.on = true;
  try {
    const db = getDb();
    const rows = db.prepare("SELECT id, job_id, type, data, ts FROM job_events WHERE hcs_seq IS NULL ORDER BY id LIMIT ?").all(opts.limit ?? 100) as unknown as Pending[];
    for (const r of rows) {
      const ev: EventRow = { id: r.id, jobId: r.job_id, type: r.type, data: JSON.parse(r.data) as Record<string, unknown>, ts: r.ts };
      const signatures = ev.type === "claim" && ev.data.claimTx == null ? claimSignatures(ev.jobId) : undefined;
      const audit = toAudit(ev, { signatures });
      if (!audit) {
        db.prepare("UPDATE job_events SET hcs_seq = 0 WHERE id = ?").run(r.id);
        report.skipped += 1;
        continue;
      }
      let sequence: number;
      try {
        sequence = await submit(encode(audit));
      } catch (e) {
        report.error = e instanceof Error ? e.message.split("\n")[0].slice(0, 200) : "submit failed";
        break;
      }
      transaction((tdb) => {
        tdb.prepare("UPDATE job_events SET hcs_seq = ? WHERE id = ?").run(sequence, r.id);
        const job = getJob(r.job_id);
        if (job) updateJob(r.job_id, { hcsSequence: [...job.hcsSequence, sequence] });
      });
      report.published.push({ eventId: r.id, sequence, type: audit.t });
    }
  } finally {
    flushing.on = false;
  }
  return report;
}

function claimSignatures(jobId: string): { provider: string; signature: string }[] {
  const rows = getDb().prepare("SELECT provider, signature FROM claims WHERE job_id = ? ORDER BY created_at, rowid").all(jobId) as unknown as { provider: string; signature: string }[];
  return rows.map((r) => ({ provider: r.provider, signature: r.signature }));
}

export function hashscanTopicUrl(topicId: string, chainId = getEnv().HEDERA_CHAIN_ID): string {
  return `https://hashscan.io/${chainId === 295 ? "mainnet" : "testnet"}/topic/${topicId}`;
}
