import { createHmac, timingSafeEqual } from "node:crypto";
import { getLedgerByReceipt, listLedger, tinybarsToHbar } from "./credits";
import type { LedgerRow } from "./credits";
import { getDb } from "./db";
import { getEnv } from "./env";
import { getJob } from "./jobs";
import { secretKey } from "./session";
import { hashscan } from "./ui/format";

/**
 * Receipts for the money events of a wallet: a deposit (credit added), a job payment (the agent paid for a job on your behalf) and a
 * refund (a hold returned). Each ledger entry has a stable receipt id (`rcpt_...`). A receipt is built from the ledger plus what we
 * know about the run, the job and the plan, and links every transaction to HashScan.
 *
 * WHO CAN READ ONE: the wallet that owns it (signed in), or anyone holding the exact share link, which carries a token made from the
 * receipt id and the server secret. The token reveals only that one receipt. Without either, a receipt is not readable.
 */

export type ReceiptType = "deposit" | "job_payment" | "refund";

export interface ReceiptLink {
  label: string;
  hash: string; // a 0x hash or a Hedera transaction id
  url: string;
}

export interface Receipt {
  receiptId: string;
  type: ReceiptType;
  title: string;
  description: string;
  status: string;
  statusTone: "ok" | "pending" | "bad";
  wallet: string;
  issuedAt: number; // unix seconds
  issuedAtIso: string; // UTC
  amountTinybars: number;
  amountHbar: string;
  direction: "credit" | "debit";
  transactions: ReceiptLink[];
  job: { jobId: string; status: string; page: string; api: string } | null;
  plan: {
    source: "og" | "manual";
    preset: string;
    reason: string | null;
    request: string | null;
    og: { requestId: string; provider: string | null; model: string | null; teeVerified: boolean | null; verification: "tee-signature" | "router-checked" | "unverified" } | null;
  } | null;
  hcs: { topicId: string; sequences: number[]; url: string } | null;
  relatedReceiptId: string | null; // a refund points at the payment it returns
  page: string;
  testnet: true;
}

export interface ReceiptSummary {
  receiptId: string;
  type: ReceiptType;
  title: string;
  amountHbar: string;
  direction: "credit" | "debit";
  issuedAt: number;
  status: string;
  statusTone: Receipt["statusTone"];
  page: string;
}

const TYPE: Record<string, ReceiptType> = { deposit: "deposit", job_hold: "job_payment", job_refund: "refund" };
const isTx = (v: string | null | undefined): v is string => !!v && /^0x[0-9a-fA-F]{64}$/.test(v);

interface RunRow {
  run_id: string;
  plan_id: string;
  preset: string;
  status: "queued" | "needs_approval" | "paying" | "paid" | "failed";
  job_id: string | null;
  payment_tx: string | null;
  receipt_id: string | null;
  error: string | null;
}
interface PlanRow {
  source: "og" | "manual";
  prompt: string | null;
  preset: string;
  reason: string | null;
  og_request_id: string | null;
  og_provider: string | null;
  og_model: string | null;
  tee_verified: number | null;
  verification: "tee-signature" | "router-checked" | "unverified" | null;
}

const runOf = (id: string) => getDb().prepare("SELECT * FROM runs WHERE run_id = ?").get(id) as RunRow | undefined;
const planOf = (id: string) => getDb().prepare("SELECT * FROM plans WHERE plan_id = ?").get(id) as PlanRow | undefined;

function runStatus(run: RunRow | undefined): { status: string; tone: Receipt["statusTone"] } {
  if (!run) return { status: "recorded", tone: "ok" };
  if (run.status === "paid") return { status: "paid", tone: "ok" };
  if (run.status === "failed") return { status: "failed, credit returned", tone: "bad" };
  return { status: run.status === "needs_approval" ? "waiting for your approval" : "in progress", tone: "pending" };
}

const TITLES: Record<ReceiptType, string> = { deposit: "Credit added", job_payment: "Job payment", refund: "Credit returned" };

export function toSummary(row: LedgerRow): ReceiptSummary {
  const type = TYPE[row.kind];
  let status = "confirmed";
  let tone: Receipt["statusTone"] = "ok";
  if (type === "job_payment") ({ status, tone } = runStatus(runOf(row.ref)));
  if (type === "refund") status = "returned to your credit";
  return { receiptId: row.receipt_id, type, title: TITLES[type], amountHbar: tinybarsToHbar(row.amount), direction: type === "job_payment" ? "debit" : "credit", issuedAt: row.ts, status, statusTone: tone, page: `/receipts/${row.receipt_id}` };
}

/** The signed-in wallet's receipts, newest first. */
export function listReceipts(address: string, limit = 50): ReceiptSummary[] {
  return listLedger(address, limit).map(toSummary);
}

/** Build the full receipt for a ledger entry. No access check here: see canRead. */
export function buildReceipt(receiptId: string): Receipt | null {
  const row = getLedgerByReceipt(receiptId);
  if (!row || !TYPE[row.kind]) return null; // the internal "spent" marker is not a receipt
  const type = TYPE[row.kind];
  const env = getEnv();
  const base = toSummary(row);

  const r: Receipt = {
    receiptId: row.receipt_id,
    type,
    title: base.title,
    description: "",
    status: base.status,
    statusTone: base.statusTone,
    wallet: row.address,
    issuedAt: row.ts,
    issuedAtIso: new Date(row.ts * 1000).toISOString(),
    amountTinybars: row.amount,
    amountHbar: base.amountHbar,
    direction: base.direction,
    transactions: [],
    job: null,
    plan: null,
    hcs: null,
    relatedReceiptId: null,
    page: base.page,
    testnet: true,
  };

  if (type === "deposit") {
    r.description = `You sent ${r.amountHbar} HBAR from your wallet to the Mesh agent wallet. The agent spends this credit on the jobs you ask for.`;
    r.transactions.push({ label: "Deposit transaction", hash: row.ref, url: hashscan.tx(row.ref) });
    return r;
  }

  const run = runOf(row.ref);
  if (type === "refund") {
    r.description = `The ${r.amountHbar} HBAR held for a job that did not complete was returned to your credit.${run?.error ? ` Reason: ${run.error}` : ""}`;
    r.relatedReceiptId = run?.receipt_id ?? null;
    if (run?.job_id) r.job = jobRef(run.job_id);
    return r;
  }

  // job payment
  const job = run?.job_id ? getJob(run.job_id) : null;
  const plan = run ? planOf(run.plan_id) : undefined;
  r.description = `The Mesh agent paid ${r.amountHbar} HBAR on your behalf for a ${run?.preset ?? "render"} render, from your prepaid credit.`;
  if (run?.payment_tx) r.transactions.push({ label: "x402 payment (agent to treasury)", hash: run.payment_tx, url: hashscan.hederaTx(run.payment_tx) });
  if (job) {
    const t = (label: string, h: string | null | undefined) => isTx(h) && r.transactions.push({ label, hash: h, url: hashscan.tx(h) });
    t("Escrow lock", job.lockTx);
    t("Claim posted", job.claimTx);
    t("Finalized, providers paid", job.finalTx);
    t("Fraud proof", job.fraudTx);
    t("Provider slashed", job.slashTx);
    t("Refund to requester", job.refundTx);
    r.job = jobRef(job.jobId, job.status);
    if (job.status === "final") r.description += " The result was spot-checked and the providers were paid.";
    else if (job.status === "refunded" || job.status === "slashed" || job.verdict === "fraud") r.description += " A provider cheated: the verifier proved it, the stake was slashed and the payment refunded.";
    if (env.HCS_TOPIC_ID && job.hcsSequence.length > 0) r.hcs = { topicId: env.HCS_TOPIC_ID, sequences: job.hcsSequence, url: hashscan.topic(env.HCS_TOPIC_ID) };
  } else if (run?.job_id) {
    r.job = jobRef(run.job_id);
  }
  if (plan) {
    r.plan = {
      source: plan.source,
      preset: plan.preset,
      reason: plan.reason,
      request: plan.prompt ? plan.prompt.slice(0, 200) : null,
      og: plan.og_request_id ? { requestId: plan.og_request_id, provider: plan.og_provider, model: plan.og_model, teeVerified: plan.tee_verified === null ? null : plan.tee_verified === 1, verification: plan.verification ?? "unverified" } : null,
    };
  }
  return r;
}

function jobRef(jobId: string, status = "unknown"): NonNullable<Receipt["job"]> {
  return { jobId, status, page: `/jobs/${jobId}`, api: `/api/receipts/${jobId}` };
}

// ───────────────────────── access ─────────────────────────

export function shareToken(receiptId: string): string {
  return createHmac("sha256", Buffer.from(secretKey())).update(`receipt:${receiptId}`).digest("hex").slice(0, 24);
}

function validShare(receiptId: string, token: string | null): boolean {
  if (!token) return false;
  const want = Buffer.from(shareToken(receiptId));
  const got = Buffer.from(token);
  return want.length === got.length && timingSafeEqual(want, got);
}

/** Owner (signed in as the receipt's wallet) or holder of the exact share token. */
export function canRead(receipt: Receipt, sessionAddress: string | null, share: string | null): boolean {
  if (sessionAddress && sessionAddress.toLowerCase() === receipt.wallet.toLowerCase()) return true;
  return validShare(receipt.receiptId, share);
}
