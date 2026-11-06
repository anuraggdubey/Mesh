import { createHash } from "node:crypto";
import { recoverMessageAddress } from "viem";
import { z } from "zod";
import type { Hex } from "viem";
import { getEnv } from "./env";
import type { InferenceRecord } from "./types";

/**
 * 0G Private Computer, through the OpenAI-compatible Router (docs/OG-STATUS.md). One call: a vision model looks at the
 * finished render and answers in JSON. We keep the request id the Router returns, ask it to verify the TEE (`verify_tee`), and,
 * when a signature endpoint and signer address are configured, verify the provider's EIP-191 signature over the signed `text`
 * ourselves. A verification level is only ever claimed for a check that really passed.
 *
 * ASSUMPTIONS that only a live call can confirm (all configurable or recorded, never faked):
 *  - the Router returns `x_0g_trace.{request_id,provider,tee_verified}` in the response body
 *  - the provider serves `GET {OG_SIGNATURE_BASE_URL}/v1/proxy/signature/{chatID}?model=...` returning `{text, signature}`
 *  - the signed `text` refers to this response (checked: it must contain the completion id, request id or the answer)
 */

export class OgError extends Error {
  constructor(
    public readonly code: "not_configured" | "no_credit" | "rate_limited" | "unavailable" | "timeout" | "bad_response",
    message: string,
    public readonly status: number,
    public readonly retryAfter?: number,
  ) {
    super(message);
    this.name = "OgError";
  }
}

export function ogConfigured(): boolean {
  return Boolean(getEnv().OG_API_KEY);
}

/** Remove the API key from any text before it can reach a log or a response. */
export function scrub(text: string): string {
  const key = getEnv().OG_API_KEY;
  return key ? text.split(key).join("[redacted]") : text;
}

export interface OgDeps {
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
}
const realDeps: OgDeps = { fetch: (...a) => fetch(...a), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };

export const REVIEW_PROMPT =
  'You are reviewing a Mandelbrot-set render that was computed by untrusted machines. Look at the image. Reply with ONLY JSON: {"description": "<=2 sentences describing what you see", "quality": "good|suspicious|poor", "notes": "<=1 sentence, e.g. visible blur, repeated blocks, flat or missing regions, or null"}. "good" means a clean, detailed Mandelbrot render with no visible tampering.';

type Trace = { request_id?: string; provider?: string; tee_verified?: boolean };
interface ChatResponse {
  id?: string;
  choices?: { message?: { content?: unknown } }[];
  x_0g_trace?: Trace;
}

const sha256 = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

/** POST once, retrying a single 429 after Retry-After (capped at 10 s). */
async function post(url: string, body: unknown, deps: OgDeps): Promise<Response> {
  const env = getEnv();
  const call = async () => {
    try {
      return await deps.fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${env.OG_API_KEY}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(env.OG_TIMEOUT_MS),
      });
    } catch (e) {
      if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) throw new OgError("timeout", "0G did not answer in time", 504);
      throw new OgError("unavailable", `could not reach 0G (${scrub(e instanceof Error ? e.message : "error").slice(0, 120)})`, 502);
    }
  };
  let res = await call();
  if (res.status === 429) {
    const wait = Math.min(10, Math.max(1, Number(res.headers.get("retry-after")) || 2));
    await deps.sleep(wait * 1000);
    res = await call();
    if (res.status === 429) throw new OgError("rate_limited", "0G is rate limiting this account; try again shortly", 429, Number(res.headers.get("retry-after")) || wait);
  }
  return res;
}

function parseOutput(content: string): InferenceRecord["output"] {
  const trimmed = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    const j = JSON.parse(trimmed) as { description?: unknown; quality?: unknown; notes?: unknown };
    const q = String(j.quality ?? "").toLowerCase();
    return {
      description: String(j.description ?? "").slice(0, 600) || trimmed.slice(0, 600),
      quality: q === "good" || q === "suspicious" || q === "poor" ? q : "unknown",
      notes: typeof j.notes === "string" && j.notes && j.notes.toLowerCase() !== "null" ? j.notes.slice(0, 300) : null,
    };
  } catch {
    return { description: trimmed.slice(0, 600), quality: "unknown", notes: null };
  }
}

interface SignatureCheck {
  verified: boolean | null; // null = not attempted
  bound: boolean | null;
  digest: string | null;
  note: string | null;
}

/** Fetch `{text, signature}` from the provider and check the EIP-191 signature against the configured signer. */
async function checkSignature(chatId: string, requestId: string, content: string, deps: OgDeps): Promise<SignatureCheck> {
  const env = getEnv();
  if (!env.OG_SIGNATURE_BASE_URL || !env.OG_SIGNER_ADDRESS) return { verified: null, bound: null, digest: null, note: "no signature endpoint or signer address configured" };
  try {
    const url = `${env.OG_SIGNATURE_BASE_URL.replace(/\/$/, "")}/v1/proxy/signature/${encodeURIComponent(chatId)}?model=${encodeURIComponent(env.OG_MODEL)}`;
    const res = await deps.fetch(url, { headers: { authorization: `Bearer ${env.OG_API_KEY}` }, signal: AbortSignal.timeout(env.OG_TIMEOUT_MS) });
    if (!res.ok) return { verified: null, bound: null, digest: null, note: `signature endpoint answered ${res.status}` };
    const b = (await res.json()) as { text?: unknown; signature?: unknown };
    if (typeof b.text !== "string" || typeof b.signature !== "string" || !/^0x[0-9a-fA-F]+$/.test(b.signature)) return { verified: null, bound: null, digest: null, note: "signature endpoint returned an unexpected shape" };
    const recovered = await recoverMessageAddress({ message: b.text, signature: b.signature as Hex });
    const verified = recovered.toLowerCase() === env.OG_SIGNER_ADDRESS.toLowerCase();
    const bound = b.text.includes(chatId) || b.text.includes(requestId) || (content.length > 0 && b.text.includes(content));
    return { verified, bound, digest: sha256(b.text), note: verified ? null : "the signature was not made by the configured signer" };
  } catch (e) {
    return { verified: null, bound: null, digest: null, note: `signature check failed (${scrub(e instanceof Error ? e.message : "error").slice(0, 100)})` };
  }
}

/** What one chat call returns: the answer text plus everything we can say about where it came from. */
export interface OgCall {
  content: string;
  requestId: string;
  provider: string | null;
  model: string;
  teeVerified: boolean | null;
  verification: InferenceRecord["verification"];
  signer: string | null;
  signatureVerified: boolean | null;
  textBound: boolean | null;
  digest: string;
}

/**
 * One chat completion on 0G with the request id, `verify_tee` and signature handling in one place. Throws OgError for a failed call
 * (no key, no credit, rate limit, outage, bad reply). A failed verification is not an error: it just lowers `verification`.
 */
export async function chatOnce(messages: unknown[], opts: { maxTokens: number; temperature?: number }, deps: OgDeps = realDeps): Promise<OgCall> {
  const env = getEnv();
  if (!env.OG_API_KEY) throw new OgError("not_configured", "OG_API_KEY is not set", 503);
  const res = await post(
    `${env.OG_API_BASE_URL.replace(/\/$/, "")}/chat/completions`,
    { model: env.OG_MODEL, temperature: opts.temperature ?? 0, max_tokens: opts.maxTokens, verify_tee: true, messages },
    deps,
  );
  if (res.status === 402) throw new OgError("no_credit", "the 0G account has no credit left (add funds at pc.0g.ai)", 402);
  if (res.status >= 500) throw new OgError("unavailable", `0G answered ${res.status}`, 502);
  if (!res.ok) throw new OgError("bad_response", `0G rejected the request (${res.status})`, 502);

  let body: ChatResponse;
  try {
    body = (await res.json()) as ChatResponse;
  } catch {
    throw new OgError("bad_response", "0G returned something that is not JSON", 502);
  }
  const content = body.choices?.[0]?.message?.content;
  const trace = body.x_0g_trace ?? {};
  if (typeof content !== "string" || !content.trim()) throw new OgError("bad_response", "0G returned no answer", 502);
  if (!trace.request_id) throw new OgError("bad_response", "0G returned no request id (x_0g_trace.request_id)", 502); // the track requires it

  const teeVerified = typeof trace.tee_verified === "boolean" ? trace.tee_verified : null;
  const sig = await checkSignature(body.id ?? trace.request_id, trace.request_id, content, deps);
  const signed = sig.verified === true && sig.bound === true;
  return {
    content,
    requestId: trace.request_id,
    provider: trace.provider ?? null,
    model: env.OG_MODEL,
    teeVerified,
    // a signature that does not check out is a red flag: it overrides the Router's own claim
    verification: signed ? "tee-signature" : sig.verified === false ? "unverified" : teeVerified === true ? "router-checked" : "unverified",
    signer: env.OG_SIGNER_ADDRESS ?? null,
    signatureVerified: sig.verified,
    textBound: sig.bound,
    digest: sig.digest ?? sha256(content),
  };
}

/** Ask a 0G vision model to review a PNG. Never throws for a failed verification; throws OgError for a failed call. */
export async function reviewImage(png: Buffer, deps: OgDeps = realDeps): Promise<InferenceRecord> {
  const call = await chatOnce([{ role: "user", content: [{ type: "text", text: REVIEW_PROMPT }, { type: "image_url", image_url: { url: `data:image/png;base64,${png.toString("base64")}` } }] }], { maxTokens: 300 }, deps);
  return {
    requestId: call.requestId,
    provider: call.provider,
    model: call.model,
    teeVerified: call.teeVerified,
    verification: call.verification,
    signer: call.signer,
    signatureVerified: call.signatureVerified,
    textBound: call.textBound,
    digest: call.digest,
    output: parseOutput(call.content),
    imageSha256: sha256(png),
    reviewedAt: Math.floor(Date.now() / 1000),
  };
}

// ───────────────────────── job planning ─────────────────────────

export const PLAN_PRESETS = ["tiny", "small", "full"] as const;

export const PLAN_PROMPT = `You plan compute jobs for Mesh, a marketplace that renders a deterministic Mandelbrot image on spare machines. There are exactly three sizes:
- "tiny": a 64x64 test image, 4 tiles, about 1 second, costs 0.1 HBAR. For quick checks and tests.
- "small": a 2048x2048 image, 64 tiles, about 5 seconds, costs 0.5 HBAR. A good default.
- "full": the same image at 8x the iteration depth, 64 tiles, about 30 seconds, costs 1 HBAR. For the highest detail or a heavy demo.
Read the user's request and choose ONE size. Reply with ONLY JSON, no other text: {"preset": "tiny|small|full", "reason": "<=2 short sentences on why this size fits the request"}.`;

const planSchema = z.object({ preset: z.enum(PLAN_PRESETS), reason: z.string().trim().min(1).max(400) });

export type Plan = z.infer<typeof planSchema>;

/** Parse the model's answer into a strict plan. Anything that is not exactly that shape is an error, never a guess. */
export function parsePlan(content: string): Plan {
  const trimmed = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    throw new OgError("bad_response", "the 0G model did not answer with JSON", 502);
  }
  const parsed = planSchema.safeParse(raw);
  if (!parsed.success) throw new OgError("bad_response", "the 0G model chose a size that does not exist or left out its reason", 502);
  return parsed.data;
}

export interface OgPlan extends OgCall {
  plan: Plan;
}

/** Turn a user's sentence into a job size with a 0G model. The user's text goes in as data; the answer is validated, never trusted. */
export async function planJob(userPrompt: string, deps: OgDeps = realDeps): Promise<OgPlan> {
  const call = await chatOnce(
    [
      { role: "system", content: PLAN_PROMPT },
      { role: "user", content: userPrompt.slice(0, 600) },
    ],
    { maxTokens: 200 },
    deps,
  );
  return { ...call, plan: parsePlan(call.content) };
}
