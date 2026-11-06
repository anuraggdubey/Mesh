import { connection } from "next/server";
import { json, jsonError, readJson } from "@/lib/api";
import { MAX_INPUT_BYTES } from "@/lib/constants";
import { getEnv } from "@/lib/env";
import { appendEvent, buildJob, getJob, insertJob, listJobs, transitionJob, updateJob, UnsupportedJobTypeError } from "@/lib/jobs";
import { assignPending } from "@/lib/assign";
import { ApprovalError, approvalRequired, checkApproval, consumeApproval, priceFor } from "@/lib/approvals";
import type { ApprovalParams } from "@/lib/approvals";
import {
  attachPaymentToJob,
  buildQuote,
  decodePayment,
  HEADER_REQUIRED,
  HEADER_RESPONSE,
  HEADER_SIGNATURE,
  paymentRequired,
  paymentResponseHeader,
  reservePayment,
  settlePayment,
  verifyPayment,
  x402Enabled,
  X402Error,
} from "@/lib/x402";
import type { Quote } from "@/lib/x402";
import { createJobBodySchema } from "@/lib/types";
import type { CreateJobBody } from "@/lib/types";

/** GET /api/jobs: most recent jobs (newest first). */
export async function GET() {
  await connection();
  return json({ jobs: listJobs(50) });
}

const approvalParams = (d: CreateJobBody): ApprovalParams => ({
  purpose: "create-job",
  requester: d.requester,
  type: "render",
  preset: d.preset,
  price: priceFor(d.preset),
});

/**
 * Spending control: a job above AGENT_APPROVAL_THRESHOLD needs a fresh human approval (World Agent Pass) for THIS exact job.
 * `peek` only checks it (used before the 402 challenge); `consume` spends it. Returns an error Response, or null if allowed.
 * If the approval is missing, pending, denied, expired, spent or for something else, the job is never created.
 */
function approvalGate(req: Request, d: CreateJobBody, mode: "peek" | "consume"): { error: Response } | { approvalId: string | null } {
  if (d.type !== "render" || !approvalRequired(priceFor(d.preset))) return { approvalId: null };
  const approvalId = req.headers.get("x-mesh-approval");
  if (!approvalId) {
    return { error: jsonError(403, "approval_required", "this job needs a human approval: POST /api/approvals, have the human approve, then send X-Mesh-Approval", { reason: "above_threshold" }) };
  }
  try {
    if (mode === "peek") checkApproval(approvalId, approvalParams(d));
    else consumeApproval(approvalId, approvalParams(d));
  } catch (e) {
    if (e instanceof ApprovalError) return { error: jsonError(403, "approval_denied", e.message, { reason: e.code }) };
    throw e;
  }
  return { approvalId };
}

/**
 * POST /api/jobs: create a job. Three modes:
 *  1. MESH_DEV_SKIP_PAYMENT=true (DEV ONLY): the job is `paid` immediately.
 *  2. X402_ENABLED=true: a real x402 endpoint on Hedera. No payment gives a 402 with `PAYMENT-REQUIRED`; a paid retry with
 *     `PAYMENT-SIGNATURE` is verified, settled by the facilitator, and only then is the job created.
 *  3. Otherwise: a plain 402 stub that never creates anything.
 */
export async function POST(req: Request) {
  await connection();
  const read = await readJson(req, MAX_INPUT_BYTES);
  if ("error" in read) return read.error;

  const parsed = createJobBodySchema.safeParse(read.value);
  if (!parsed.success) {
    return json({ error: "invalid_body", issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) }, 400);
  }
  const env = getEnv();
  const data = parsed.data;

  if (env.MESH_DEV_SKIP_PAYMENT) return devPaidFlow(req, data);
  if (x402Enabled()) return x402Flow(req, data);

  // not configured for payment: refuse clearly rather than pretend
  if (req.headers.get(HEADER_SIGNATURE) || req.headers.get("x-payment")) return jsonError(501, "x402_not_enabled", "this server is not configured to accept x402 payments (X402_ENABLED=true)");
  return jsonError(503, "payment_not_configured", "payments are not enabled on this server");
}

async function devPaidFlow(req: Request, data: CreateJobBody): Promise<Response> {
  const gate = approvalGate(req, data, "consume");
  if ("error" in gate) return gate.error;
  let job;
  try {
    job = insertJob(buildJob(data));
    if (gate.approvalId) {
      appendEvent(job.jobId, "approval", { approvalId: gate.approvalId });
      updateJob(job.jobId, { approvalId: gate.approvalId });
    }
  } catch (err) {
    if (err instanceof UnsupportedJobTypeError) return jsonError(501, "unsupported_job_type", err.message);
    throw err;
  }
  const paid = transitionJob(job.jobId, "paid");
  await assignPending(); // hand it to any eligible provider that is already online
  return json(getJob(job.jobId) ?? paid, 200, { "X-Mesh-Dev-Payment-Skipped": "true" });
}

async function challenge(quote: Quote, data: CreateJobBody, error?: string, status = 402): Promise<Response> {
  const env = getEnv();
  const pr = await paymentRequired(quote, { url: `${env.API_PUBLIC_URL}/api/jobs`, description: `Mesh render job (${data.preset})` }, error);
  return json(pr.body, status, { [HEADER_REQUIRED]: pr.header });
}

async function x402Flow(req: Request, data: CreateJobBody): Promise<Response> {
  if (data.type !== "render") return jsonError(501, "unsupported_job_type", `job type "${data.type}" is not available yet`);

  // 1. a job above the threshold must already be approved by a human (checked, not spent, before we ask for money)
  const peek = approvalGate(req, data, "peek");
  if ("error" in peek) return peek.error;

  let quote: Quote;
  try {
    quote = await buildQuote(priceFor(data.preset));
  } catch (e) {
    if (e instanceof X402Error) return jsonError(e.status, e.code, e.message);
    throw e;
  }

  // 2. no payment yet: quote the price
  const header = req.headers.get(HEADER_SIGNATURE);
  if (!header) return challenge(quote, data);

  try {
    // 3. the payment must match what we quoted and be acceptable to the facilitator (no side effects yet)
    const payload = decodePayment(header);
    const { requirements, payer } = await verifyPayment(payload, quote);

    // 4. spend the approval, reserve the payment (replay protection), then settle on Hedera
    const gate = approvalGate(req, data, "consume");
    if ("error" in gate) return gate.error;
    const key = reservePayment(payload);
    const settle = await settlePayment(payload, requirements);

    // 5. only now is the job created
    let job;
    try {
      job = insertJob(buildJob(data));
      attachPaymentToJob(key, job.jobId);
      updateJob(job.jobId, { payment: { network: settle.network, asset: quote.asset, amount: quote.amount, payer: settle.payer ?? payer, transaction: settle.transaction } });
      appendEvent(job.jobId, "payment", { transaction: settle.transaction, network: settle.network, asset: quote.asset, amount: quote.amount, payer: settle.payer ?? payer });
      if (gate.approvalId) {
        appendEvent(job.jobId, "approval", { approvalId: gate.approvalId });
        updateJob(job.jobId, { approvalId: gate.approvalId });
      }
      transitionJob(job.jobId, "paid");
    } catch (err) {
      // the payment settled but the job could not be stored: report the transaction so it can be refunded by hand
      return json({ error: "job_creation_failed_after_payment", message: err instanceof Error ? err.message : "error", transaction: settle.transaction }, 500, { [HEADER_RESPONSE]: paymentResponseHeader(settle) });
    }
    await assignPending();
    return json(getJob(job.jobId), 200, { [HEADER_RESPONSE]: paymentResponseHeader(settle) });
  } catch (e) {
    if (e instanceof X402Error) {
      // a payment the client can fix gets a fresh quote; everything else is a plain error
      if (e.status === 402) return challenge(quote, data, e.message);
      return jsonError(e.status, e.code, e.message);
    }
    throw e;
  }
}
