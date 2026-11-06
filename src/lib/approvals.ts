import { createHash, randomUUID } from "node:crypto";
import { agentPassConfigured, AgentPassError, pollDeviceGrant, startDeviceAuthorization, validateIdToken } from "./agentpass";
import { getDb, transaction } from "./db";
import { getEnv } from "./env";
import { RENDER_PRICE } from "./constants";
import type { RenderPreset } from "./constants";
import { approvalAction, consumeNullifier, createRpContext, verifyIdkitProof, worldEnforced } from "./world";

/**
 * Human approvals (World Agent Pass). An approval authorizes ONE exact action (here: create a job of a given preset and price
 * for a given requester). It is bound to that action by a hash, can be used once, and expires. The agent cannot reuse it for a
 * bigger job or another requester. See docs/TRACKS.md section 3.4.
 */

export interface ApprovalParams {
  purpose: "create-job";
  requester: string;
  type: "render";
  preset: RenderPreset;
  price: string;
}

const now = () => Math.floor(Date.now() / 1000);

export function priceFor(preset: RenderPreset): string {
  return RENDER_PRICE[preset];
}

export function canonicalParams(p: ApprovalParams): string {
  return JSON.stringify({ purpose: p.purpose, requester: p.requester.toLowerCase(), type: p.type, preset: p.preset, price: p.price });
}

export function bindingFor(p: ApprovalParams): string {
  return createHash("sha256").update(canonicalParams(p)).digest("hex");
}

/** True when a job at this price needs a fresh human approval (the spending threshold). */
export function approvalRequired(price: string): boolean {
  const t = getEnv().AGENT_APPROVAL_THRESHOLD;
  return t !== undefined && BigInt(price) > BigInt(t);
}

export type ApprovalStatus = "pending" | "approved" | "denied" | "expired" | "used";
/** device = World IdP device grant (Agent Pass); idkit = a World ID proof made for this one approval (used when no IdP client exists). */
export type ApprovalMethod = "device" | "idkit";

export const IDKIT_APPROVAL_TTL_SECONDS = 600;

export interface ApprovalView {
  approvalId: string;
  method: ApprovalMethod;
  status: ApprovalStatus;
  purpose: string;
  params: ApprovalParams;
  userCode: string;
  verificationUri: string;
  expiresAt: number;
  interval: number;
  reason: string | null;
}

interface Row {
  approval_id: string;
  purpose: string;
  binding: string;
  params: string;
  status: ApprovalStatus;
  method: ApprovalMethod;
  device_code: string;
  user_code: string;
  verification_uri: string;
  interval_s: number;
  next_poll_at: number;
  expires_at: number;
  subject: string | null;
  reason: string | null;
}

const view = (r: Row): ApprovalView => ({
  approvalId: r.approval_id,
  method: r.method ?? "device",
  status: r.status,
  purpose: r.purpose,
  params: JSON.parse(r.params) as ApprovalParams,
  userCode: r.user_code,
  verificationUri: r.verification_uri,
  expiresAt: r.expires_at,
  interval: r.interval_s,
  reason: r.reason,
}); // the device code never leaves the server

export class ApprovalError extends Error {
  constructor(
    public readonly code: "not_found" | "not_approved" | "binding_mismatch" | "already_used" | "expired" | "denied" | "not_configured" | "wrong_method",
    message: string,
  ) {
    super(message);
    this.name = "ApprovalError";
  }
}

/** Start a device authorization for an action. The returned user code / URL is what the human sees. */
export async function createApproval(params: ApprovalParams, fetchImpl: typeof fetch = fetch): Promise<ApprovalView> {
  if (!agentPassConfigured()) {
    // no World IdP client (the portal is not open to every account): fall back to a World ID proof made for this one approval
    if (worldEnforced()) return createIdkitApproval(params);
    throw new ApprovalError("not_configured", "neither World Agent Pass nor World ID (IDKit) is configured on the server");
  }
  const device = await startDeviceAuthorization(fetchImpl);
  const id = randomUUID();
  const t = now();
  getDb()
    .prepare(
      `INSERT INTO approvals (approval_id, purpose, binding, params, status, device_code, user_code, verification_uri, interval_s, next_poll_at, expires_at, created_at)
       VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, params.purpose, bindingFor(params), canonicalParams(params), device.deviceCode, device.userCode, device.verificationUriComplete ?? device.verificationUri, device.interval, t + device.interval, t + device.expiresIn, t);
  return view(getRow(id)!);
}

/** An approval the human grants by proving they are a unique human in the World app, on a page of ours (`/approve/<id>`). */
function createIdkitApproval(params: ApprovalParams): ApprovalView {
  const id = randomUUID();
  const t = now();
  const userCode = `${id.slice(0, 4)}-${id.slice(4, 8)}`.toUpperCase();
  getDb()
    .prepare(
      `INSERT INTO approvals (approval_id, purpose, binding, params, status, method, device_code, user_code, verification_uri, interval_s, next_poll_at, expires_at, created_at)
       VALUES (?, ?, ?, ?, 'pending', 'idkit', '', ?, ?, 2, ?, ?, ?)`,
    )
    .run(id, params.purpose, bindingFor(params), canonicalParams(params), userCode, `${getEnv().API_PUBLIC_URL.replace(/\/$/, "")}/approve/${id}`, t, t + IDKIT_APPROVAL_TTL_SECONDS, t);
  return view(getRow(id)!);
}

/** The approval row for an idkit approval that can still be answered; throws otherwise. Expires it if its time is up. */
function openIdkitRow(id: string): Row {
  const row = getRow(id);
  if (!row) throw new ApprovalError("not_found", "approval not found");
  if (row.method !== "idkit") throw new ApprovalError("wrong_method", "this approval is answered through the World IdP, not a World ID proof");
  if (row.status === "pending" && now() >= row.expires_at) {
    setStatus(id, "expired", { reason: "the approval window passed" });
    throw new ApprovalError("expired", "the approval expired");
  }
  if (row.status === "expired") throw new ApprovalError("expired", "the approval expired");
  if (row.status === "denied") throw new ApprovalError("denied", row.reason ?? "the approval was denied");
  if (row.status === "used") throw new ApprovalError("already_used", "this approval was already used");
  return row;
}

/**
 * Answer an idkit approval with the IDKit result. The proof is verified HERE, for the action `approve-<id>` (so it is only good for
 * this approval), and its nullifier is recorded against this approval. Any failure leaves the approval pending and unauthorized.
 */
export async function approveWithIdkit(id: string, result: unknown, fetchImpl: typeof fetch = fetch): Promise<ApprovalView> {
  const row = openIdkitRow(id);
  if (row.status === "approved") return view(row); // answering twice is harmless
  const action = approvalAction(id);
  const { nullifier } = await verifyIdkitProof(action, result, fetchImpl);
  consumeNullifier(nullifier, action, id); // a proof for this approval cannot be replayed for another
  setStatus(id, "approved", { subject: `world-id|${nullifier.toLowerCase()}` });
  return view(getRow(id)!);
}

/** The signed IDKit request for a pending idkit approval: only that one approval can ask for it, and only while it is open. */
export function rpContextForApproval(id: string) {
  const row = openIdkitRow(id);
  if (row.status !== "pending") throw new ApprovalError("not_approved", `this approval is already ${row.status}`);
  return createRpContext(approvalAction(id));
}

/** The human (or the page) turns an idkit approval down. */
export function cancelApproval(id: string): ApprovalView {
  const row = getRow(id);
  if (!row) throw new ApprovalError("not_found", "approval not found");
  if (row.method !== "idkit") throw new ApprovalError("wrong_method", "this approval is answered through the World IdP");
  if (row.status === "pending") setStatus(id, "denied", { reason: "cancelled by the human" });
  return view(getRow(id)!);
}

function getRow(id: string): Row | undefined {
  return getDb().prepare("SELECT * FROM approvals WHERE approval_id = ?").get(id) as Row | undefined;
}

function setStatus(id: string, status: ApprovalStatus, extra: { subject?: string; reason?: string } = {}): void {
  getDb()
    .prepare("UPDATE approvals SET status = ?, subject = COALESCE(?, subject), reason = ?, decided_at = ? WHERE approval_id = ? AND status = 'pending'")
    .run(status, extra.subject ?? null, extra.reason ?? null, now(), id);
}

/**
 * Current state of an approval. While pending it polls World (no more often than the allowed interval). Anything other than a
 * validated ID token leaves the action unauthorized.
 */
export async function getApproval(id: string, fetchImpl: typeof fetch = fetch): Promise<ApprovalView> {
  let row = getRow(id);
  if (!row) throw new ApprovalError("not_found", "approval not found");

  if (row.status === "pending") {
    const t = now();
    if (t >= row.expires_at) {
      setStatus(id, "expired", { reason: "the approval window passed" });
    } else if (row.method === "idkit") {
      // answered by POST /api/approvals/:id/idkit, nothing to poll
    } else if (t >= row.next_poll_at) {
      const poll = await pollDeviceGrant(row.device_code, fetchImpl);
      const wait = row.interval_s + (poll.status === "slow_down" ? 5 : 0);
      switch (poll.status) {
        case "pending":
        case "slow_down":
        case "transient":
          getDb().prepare("UPDATE approvals SET next_poll_at = ?, interval_s = ? WHERE approval_id = ?").run(t + wait, wait, id);
          break;
        case "denied":
          setStatus(id, "denied", { reason: poll.reason });
          break;
        case "expired":
          setStatus(id, "expired", { reason: poll.reason });
          break;
        case "approved":
          try {
            const who = await validateIdToken(poll.idToken, fetchImpl);
            setStatus(id, "approved", { subject: `${who.issuer}|${who.sub}` });
          } catch (e) {
            // a token that fails validation is a denial, never an approval
            setStatus(id, "denied", { reason: e instanceof AgentPassError ? e.message : "token validation failed" });
          }
          break;
      }
    }
    row = getRow(id)!;
  }
  return view(row);
}

/** Non-consuming check used before the payment leg: throws unless the approval is approved, unexpired, unused and bound to these parameters. */
export function checkApproval(id: string, params: ApprovalParams): { subject: string | null } {
  const row = getRow(id);
  if (!row) throw new ApprovalError("not_found", "approval not found");
  if (row.status === "used") throw new ApprovalError("already_used", "this approval was already used");
  if (row.status === "denied") throw new ApprovalError("denied", row.reason ?? "the human did not approve");
  if (row.status === "expired" || (row.status === "pending" && now() >= row.expires_at)) throw new ApprovalError("expired", "the approval expired");
  if (row.status !== "approved") throw new ApprovalError("not_approved", "the human has not approved yet");
  if (row.binding !== bindingFor(params)) throw new ApprovalError("binding_mismatch", "this approval was granted for a different action");
  return { subject: row.subject };
}

/**
 * Use an approval for the action it was granted for. Atomic and single use. Throws unless it is approved, unexpired, unused and
 * bound to exactly these parameters.
 */
export function consumeApproval(id: string, params: ApprovalParams): { subject: string | null } {
  return transaction((db) => {
    const row = getRow(id);
    if (!row) throw new ApprovalError("not_found", "approval not found");
    if (row.status === "used") throw new ApprovalError("already_used", "this approval was already used");
    if (row.status === "denied") throw new ApprovalError("denied", row.reason ?? "the human did not approve");
    if (row.status === "expired" || (row.status === "pending" && now() >= row.expires_at)) throw new ApprovalError("expired", "the approval expired");
    if (row.status !== "approved") throw new ApprovalError("not_approved", "the human has not approved yet");
    if (row.binding !== bindingFor(params)) throw new ApprovalError("binding_mismatch", "this approval was granted for a different action");
    db.prepare("UPDATE approvals SET status = 'used', used_at = ? WHERE approval_id = ? AND status = 'approved'").run(now(), id);
    return { subject: row.subject };
  });
}
