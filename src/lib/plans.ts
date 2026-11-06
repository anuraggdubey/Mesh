import { randomUUID } from "node:crypto";
import { RENDER_PRICE } from "./constants";
import type { RenderPreset } from "./constants";
import { getDb, transaction } from "./db";
import type { OgCall } from "./og";

/**
 * A plan: what the user asked for and which job size was chosen, either by a 0G model (with its request id and verification level)
 * or by the user by hand (`manual`, clearly not 0G). A plan is single use and expires quickly; it belongs to one wallet.
 */

export const PLAN_TTL_SECONDS = 600;

export class PlanError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: "plan_not_found" | "plan_expired" | "plan_used" | "wrong_owner",
    message: string,
  ) {
    super(message);
    this.name = "PlanError";
  }
}

const now = () => Math.floor(Date.now() / 1000);

interface Row {
  plan_id: string;
  address: string;
  source: "og" | "manual";
  prompt: string | null;
  preset: RenderPreset;
  price: string;
  reason: string | null;
  og_request_id: string | null;
  og_provider: string | null;
  og_model: string | null;
  tee_verified: number | null;
  verification: "tee-signature" | "router-checked" | "unverified" | null;
  signer: string | null;
  digest: string | null;
  created_at: number;
  expires_at: number;
  status: "planned" | "used";
  run_id: string | null;
}

export interface PlanView {
  planId: string;
  address: string;
  source: "og" | "manual";
  prompt: string | null;
  preset: RenderPreset;
  price: string; // job price units (0.1 = 100000)
  reason: string | null;
  og: { requestId: string; provider: string | null; model: string | null; teeVerified: boolean | null; verification: "tee-signature" | "router-checked" | "unverified"; signer: string | null } | null;
  createdAt: number;
  expiresAt: number;
  status: "planned" | "used";
  runId: string | null;
}

const view = (r: Row): PlanView => ({
  planId: r.plan_id,
  address: r.address,
  source: r.source,
  prompt: r.prompt,
  preset: r.preset,
  price: r.price,
  reason: r.reason,
  og: r.og_request_id
    ? { requestId: r.og_request_id, provider: r.og_provider, model: r.og_model, teeVerified: r.tee_verified === null ? null : r.tee_verified === 1, verification: r.verification ?? "unverified", signer: r.signer }
    : null,
  createdAt: r.created_at,
  expiresAt: r.expires_at,
  status: r.status,
  runId: r.run_id,
});

export function createPlan(input: { address: string; preset: RenderPreset; reason: string | null; prompt: string | null; og: OgCall | null }): PlanView {
  const id = randomUUID();
  const t = now();
  const og = input.og;
  getDb()
    .prepare(
      `INSERT INTO plans (plan_id, address, source, prompt, preset, price, reason, og_request_id, og_provider, og_model, tee_verified, verification, signer, digest, created_at, expires_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'planned')`,
    )
    .run(id, input.address.toLowerCase(), og ? "og" : "manual", input.prompt, input.preset, RENDER_PRICE[input.preset], input.reason, og?.requestId ?? null, og?.provider ?? null, og?.model ?? null, og && og.teeVerified !== null ? (og.teeVerified ? 1 : 0) : null, og?.verification ?? null, og?.signer ?? null, og?.digest ?? null, t, t + PLAN_TTL_SECONDS);
  return view(getRow(id)!);
}

function getRow(id: string): Row | undefined {
  return getDb().prepare("SELECT * FROM plans WHERE plan_id = ?").get(id) as Row | undefined;
}

export function getPlan(id: string): PlanView | null {
  const r = getRow(id);
  return r ? view(r) : null;
}

/** Use a plan exactly once, for its owner, before it expires. Marks it used and returns it. Atomic. */
export function consumePlan(planId: string, address: string, runId: string): PlanView {
  return transaction((db) => {
    const r = getRow(planId);
    if (!r) throw new PlanError(404, "plan_not_found", "plan not found");
    if (r.address !== address.toLowerCase()) throw new PlanError(403, "wrong_owner", "this plan belongs to a different wallet");
    if (r.status === "used") throw new PlanError(409, "plan_used", "this plan was already used");
    if (now() > r.expires_at) throw new PlanError(410, "plan_expired", "this plan expired: ask the agent again");
    const res = db.prepare("UPDATE plans SET status = 'used', run_id = ? WHERE plan_id = ? AND status = 'planned'").run(runId, planId);
    if (Number(res.changes) !== 1) throw new PlanError(409, "plan_used", "this plan was already used");
    return view(getRow(planId)!);
  });
}
