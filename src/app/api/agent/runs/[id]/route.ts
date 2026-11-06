import { connection } from "next/server";
import { getRun, RunError } from "@/lib/agent-runner";
import { json, jsonError } from "@/lib/api";
import { getBalance, tinybarsToHbar } from "@/lib/credits";
import { requireSession } from "@/lib/session";

/** GET /api/agent/runs/:id: where a run is (queued, needs_approval, paying, paid, failed). Only its owner can read it. */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  await connection();
  const session = await requireSession(req);
  if ("error" in session) return session.error;
  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/.test(id)) return jsonError(400, "invalid_run_id");
  try {
    const run = await getRun(id, session.address);
    const balance = getBalance(session.address);
    return json({ run, balanceTinybars: balance, balanceHbar: tinybarsToHbar(balance) });
  } catch (e) {
    if (e instanceof RunError) return jsonError(e.status, e.code, e.message);
    throw e;
  }
}
