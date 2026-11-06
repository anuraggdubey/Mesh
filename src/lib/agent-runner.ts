import { randomUUID } from "node:crypto";
import type { PaymentRequired } from "@x402/core/types";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { Agent, AgentRefusal, makeHederaPayer } from "./agent";
import { CreditError, holdCredit, markSpent, refundHold } from "./credits";
import { getDb, transaction } from "./db";
import { getEnv } from "./env";
import { appendEvent, getJob, updateJob } from "./jobs";
import { consumePlan, PlanError } from "./plans";
import type { PlanView } from "./plans";
import { x402Amount, x402Enabled } from "./x402";

/**
 * The Mesh agent paying for a user's job. A run is a ROW, not a request: POST /api/agent/run creates it, takes the user's prepaid
 * credit (a hold), and the agent works in the background. If the job is above the approval threshold the run waits in
 * `needs_approval` until the human approves in World; the UI polls the run. On any failure the hold is given back.
 */

export const RUN_STALE_SECONDS = 20 * 60;
const FINAL = new Set(["paid", "failed"]);

export class RunError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: "payments_not_configured" | "unsupported_asset" | "run_not_found" | "insufficient_credit",
    message: string,
  ) {
    super(message);
    this.name = "RunError";
  }
}

const now = () => Math.floor(Date.now() / 1000);

interface RunRow {
  run_id: string;
  address: string;
  plan_id: string;
  preset: string;
  amount: number;
  status: "queued" | "needs_approval" | "paying" | "paid" | "failed";
  approval_id: string | null;
  approval_url: string | null;
  user_code: string | null;
  job_id: string | null;
  payment_tx: string | null;
  receipt_id: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}

export interface RunView {
  runId: string;
  planId: string;
  status: RunRow["status"];
  preset: string;
  amountTinybars: number;
  approvalUrl: string | null;
  userCode: string | null;
  jobId: string | null;
  paymentTx: string | null;
  receiptId: string | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

const view = (r: RunRow): RunView => ({
  runId: r.run_id,
  planId: r.plan_id,
  status: r.status,
  preset: r.preset,
  amountTinybars: r.amount,
  approvalUrl: r.status === "needs_approval" ? r.approval_url : null,
  userCode: r.status === "needs_approval" ? r.user_code : null,
  jobId: r.job_id,
  paymentTx: r.payment_tx,
  receiptId: r.receipt_id,
  error: r.error,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const getRow = (id: string) => getDb().prepare("SELECT * FROM runs WHERE run_id = ?").get(id) as RunRow | undefined;

function patch(runId: string, fields: Partial<Pick<RunRow, "status" | "approval_id" | "approval_url" | "user_code" | "job_id" | "payment_tx" | "error">>): void {
  const keys = Object.keys(fields) as (keyof typeof fields)[];
  const sets = [...keys.map((k) => `${k} = ?`), "updated_at = ?"].join(", ");
  getDb()
    .prepare(`UPDATE runs SET ${sets} WHERE run_id = ? AND status NOT IN ('paid', 'failed')`)
    .run(...keys.map((k) => fields[k] ?? null), now(), runId);
}

// ───────────────────────── dependencies ─────────────────────────

export interface RunDeps {
  fetch: typeof fetch;
  /** sign an x402 payment with the AGENT key */
  pay: (required: PaymentRequired) => Promise<string>;
  sleep: (ms: number) => Promise<void>;
  /** where the agent reaches this API */
  apiUrl: string;
}

let payerCache: { key: string; pay: RunDeps["pay"] } | null = null;
let accountCache: { evm: string; id: string } | null = null;

async function agentAccountId(): Promise<string> {
  const env = getEnv();
  if (env.AGENT_HEDERA_ACCOUNT_ID) return env.AGENT_HEDERA_ACCOUNT_ID;
  const evm = privateKeyToAccount(env.AGENT_PRIVATE_KEY as Hex).address.toLowerCase();
  if (accountCache?.evm === evm) return accountCache.id;
  const res = await fetch(`${env.MIRROR_NODE_URL}/api/v1/accounts/${evm}`);
  if (!res.ok) throw new Error(`the agent wallet has no Hedera account yet (mirror node ${res.status})`);
  const id = ((await res.json()) as { account?: string }).account;
  if (!id) throw new Error("mirror node returned no account for the agent wallet");
  accountCache = { evm, id };
  return id;
}

/** The real dependencies: real network, the agent key from the environment. */
export function realRunDeps(): RunDeps {
  const env = getEnv();
  return {
    fetch: (...a) => fetch(...a),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    apiUrl: (env.API_INTERNAL_URL ?? `http://127.0.0.1:${process.env.PORT ?? "3000"}`).replace(/\/$/, ""),
    pay: async (required) => {
      if (!env.AGENT_PRIVATE_KEY) throw new Error("AGENT_PRIVATE_KEY is not set");
      const key = `${env.AGENT_PRIVATE_KEY}|${env.X402_NETWORK}|${env.X402_ASSET}`;
      if (!payerCache || payerCache.key !== key) {
        const accountId = await agentAccountId();
        payerCache = { key, pay: makeHederaPayer({ accountId, privateKey: env.AGENT_PRIVATE_KEY, network: env.X402_NETWORK as `${string}:${string}`, asset: env.X402_ASSET, maxAmount: 2_000_000_000n }) };
      }
      return payerCache.pay(required);
    },
  };
}

let depsOverride: RunDeps | null = null;
/** For tests: make the routes use these dependencies instead of the real network and the agent key. */
export function setRunDeps(d: RunDeps | null): void {
  depsOverride = d;
}

// ───────────────────────── starting a run ─────────────────────────

const background = (globalThis as typeof globalThis & { __meshRuns?: Set<string> });
background.__meshRuns ??= new Set();

/** HBAR amount, in tinybars, that a job of this plan costs. */
export function planAmountTinybars(plan: PlanView): number {
  return Number(x402Amount(plan.price, getEnv().X402_ASSET));
}

/**
 * Start a run for a plan: use the plan (once), hold the credit, create the run row, and let the agent work in the background.
 * Returns the run as it is right now and a promise for tests to await. Everything that can fail does so BEFORE any money moves.
 */
export async function startRun(address: string, planId: string, deps: RunDeps = depsOverride ?? realRunDeps()): Promise<{ run: RunView; done: Promise<void> }> {
  const env = getEnv();
  if (!x402Enabled() && !env.MESH_DEV_SKIP_PAYMENT) throw new RunError(503, "payments_not_configured", "this server is not set up to pay for jobs (X402_ENABLED)");
  if (x402Enabled() && env.X402_ASSET !== "0.0.0") throw new RunError(501, "unsupported_asset", "prepaid credit is in HBAR: set X402_ASSET=0.0.0");
  await expireStaleRuns();

  const runId = randomUUID();
  let amount = 0;
  let receiptId = "";
  let plan: PlanView;
  try {
    ({ plan, amount, receiptId } = transaction(() => {
      const p = consumePlan(planId, address, runId);
      const amt = planAmountTinybars(p);
      const held = holdCredit(address, amt, runId); // throws insufficient_credit: the plan is NOT consumed (the transaction rolls back)
      getDb()
        .prepare("INSERT INTO runs (run_id, address, plan_id, preset, amount, status, receipt_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?)")
        .run(runId, address.toLowerCase(), planId, p.preset, amt, held.receiptId, now(), now());
      return { plan: p, amount: amt, receiptId: held.receiptId };
    }));
  } catch (e) {
    if (e instanceof CreditError && e.code === "insufficient_credit") throw new RunError(402, "insufficient_credit", e.message);
    throw e;
  }
  void receiptId;

  const done = executeRun(runId, plan, amount, deps);
  background.__meshRuns!.add(runId);
  void done.finally(() => background.__meshRuns!.delete(runId));
  // give the agent a moment, so the first answer already says "needs approval" when that is the case
  await Promise.race([done, deps.sleep(1200)]);
  return { run: view(getRow(runId)!), done };
}

function failRun(address: string, amount: number, runId: string, message: string, refund = true): void {
  transaction(() => {
    patch(runId, { status: "failed", error: message.slice(0, 300) });
    if (refund) refundHold(address, amount, runId);
  });
}

/** The agent's work for one run. Never throws: every outcome ends in `paid` or `failed` with the hold settled. */
export async function executeRun(runId: string, plan: PlanView, amount: number, deps: RunDeps): Promise<void> {
  const row = getRow(runId);
  if (!row) return;
  const address = row.address;
  const price = BigInt(plan.price);
  const asset = getEnv().X402_ASSET;

  const agent = new Agent(
    { apiUrl: deps.apiUrl, requester: address, budget: price, perJobCap: price, allowedPresets: [plan.preset], asset, approvalTimeoutMs: 10 * 60_000 },
    {
      fetch: deps.fetch,
      pay: deps.pay,
      sleep: deps.sleep,
      log: (l) => {
        if (l.startsWith("paying")) patch(runId, { status: "paying" });
      },
      onApprovalNeeded: (a) => patch(runId, { status: "needs_approval", approval_url: a.verificationUri, user_code: a.userCode }),
    },
  );

  try {
    const result = await agent.runJob(plan.preset);
    patch(runId, { status: "paid", job_id: result.jobId, payment_tx: result.paymentTx, approval_id: result.approvalId });
    markSpent(address, amount, runId);
    attachPlanToJob(result.jobId, plan);
  } catch (e) {
    const message = e instanceof AgentRefusal ? e.message : e instanceof Error ? e.message : "the agent could not buy the job";
    // the one case where money may have left: the payment settled but the job could not be stored. Do not refund; it needs a person.
    if (/job_creation_failed_after_payment/.test(message)) failRun(address, amount, runId, `The payment settled but the job could not be stored (${message}). Contact the operator with this run id.`, false);
    else failRun(address, amount, runId, message);
  }
}

/** Record how the job was chosen on the job itself (and on its event log, which feeds the audit log). */
function attachPlanToJob(jobId: string, plan: PlanView): void {
  if (!getJob(jobId)) return;
  const jp = {
    planId: plan.planId,
    source: plan.source,
    preset: plan.preset,
    reason: plan.reason,
    requestId: plan.og?.requestId ?? null,
    provider: plan.og?.provider ?? null,
    model: plan.og?.model ?? null,
    teeVerified: plan.og?.teeVerified ?? null,
    verification: plan.og?.verification ?? null,
  };
  updateJob(jobId, { plan: jp });
  // the user's own words stay out of the public audit log: only the choice and the 0G request id go in
  appendEvent(jobId, "plan", { source: jp.source, preset: jp.preset, requestId: jp.requestId, verification: jp.verification, model: jp.model });
}

// ───────────────────────── reading and cleaning up ─────────────────────────

/** Runs that never finished (the server restarted, or the human never answered) are failed and their hold returned. */
export async function expireStaleRuns(): Promise<number> {
  const cutoff = now() - RUN_STALE_SECONDS;
  const stale = getDb().prepare("SELECT * FROM runs WHERE status NOT IN ('paid', 'failed') AND updated_at < ?").all(cutoff) as unknown as RunRow[];
  let n = 0;
  for (const r of stale) {
    if (background.__meshRuns?.has(r.run_id)) continue; // still working in this process
    failRun(r.address, r.amount, r.run_id, "the run did not finish in time; your credit was returned");
    n += 1;
  }
  return n;
}

export async function getRun(runId: string, address: string): Promise<RunView> {
  await expireStaleRuns();
  const r = getRow(runId);
  if (!r || r.address !== address.toLowerCase()) throw new RunError(404, "run_not_found", "run not found");
  return view(r);
}

export function listRuns(address: string, limit = 20): RunView[] {
  return (getDb().prepare("SELECT * FROM runs WHERE address = ? ORDER BY created_at DESC LIMIT ?").all(address.toLowerCase(), limit) as unknown as RunRow[]).map(view);
}

export const isFinalRun = (s: RunView["status"]) => FINAL.has(s);
export { PlanError };
