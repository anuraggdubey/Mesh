import { createRemoteJWKSet, jwtVerify } from "jose";
import { getEnv } from "./env";

/**
 * World ID "Agent Pass" backend: the World IdP (auth.world.org) device authorization grant for a headless agent that needs
 * a fresh human approval, plus strict validation of the ID token it returns. See docs/TRACKS.md section 3.2.
 *
 * Rules we enforce (from World's docs): only a validated ID token approves anything; HTTP 503/429 and network errors are never
 * approval; `acr`/`amr`/`auth_time` are checked against our policy; `sub` is treated as opaque.
 */

export class AgentPassError extends Error {
  constructor(
    public readonly code: "not_configured" | "discovery_failed" | "request_failed" | "invalid_token",
    message: string,
  ) {
    super(message);
    this.name = "AgentPassError";
  }
}

export function agentPassConfigured(): boolean {
  const env = getEnv();
  return Boolean(env.WORLD_IDP_CLIENT_ID && env.WORLD_IDP_CLIENT_SECRET);
}

interface Discovery {
  issuer: string;
  jwks_uri: string;
  token_endpoint: string;
  device_authorization_endpoint: string;
}

const discoveryCache = new Map<string, { at: number; value: Discovery }>();
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export function resetAgentPassCaches(): void {
  discoveryCache.clear();
  jwksCache.clear();
}

async function discover(fetchImpl: typeof fetch = fetch): Promise<Discovery> {
  const env = getEnv();
  const issuer = env.WORLD_IDP_ISSUER.replace(/\/$/, "");
  const hit = discoveryCache.get(issuer);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.value;
  let res: Response;
  try {
    res = await fetchImpl(`${issuer}/.well-known/openid-configuration`);
  } catch {
    throw new AgentPassError("discovery_failed", "could not reach the World IdP");
  }
  if (!res.ok) throw new AgentPassError("discovery_failed", `World IdP discovery returned ${res.status}`);
  const d = (await res.json()) as Partial<Discovery>;
  if (d.issuer !== issuer) throw new AgentPassError("discovery_failed", "discovery issuer does not match the configured issuer");
  const value: Discovery = {
    issuer,
    jwks_uri: d.jwks_uri ?? `${issuer}/.well-known/jwks.json`,
    token_endpoint: d.token_endpoint ?? `${issuer}/api/v1/token`,
    device_authorization_endpoint: d.device_authorization_endpoint ?? `${issuer}/api/v1/device_authorization`,
  };
  discoveryCache.set(issuer, { at: Date.now(), value });
  return value;
}

function clientAuth(): { client_id: string; client_secret: string } {
  const env = getEnv();
  if (!env.WORLD_IDP_CLIENT_ID || !env.WORLD_IDP_CLIENT_SECRET) throw new AgentPassError("not_configured", "WORLD_IDP_CLIENT_ID / WORLD_IDP_CLIENT_SECRET are not set");
  return { client_id: env.WORLD_IDP_CLIENT_ID, client_secret: env.WORLD_IDP_CLIENT_SECRET };
}

/**
 * A form POST to the IdP with our client credentials, sent the way the portal client was registered:
 * `post` (client_id and client_secret in the body) or `basic` (HTTP Basic header). Set WORLD_IDP_CLIENT_AUTH.
 */
function formRequest(auth: { client_id: string; client_secret: string }, params: Record<string, string>): { headers: Record<string, string>; body: URLSearchParams } {
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
  if (getEnv().WORLD_IDP_CLIENT_AUTH === "basic") {
    headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(auth.client_id)}:${encodeURIComponent(auth.client_secret)}`).toString("base64")}`;
    return { headers, body: new URLSearchParams(params) };
  }
  return { headers, body: new URLSearchParams({ ...params, ...auth }) };
}

export interface DeviceAuthorization {
  deviceCode: string; // private: never sent to the agent or the browser
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string | null;
  expiresIn: number; // seconds
  interval: number; // seconds between polls
}

/** Start a device authorization: the human is shown `userCode` / `verificationUri` and approves in the World app. */
export async function startDeviceAuthorization(fetchImpl: typeof fetch = fetch): Promise<DeviceAuthorization> {
  const d = await discover(fetchImpl);
  const auth = clientAuth();
  let res: Response;
  try {
    res = await fetchImpl(d.device_authorization_endpoint, {
      method: "POST",
      ...formRequest(auth, { scope: "openid" }),
    });
  } catch {
    throw new AgentPassError("request_failed", "could not reach the World IdP");
  }
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || typeof body.device_code !== "string" || typeof body.user_code !== "string") {
    throw new AgentPassError("request_failed", `device authorization failed (${res.status}${typeof body.error === "string" ? ` ${body.error}` : ""})`);
  }
  return {
    deviceCode: body.device_code,
    userCode: body.user_code,
    verificationUri: String(body.verification_uri ?? ""),
    verificationUriComplete: typeof body.verification_uri_complete === "string" ? body.verification_uri_complete : null,
    expiresIn: Number(body.expires_in ?? 1200),
    interval: Math.max(1, Number(body.interval ?? 5)),
  };
}

export type PollResult =
  | { status: "pending" }
  | { status: "slow_down" }
  | { status: "approved"; idToken: string }
  | { status: "denied"; reason: string }
  | { status: "expired"; reason: string }
  | { status: "transient"; reason: string }; // outage / rate limit / network: NOT an approval, keep waiting

/** Poll the token endpoint once for a device code. */
export async function pollDeviceGrant(deviceCode: string, fetchImpl: typeof fetch = fetch): Promise<PollResult> {
  const d = await discover(fetchImpl);
  const auth = clientAuth();
  let res: Response;
  try {
    res = await fetchImpl(d.token_endpoint, {
      method: "POST",
      ...formRequest(auth, { grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: deviceCode }),
    });
  } catch {
    return { status: "transient", reason: "network error" };
  }
  if (res.status === 503 || res.status === 429 || res.status >= 500) return { status: "transient", reason: `World IdP returned ${res.status}` };
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.status === 200 && typeof body.id_token === "string") return { status: "approved", idToken: body.id_token };

  const error = typeof body.error === "string" ? body.error : "";
  switch (error) {
    case "authorization_pending":
      return { status: "pending" };
    case "slow_down":
      return { status: "slow_down" };
    case "access_denied":
      return { status: "denied", reason: "the human denied the request or could not meet the required assurance" };
    case "expired_token":
      return { status: "expired", reason: "the device code expired" };
    case "invalid_grant":
      return { status: "expired", reason: "the device code is no longer valid" };
    default:
      // any other answer (invalid_client, malformed, 4xx) is never approval
      return { status: "denied", reason: error || `unexpected response (${res.status})` };
  }
}

export interface HumanIdentity {
  issuer: string;
  sub: string; // opaque, case-sensitive
  acr: string;
  amr: string[];
  authTime: number;
}

/**
 * Validate the ID token: RS256 signature against the issuer's JWKS, exact issuer, our client id as audience, expiry, and our
 * policy on `acr` (Orb only by default), `amr` (must include "pop") and `auth_time` (fresh).
 */
export async function validateIdToken(idToken: string, fetchImpl: typeof fetch = fetch): Promise<HumanIdentity> {
  const env = getEnv();
  const d = await discover(fetchImpl);
  const auth = clientAuth();
  let jwks = jwksCache.get(d.jwks_uri);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(d.jwks_uri), { timeoutDuration: 5000 });
    jwksCache.set(d.jwks_uri, jwks);
  }
  let payload;
  try {
    ({ payload } = await jwtVerify(idToken, jwks, { issuer: d.issuer, audience: auth.client_id, algorithms: ["RS256"], clockTolerance: 30 }));
  } catch (e) {
    throw new AgentPassError("invalid_token", `ID token rejected: ${e instanceof Error ? e.message : "invalid"}`);
  }

  const allowed = env.WORLD_IDP_ALLOWED_ACR.split(",").map((s) => s.trim()).filter(Boolean);
  const acr = typeof payload.acr === "string" ? payload.acr : "";
  if (!allowed.includes(acr)) throw new AgentPassError("invalid_token", `assurance level ${acr || "(none)"} is not accepted`);
  const amr = Array.isArray(payload.amr) ? payload.amr.filter((x): x is string => typeof x === "string") : [];
  if (!amr.includes("pop")) throw new AgentPassError("invalid_token", "the token does not show a World ID proof (amr must include pop)");
  const authTime = typeof payload.auth_time === "number" ? payload.auth_time : NaN;
  const nowSec = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(authTime) || authTime > nowSec + 60) throw new AgentPassError("invalid_token", "the token has no valid auth_time");
  if (nowSec - authTime > env.AGENT_APPROVAL_MAX_AGE_SECONDS) throw new AgentPassError("invalid_token", "the authentication is too old; a fresh one is required");
  if (typeof payload.sub !== "string" || payload.sub.length === 0) throw new AgentPassError("invalid_token", "the token has no subject");

  return { issuer: d.issuer, sub: payload.sub, acr, amr, authTime };
}
