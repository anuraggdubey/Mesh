import { x402Client } from "@x402/core/client";
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentRequired } from "@x402/core/types";
import { createClientHederaSigner } from "@x402/hedera";
import { ExactHederaScheme } from "@x402/hedera/exact/client";
import { PrivateKey } from "@hiero-ledger/sdk";
import { RENDER_PRESET_NAMES, RENDER_PRICE } from "./constants";
import type { RenderPreset } from "./constants";

/**
 * The scripted agent: an autonomous requester that pays for compute over x402 with no human click. It runs under spending
 * controls the user sets: a total budget, a per-job cap, a preset allowlist and a payee allowlist. Anything above the server's
 * threshold also needs a fresh human approval (World Agent Pass). The agent refuses locally before it asks the server.
 */

export type AgentRefusalCode = "preset_not_allowed" | "over_job_cap" | "over_budget" | "payee_not_allowed" | "price_changed" | "approval_denied" | "approval_timeout" | "payment_rejected" | "server_error";

export class AgentRefusal extends Error {
  constructor(
    public readonly code: AgentRefusalCode,
    message: string,
  ) {
    super(message);
    this.name = "AgentRefusal";
  }
}

export interface AgentConfig {
  apiUrl: string;
  requester: string;
  /** total the agent may spend in this run, in job price units (0.1 test token = 100000) */
  budget: bigint;
  /** the most one job may cost, in job price units */
  perJobCap: bigint;
  allowedPresets: readonly RenderPreset[];
  /** if set, the agent only pays these Hedera accounts */
  allowedPayTo?: readonly string[];
  /** the asset the agent is willing to pay in (`0.0.0` = HBAR, or an HTS token id) */
  asset: string;
  approvalTimeoutMs: number;
}

export interface AgentDeps {
  fetch: typeof fetch;
  /** sign a payment for a 402 and return the `PAYMENT-SIGNATURE` header value */
  pay: (required: PaymentRequired) => Promise<string>;
  /** tell the human how to approve (user code and URL) */
  onApprovalNeeded: (a: { userCode: string; verificationUri: string; expiresAt: number }) => void;
  log: (line: string) => void;
  sleep: (ms: number) => Promise<void>;
}

export interface AgentResult {
  jobId: string;
  preset: RenderPreset;
  /** Hedera transaction id of the settled payment, and its HashScan link when known */
  paymentTx: string | null;
  spent: bigint;
  approvalId: string | null;
}

const HBAR = "0.0.0";

/** The amount a quoted payment should be, in the asset's smallest unit (mirrors the server's x402Amount). */
export function expectedAmount(price: string, asset: string): bigint {
  return asset === HBAR ? BigInt(price) * 100n : BigInt(price);
}

/** Total of a settled payment, back in job price units. */
function toPriceUnits(amount: bigint, asset: string): bigint {
  return asset === HBAR ? amount / 100n : amount;
}

export class Agent {
  private spent = 0n;

  constructor(
    readonly config: AgentConfig,
    private readonly deps: AgentDeps,
  ) {}

  get remaining(): bigint {
    return this.config.budget - this.spent;
  }

  get totalSpent(): bigint {
    return this.spent;
  }

  /** Local checks that need no network: refuse before the server is ever asked. */
  precheck(preset: RenderPreset): string {
    const c = this.config;
    if (!c.allowedPresets.includes(preset)) throw new AgentRefusal("preset_not_allowed", `the preset "${preset}" is not on this agent's allowlist (${c.allowedPresets.join(", ")})`);
    const price = RENDER_PRICE[preset];
    if (BigInt(price) > c.perJobCap) throw new AgentRefusal("over_job_cap", `"${preset}" costs ${price}, above the per-job cap of ${c.perJobCap}`);
    if (BigInt(price) > this.remaining) throw new AgentRefusal("over_budget", `"${preset}" costs ${price} but only ${this.remaining} of the budget is left`);
    return price;
  }

  private post(headers: Record<string, string>, body: unknown): Promise<Response> {
    return this.deps.fetch(`${this.config.apiUrl}/api/jobs`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  }

  private async approve(preset: RenderPreset): Promise<string> {
    const { apiUrl, requester, approvalTimeoutMs } = this.config;
    const res = await this.deps.fetch(`${apiUrl}/api/approvals`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "render", preset, requester }) });
    if (!res.ok) throw new AgentRefusal("server_error", `could not start a human approval (${res.status}: ${await errorText(res)})`);
    const a = (await res.json()) as { approvalId: string; userCode: string; verificationUri: string; expiresAt: number; interval: number };
    this.deps.onApprovalNeeded({ userCode: a.userCode, verificationUri: a.verificationUri, expiresAt: a.expiresAt });

    let waited = 0;
    let interval = Math.max(1, a.interval) * 1000;
    while (waited <= approvalTimeoutMs) {
      await this.deps.sleep(interval);
      waited += interval;
      const poll = await this.deps.fetch(`${apiUrl}/api/approvals/${a.approvalId}`);
      if (!poll.ok) throw new AgentRefusal("server_error", `approval check failed (${poll.status})`);
      const v = (await poll.json()) as { status: string; reason: string | null; interval: number };
      if (v.status === "approved") return a.approvalId;
      if (v.status === "denied" || v.status === "expired" || v.status === "used") throw new AgentRefusal("approval_denied", `the human did not approve (${v.status}${v.reason ? `: ${v.reason}` : ""})`);
      interval = Math.max(1, v.interval) * 1000;
    }
    throw new AgentRefusal("approval_timeout", "no human approval arrived in time");
  }

  /** Create one render job and pay for it. Throws AgentRefusal when a control stops it. */
  async runJob(preset: RenderPreset): Promise<AgentResult> {
    const price = this.precheck(preset);
    const body = { type: "render", preset, requester: this.config.requester };
    const headers: Record<string, string> = {};
    let approvalId: string | null = null;

    let res = await this.post(headers, body);

    // above the server's threshold: a human must approve this exact job first
    if (res.status === 403 && (await peekError(res)) === "approval_required") {
      this.deps.log(`"${preset}" is above the approval threshold: asking a human`);
      approvalId = await this.approve(preset);
      headers["x-mesh-approval"] = approvalId;
      res = await this.post(headers, body);
    }

    if (res.status === 402) {
      const required = await readPaymentRequired(res);
      const paid = this.check(required, price);
      this.deps.log(`paying ${paid.amount} of ${paid.asset} to ${paid.payTo}`);
      headers["payment-signature"] = await this.deps.pay(required);
      res = await this.post(headers, body);
      if (res.status === 402) throw new AgentRefusal("payment_rejected", `the server rejected the payment: ${await errorText(res)}`);
    }

    if (res.status === 403) throw new AgentRefusal("approval_denied", await errorText(res));
    if (!res.ok) throw new AgentRefusal("server_error", `POST /api/jobs failed (${res.status}): ${await errorText(res)}`);

    const job = (await res.json()) as { jobId: string; payment?: { transaction: string; amount: string; asset: string } | null };
    const settled = job.payment ?? null;
    this.spent += settled ? toPriceUnits(BigInt(settled.amount), settled.asset) : BigInt(price);
    return { jobId: job.jobId, preset, paymentTx: settled?.transaction ?? null, spent: this.spent, approvalId };
  }

  /** The agent signs nothing the policy has not accepted: payee, asset, network and amount are all checked. */
  private check(required: PaymentRequired, price: string): { amount: string; asset: string; payTo: string } {
    const c = this.config;
    const want = expectedAmount(price, c.asset);
    const accept = required.accepts.find((a) => a.asset === c.asset && a.scheme === "exact");
    if (!accept) throw new AgentRefusal("payment_rejected", `the server asks for a payment in an asset this agent does not use (wants ${required.accepts.map((a) => a.asset).join(", ")}; agent pays in ${c.asset})`);
    if (c.allowedPayTo && !c.allowedPayTo.includes(accept.payTo)) throw new AgentRefusal("payee_not_allowed", `the server asks to be paid at ${accept.payTo}, which is not on this agent's payee allowlist`);
    if (BigInt(accept.amount) > want) throw new AgentRefusal("price_changed", `the server asks for ${accept.amount}, more than the ${want} this job should cost`);
    // never sign for more than the per-job cap, even if the price table changed
    if (toPriceUnits(BigInt(accept.amount), accept.asset) > c.perJobCap) throw new AgentRefusal("over_job_cap", "the quoted amount is above the per-job cap");
    return { amount: accept.amount, asset: accept.asset, payTo: accept.payTo };
  }
}

async function readPaymentRequired(res: Response): Promise<PaymentRequired> {
  const header = res.headers.get("payment-required");
  if (header) return decodePaymentRequiredHeader(header);
  return (await res.json()) as PaymentRequired;
}

async function peekError(res: Response): Promise<string | null> {
  try {
    return ((await res.clone().json()) as { error?: string }).error ?? null;
  } catch {
    return null;
  }
}

async function errorText(res: Response): Promise<string> {
  try {
    const b = (await res.clone().json()) as { error?: string; message?: string };
    return [b.error, b.message].filter(Boolean).join(": ") || `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

/**
 * A payer backed by the real x402 client. The client's own spend controls stay on, and are widened only to the one asset and
 * the per-payment cap this agent is configured for (they reject HBAR by default).
 */
export function makeHederaPayer(opts: { accountId: string; privateKey: string; network: `${string}:${string}`; asset: string; maxAmount: bigint }): AgentDeps["pay"] {
  const key = PrivateKey.fromStringECDSA(opts.privateKey.replace(/^0x/, ""));
  const signer = createClientHederaSigner(opts.accountId, key, { network: opts.network });
  const client = x402Client.fromConfig({
    schemes: [{ network: opts.network, client: new ExactHederaScheme(signer) }],
    // the client already allows the well-known testnet USDC by default; this agent pays in exactly one asset
    policies: [(_version, requirements) => requirements.filter((r) => r.asset === opts.asset)],
    spendControls: { allowedAssets: [{ network: opts.network, asset: opts.asset, maxAmountPerPayment: opts.maxAmount.toString() }] },
  });
  return async (required) => encodePaymentSignatureHeader(await client.createPaymentPayload(required));
}

export function parsePresetList(value: string | undefined): RenderPreset[] {
  const names = (value ?? "tiny,small").split(",").map((s) => s.trim()).filter(Boolean);
  const bad = names.filter((n) => !(RENDER_PRESET_NAMES as readonly string[]).includes(n));
  if (bad.length) throw new Error(`unknown preset(s): ${bad.join(", ")}`);
  return names as RenderPreset[];
}
