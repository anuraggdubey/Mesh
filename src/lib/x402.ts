import { createHash } from "node:crypto";
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader } from "@x402/core/http";
import type { PaymentPayload, PaymentRequired, PaymentRequirements, SettleResponse } from "@x402/core/types";
import { ExactHederaScheme } from "@x402/hedera/exact/server";
import { privateKeyToAccount } from "viem/accounts";
import { getDb } from "./db";
import { getEnv } from "./env";
import type { Hex } from "viem";

/**
 * x402 on Hedera for `POST /api/jobs` (docs/TRACKS.md section 2). The server quotes a price in a 402, a client pays inside an
 * ordinary request, and a facilitator verifies and settles the payment on Hedera (the facilitator pays the network fee).
 *
 * Wire format (x402 v2): `PAYMENT-REQUIRED` on the 402, `PAYMENT-SIGNATURE` on the paid retry, `PAYMENT-RESPONSE` on success.
 * Replay protection is OURS: the exact scheme has no per-request nonce, so a signed payment is accepted at most once.
 */

export const HEADER_REQUIRED = "PAYMENT-REQUIRED";
export const HEADER_SIGNATURE = "PAYMENT-SIGNATURE";
export const HEADER_RESPONSE = "PAYMENT-RESPONSE";

export class X402Error extends Error {
  constructor(
    public readonly code:
      | "not_configured"
      | "facilitator_unavailable"
      | "invalid_payment"
      | "payment_mismatch"
      | "payment_invalid"
      | "payment_replayed"
      | "settle_failed",
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "X402Error";
  }
}

export function x402Enabled(): boolean {
  return getEnv().X402_ENABLED;
}

const HBAR = "0.0.0";

/**
 * Payment amount in the asset's smallest unit. Job prices are in 6-decimal test-token units (0.1 = 100000). An HTS token with
 * 6 decimals (USDC) is 1:1; HBAR (8 decimals) is priced at 1 HBAR per 1 test-token unit, so tinybars = price x 100.
 */
export function x402Amount(price: string, asset: string): string {
  return asset === HBAR ? (BigInt(price) * 100n).toString() : price;
}

let treasuryCache: { evm: string; accountId: string } | null = null;

/** The account that receives payments: X402_PAY_TO, or the API wallet's own Hedera account (found via the mirror node). */
export async function treasuryAccountId(fetchImpl: typeof fetch = fetch): Promise<string> {
  const env = getEnv();
  if (env.X402_PAY_TO) return env.X402_PAY_TO;
  if (!env.API_PRIVATE_KEY) throw new X402Error("not_configured", "set X402_PAY_TO (a 0.0.x account) or API_PRIVATE_KEY", 503);
  const evm = privateKeyToAccount(env.API_PRIVATE_KEY as Hex).address.toLowerCase();
  if (treasuryCache?.evm === evm) return treasuryCache.accountId;
  let res: Response;
  try {
    res = await fetchImpl(`${env.MIRROR_NODE_URL}/api/v1/accounts/${evm}`);
  } catch {
    throw new X402Error("not_configured", "could not look up the treasury account on the mirror node", 503);
  }
  if (!res.ok) throw new X402Error("not_configured", `the API wallet has no Hedera account yet (mirror node ${res.status}); fund it or set X402_PAY_TO`, 503);
  const body = (await res.json()) as { account?: string };
  if (!body.account) throw new X402Error("not_configured", "mirror node returned no account", 503);
  treasuryCache = { evm, accountId: body.account };
  return body.account;
}

type Server = x402ResourceServer;
const g = globalThis as typeof globalThis & { __meshX402?: { key: string; server: Server; ready: Promise<void> } };

export function resetX402(): void {
  g.__meshX402 = undefined;
  treasuryCache = null;
}

/** One resource server per facilitator URL and network; its facilitator capabilities are fetched once. */
async function resourceServer(): Promise<Server> {
  const env = getEnv();
  const key = `${env.X402_FACILITATOR_URL}|${env.X402_NETWORK}`;
  if (!g.__meshX402 || g.__meshX402.key !== key) {
    const server = new x402ResourceServer(new HTTPFacilitatorClient({ url: env.X402_FACILITATOR_URL, timeoutMs: 30_000 }));
    server.register(env.X402_NETWORK as `${string}:${string}`, new ExactHederaScheme());
    g.__meshX402 = { key, server, ready: server.initialize() };
  }
  try {
    await g.__meshX402.ready;
  } catch (e) {
    g.__meshX402 = undefined; // retry next time
    throw new X402Error("facilitator_unavailable", `could not reach the x402 facilitator (${e instanceof Error ? e.message.slice(0, 120) : "error"})`, 503);
  }
  return g.__meshX402.server;
}

export interface Quote {
  requirements: PaymentRequirements[];
  amount: string;
  asset: string;
  payTo: string;
}

/** Build the payment requirements for a job price. */
export async function buildQuote(price: string): Promise<Quote> {
  const env = getEnv();
  const server = await resourceServer();
  const payTo = await treasuryAccountId();
  const amount = x402Amount(price, env.X402_ASSET);
  const requirements = await server.buildPaymentRequirements({
    scheme: "exact",
    payTo,
    price: { asset: env.X402_ASSET, amount },
    network: env.X402_NETWORK as `${string}:${string}`,
    maxTimeoutSeconds: env.X402_MAX_TIMEOUT_SECONDS,
  });
  return { requirements, amount, asset: env.X402_ASSET, payTo };
}

/** The 402 response: base64 `PAYMENT-REQUIRED` header plus the same JSON as the body. */
export async function paymentRequired(quote: Quote, resource: { url: string; description: string }, error?: string): Promise<{ header: string; body: PaymentRequired }> {
  const server = await resourceServer();
  const body = await server.createPaymentRequiredResponse(quote.requirements, { url: resource.url, description: resource.description, mimeType: "application/json" }, error);
  return { header: encodePaymentRequiredHeader(body), body };
}

/** Key that identifies one signed payment, so the same payment can never buy two jobs. */
export function paymentKey(payload: PaymentPayload): string {
  const tx = typeof payload.payload?.transaction === "string" ? payload.payload.transaction : JSON.stringify(payload.payload ?? {});
  return `x402:${createHash("sha256").update(tx).digest("hex")}`;
}

export function decodePayment(headerValue: string): PaymentPayload {
  try {
    const p = decodePaymentSignatureHeader(headerValue);
    if (!p || typeof p !== "object" || !p.accepted || !p.payload) throw new Error("incomplete");
    return p;
  } catch {
    throw new X402Error("invalid_payment", `${HEADER_SIGNATURE} is not a valid base64 x402 payment`, 400);
  }
}

/** Check that a payment matches one of the requirements we quoted, and that the facilitator accepts it. No side effects. */
export async function verifyPayment(payload: PaymentPayload, quote: Quote): Promise<{ requirements: PaymentRequirements; payer: string | null }> {
  const server = await resourceServer();
  const requirements = server.findMatchingRequirements(quote.requirements, payload);
  if (!requirements) throw new X402Error("payment_mismatch", "the payment does not match the quoted requirements (amount, asset, recipient or network)", 402);
  let res;
  try {
    res = await server.verifyPayment(payload, requirements);
  } catch (e) {
    throw new X402Error("facilitator_unavailable", `payment verification failed to run (${e instanceof Error ? e.message.slice(0, 120) : "error"})`, 503);
  }
  if (!res.isValid) throw new X402Error("payment_invalid", res.invalidMessage ?? res.invalidReason ?? "the facilitator rejected the payment", 402);
  return { requirements, payer: res.payer ?? null };
}

/** Reserve a payment so it can be used only once. Throws payment_replayed if it was seen before. */
export function reservePayment(payload: PaymentPayload): string {
  const key = paymentKey(payload);
  try {
    getDb().prepare("INSERT INTO used_nonces (nonce, job_id, ts) VALUES (?, ?, ?)").run(key, "x402-pending", Math.floor(Date.now() / 1000));
  } catch {
    throw new X402Error("payment_replayed", "this payment was already used", 409);
  }
  return key;
}

export function attachPaymentToJob(key: string, jobId: string): void {
  getDb().prepare("UPDATE used_nonces SET job_id = ? WHERE nonce = ?").run(jobId, key);
}

/** Settle on Hedera through the facilitator. The returned `transaction` is the Hedera transaction id. */
export async function settlePayment(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse> {
  const server = await resourceServer();
  let res: SettleResponse;
  try {
    res = await server.settlePayment(payload, requirements);
  } catch (e) {
    // an indeterminate outcome: the payment may have settled. The key stays reserved so it cannot be reused.
    throw new X402Error("settle_failed", `settlement did not complete (${e instanceof Error ? e.message.slice(0, 120) : "error"})`, 502);
  }
  if (!res.success) throw new X402Error("settle_failed", res.errorMessage ?? res.errorReason ?? "settlement failed", 402);
  return res;
}

export function paymentResponseHeader(settle: SettleResponse): string {
  return encodePaymentResponseHeader(settle);
}

/** HashScan link for a Hedera transaction id in the `0.0.x@seconds.nanos` form. */
export function hashscanTxUrl(transaction: string, network = getEnv().X402_NETWORK): string {
  const net = network.endsWith("mainnet") ? "mainnet" : "testnet";
  const m = /^(\d+\.\d+\.\d+)@(\d+)\.(\d+)$/.exec(transaction);
  return `https://hashscan.io/${net}/transaction/${m ? `${m[1]}-${m[2]}-${m[3]}` : transaction}`;
}
