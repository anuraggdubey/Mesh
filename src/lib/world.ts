import { signRequest } from "@worldcoin/idkit-core/signing";
import { getDb } from "./db";
import { getEnv } from "./env";

/**
 * World ID (IDKit) on the server: creates the RP signature the widget needs, verifies the proof the widget returns,
 * and enforces "one human, one provider profile" with a nullifier store. See docs/TRACKS.md section 3.
 *
 * Trust rules: the proof is verified HERE (never trust the client), the `environment` is pinned on the server (a client
 * must not be able to choose "staging"/"sandbox", which accept test proofs), and a nullifier can be used once per action.
 */

export const WORLD_ACTIONS = ["register-provider"] as const;
/**
 * An IDKit action name. Either one of the fixed actions, or a per-approval action `approve-<approvalId>`: every human approval of a
 * spend gets its own action, so each approval needs a fresh proof and a proof for one approval is useless for another.
 */
export type WorldAction = string;

const APPROVAL_ACTION = /^approve-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function approvalAction(approvalId: string): string {
  return `approve-${approvalId}`;
}

const now = () => Math.floor(Date.now() / 1000);

/** True when IDKit is configured, so provider registration must carry a valid proof. */
export function worldEnforced(): boolean {
  const env = getEnv();
  return Boolean(env.WORLD_RP_ID && env.WORLD_SIGNING_KEY && env.NEXT_PUBLIC_WORLD_APP_ID);
}

export class WorldDeniedError extends Error {
  constructor(
    public readonly reason:
      | "not_configured"
      | "unsupported_action"
      | "missing_proof"
      | "wrong_action"
      | "wrong_environment"
      | "invalid_proof"
      | "no_nullifier"
      | "nullifier_reused"
      | "verify_unavailable",
    message: string,
  ) {
    super(message);
    this.name = "WorldDeniedError";
  }
}

/** True for the fixed actions only (what POST /api/world/rp-context accepts without an approval id). */
export function isWorldAction(a: unknown): a is (typeof WORLD_ACTIONS)[number] {
  return typeof a === "string" && (WORLD_ACTIONS as readonly string[]).includes(a);
}

/** True for any action this server will sign or verify: a fixed one, or a well-formed per-approval one. */
export function isKnownAction(a: unknown): a is WorldAction {
  return isWorldAction(a) || (typeof a === "string" && APPROVAL_ACTION.test(a));
}

/** The values the browser needs to open the IDKit widget. The signing key never leaves the server. */
export function createRpContext(action: WorldAction) {
  const env = getEnv();
  if (!env.WORLD_RP_ID || !env.WORLD_SIGNING_KEY || !env.NEXT_PUBLIC_WORLD_APP_ID) throw new WorldDeniedError("not_configured", "World ID is not configured on the server");
  if (!isKnownAction(action)) throw new WorldDeniedError("unsupported_action", `unsupported action: ${String(action)}`);
  const key = env.WORLD_SIGNING_KEY.replace(/^0x/, "");
  const sig = signRequest({ signingKeyHex: key, action });
  return {
    app_id: env.NEXT_PUBLIC_WORLD_APP_ID,
    rp_id: env.WORLD_RP_ID,
    environment: env.WORLD_ENVIRONMENT,
    action,
    rp_context: { rp_id: env.WORLD_RP_ID, nonce: sig.nonce, created_at: sig.createdAt, expires_at: sig.expiresAt, signature: sig.sig },
  };
}

interface IdkitResult {
  action?: string;
  environment?: string;
  responses?: { nullifier?: string; identifier?: string }[];
  [k: string]: unknown;
}

/**
 * Verify an IDKit result with World's verify endpoint. Returns the nullifier on success; throws WorldDeniedError otherwise.
 * Does NOT consume the nullifier: call `consumeNullifier` once the protected action is about to happen.
 */
export async function verifyIdkitProof(action: WorldAction, result: unknown, fetchImpl: typeof fetch = fetch): Promise<{ nullifier: string }> {
  const env = getEnv();
  if (!env.WORLD_RP_ID) throw new WorldDeniedError("not_configured", "World ID is not configured on the server");
  if (!result || typeof result !== "object") throw new WorldDeniedError("missing_proof", "a World ID proof is required");
  if (!isKnownAction(action)) throw new WorldDeniedError("unsupported_action", `unsupported action: ${String(action)}`);
  const idkit = result as IdkitResult;

  if (idkit.action !== action) throw new WorldDeniedError("wrong_action", "the proof was made for a different action");
  // the client must not choose the environment: reject a mismatch instead of silently overriding it
  if (idkit.environment !== undefined && idkit.environment !== env.WORLD_ENVIRONMENT) throw new WorldDeniedError("wrong_environment", "the proof's environment does not match the server");
  const nullifier = idkit.responses?.find((r) => typeof r.nullifier === "string" && r.nullifier.length > 0)?.nullifier;
  if (!nullifier) throw new WorldDeniedError("no_nullifier", "the proof has no nullifier");

  let res: Response;
  try {
    res = await fetchImpl(`${env.WORLD_VERIFY_BASE_URL}/api/v4/verify/${encodeURIComponent(env.WORLD_RP_ID)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...idkit, environment: env.WORLD_ENVIRONMENT }),
    });
  } catch {
    throw new WorldDeniedError("verify_unavailable", "could not reach World's verify endpoint"); // unknown outcome is never approval
  }
  if (res.status >= 500 || res.status === 429) throw new WorldDeniedError("verify_unavailable", `World verify returned ${res.status}`);

  let body: { success?: boolean; environment?: string; code?: string; detail?: string } = {};
  try {
    body = (await res.json()) as typeof body;
  } catch {
    // not JSON: treated as a failure below
  }
  if (res.status !== 200 || body.success !== true) throw new WorldDeniedError("invalid_proof", body.detail ?? body.code ?? `verification failed (${res.status})`);
  if (body.environment !== undefined && body.environment !== env.WORLD_ENVIRONMENT) throw new WorldDeniedError("wrong_environment", "World verified the proof in a different environment");
  return { nullifier };
}

/** Read-only check: is this nullifier free, or already bound to this same wallet? Throws nullifier_reused otherwise. */
export function assertNullifierAvailable(nullifier: string, action: WorldAction, address: string): void {
  const existing = getDb().prepare("SELECT address FROM world_nullifiers WHERE nullifier = ? AND action = ?").get(nullifier.toLowerCase(), action) as { address: string } | undefined;
  if (existing && existing.address !== address.toLowerCase()) throw new WorldDeniedError("nullifier_reused", "this human already registered another provider wallet");
}

/**
 * Record a nullifier for an action and the wallet it was used for. A repeat for the SAME wallet is fine (re-registration);
 * the same human for a DIFFERENT wallet is rejected. Atomic via the primary key.
 */
export function consumeNullifier(nullifier: string, action: WorldAction, address: string): void {
  const db = getDb();
  const addr = address.toLowerCase();
  const n = nullifier.toLowerCase();
  const existing = db.prepare("SELECT address FROM world_nullifiers WHERE nullifier = ? AND action = ?").get(n, action) as { address: string } | undefined;
  if (existing) {
    if (existing.address === addr) return;
    throw new WorldDeniedError("nullifier_reused", "this human already registered another provider wallet");
  }
  try {
    db.prepare("INSERT INTO world_nullifiers (nullifier, action, address, verified_at) VALUES (?, ?, ?, ?)").run(n, action, addr, now());
  } catch {
    // lost a race with another request using the same nullifier
    throw new WorldDeniedError("nullifier_reused", "this human already registered another provider wallet");
  }
}

/** Convert a World nullifier (hex field element) to the contract's bytes32. */
export function nullifierToBytes32(nullifier: string): `0x${string}` {
  const hex = nullifier.replace(/^0x/, "").toLowerCase();
  if (!/^[0-9a-f]{1,64}$/.test(hex)) throw new WorldDeniedError("no_nullifier", "the nullifier is not a hex value that fits 32 bytes");
  return `0x${hex.padStart(64, "0")}`;
}
