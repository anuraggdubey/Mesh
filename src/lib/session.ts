import { createHash, randomBytes } from "node:crypto";
import { jwtVerify, SignJWT } from "jose";
import { getAddress, isAddress, verifyMessage } from "viem";
import type { Hex } from "viem";
import { jsonError } from "./api";
import { getDb } from "./db";
import { getEnv } from "./env";

/**
 * Wallet sign-in. The browser wallet signs a plain-text message (EIP-191, no transaction, no gas). The server issues the message
 * with a single-use nonce, verifies the signature with viem, and sets an HttpOnly session cookie (HS256 JWT). We never see a key.
 */

export const NONCE_TTL_SECONDS = 300;
export const SESSION_TTL_SECONDS = 24 * 3600;
export const SESSION_COOKIE = "mesh_session";

export class SessionError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: "invalid_address" | "nonce_unknown" | "nonce_expired" | "nonce_used" | "bad_signature" | "not_configured",
    message: string,
  ) {
    super(message);
    this.name = "SessionError";
  }
}

const now = () => Math.floor(Date.now() / 1000);

/** The host the sign-in message names, so a signature made for another site cannot be replayed here. */
export function signInDomain(): string {
  return new URL(getEnv().API_PUBLIC_URL).host;
}

export function signInMessage(p: { address: string; nonce: string; issuedAt: number; expiresAt: number }): string {
  return [
    "Mesh wants you to sign in with your wallet.",
    `Domain: ${signInDomain()}`,
    `Address: ${getAddress(p.address)}`,
    `Nonce: ${p.nonce}`,
    `Issued: ${new Date(p.issuedAt * 1000).toISOString()}`,
    `Expires: ${new Date(p.expiresAt * 1000).toISOString()}`,
    "Signing costs nothing and sends no transaction.",
  ].join("\n");
}

export function issueNonce(address: string): { nonce: string; message: string; issuedAt: number; expiresAt: number } {
  if (!isAddress(address)) throw new SessionError(400, "invalid_address", "not an EVM address");
  const nonce = randomBytes(16).toString("hex");
  const issuedAt = now();
  const expiresAt = issuedAt + NONCE_TTL_SECONDS;
  const db = getDb();
  db.prepare("DELETE FROM auth_nonces WHERE expires_at < ?").run(issuedAt - 3600); // housekeeping
  db.prepare("INSERT INTO auth_nonces (nonce, address, issued_at, expires_at, used) VALUES (?, ?, ?, ?, 0)").run(nonce, address.toLowerCase(), issuedAt, expiresAt);
  return { nonce, message: signInMessage({ address, nonce, issuedAt, expiresAt }), issuedAt, expiresAt };
}

interface NonceRow {
  nonce: string;
  address: string;
  issued_at: number;
  expires_at: number;
  used: number;
}

/** Check the signature over the message WE built for this nonce, then spend the nonce exactly once. Returns the checksummed address. */
export async function verifySignIn(input: { address: string; nonce: string; signature: string }): Promise<string> {
  if (!isAddress(input.address)) throw new SessionError(400, "invalid_address", "not an EVM address");
  const row = getDb().prepare("SELECT * FROM auth_nonces WHERE nonce = ?").get(input.nonce) as NonceRow | undefined;
  if (!row || row.address !== input.address.toLowerCase()) throw new SessionError(401, "nonce_unknown", "unknown sign-in request: ask for a new one");
  if (row.used) throw new SessionError(401, "nonce_used", "this sign-in request was already used");
  if (now() > row.expires_at) throw new SessionError(401, "nonce_expired", "this sign-in request expired: ask for a new one");

  let ok = false;
  try {
    ok = await verifyMessage({ address: getAddress(input.address), message: signInMessage({ address: row.address, nonce: row.nonce, issuedAt: row.issued_at, expiresAt: row.expires_at }), signature: input.signature as Hex });
  } catch {
    ok = false;
  }
  if (!ok) throw new SessionError(401, "bad_signature", "the signature does not match this address");

  // single use: only one caller can flip used from 0 to 1
  const res = getDb().prepare("UPDATE auth_nonces SET used = 1 WHERE nonce = ? AND used = 0").run(row.nonce);
  if (Number(res.changes) !== 1) throw new SessionError(401, "nonce_used", "this sign-in request was already used");
  return getAddress(input.address);
}

// ───────────────────────── session cookie ─────────────────────────

/** The server secret that signs sessions and share tokens. */
export function secretKey(): Uint8Array {
  const env = getEnv();
  if (env.MESH_SESSION_SECRET) return new TextEncoder().encode(env.MESH_SESSION_SECRET);
  if (env.API_PRIVATE_KEY) return createHash("sha256").update(`mesh-session:${env.API_PRIVATE_KEY}`).digest();
  throw new SessionError(503, "not_configured", "set MESH_SESSION_SECRET (or API_PRIVATE_KEY) so sessions can be signed");
}

export async function issueSession(address: string): Promise<string> {
  return new SignJWT({}).setProtectedHeader({ alg: "HS256" }).setSubject(address.toLowerCase()).setIssuer("mesh").setIssuedAt().setExpirationTime(`${SESSION_TTL_SECONDS}s`).sign(secretKey());
}

export function cookieHeader(token: string | null): string {
  const secure = getEnv().API_PUBLIC_URL.startsWith("https:") ? "; Secure" : "";
  const base = `${SESSION_COOKIE}=${token ?? ""}; Path=/; HttpOnly; SameSite=Lax${secure}`;
  return token ? `${base}; Max-Age=${SESSION_TTL_SECONDS}` : `${base}; Max-Age=0`;
}

function cookieValue(req: Request, name: string): string | null {
  const raw = req.headers.get("cookie");
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

/** The signed-in address (lowercase) or null. A bad, expired or forged cookie is simply "not signed in". */
export async function readSession(req: Request): Promise<string | null> {
  const token = cookieValue(req, SESSION_COOKIE);
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secretKey(), { issuer: "mesh", algorithms: ["HS256"] });
    return typeof payload.sub === "string" && isAddress(payload.sub) ? payload.sub.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** For routes that need a signed-in user: the address, or a 401 Response. */
export async function requireSession(req: Request): Promise<{ address: string } | { error: Response }> {
  const address = await readSession(req);
  if (!address) return { error: jsonError(401, "unauthorized", "connect your wallet and sign in first") };
  return { address };
}
