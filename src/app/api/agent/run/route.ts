import { connection } from "next/server";
import { z } from "zod";
import { RunError, startRun } from "@/lib/agent-runner";
import { json, jsonError, parseBody } from "@/lib/api";
import { PlanError } from "@/lib/plans";
import { requireSession } from "@/lib/session";

/**
 * POST /api/agent/run {planId}: the Mesh agent buys the planned job for the signed-in user, paying from their prepaid credit.
 * Returns the run straight away; poll GET /api/agent/runs/:id. If a human approval is needed the run is `needs_approval` and
 * carries the link to approve.
 */
export async function POST(req: Request) {
  await connection();
  const session = await requireSession(req);
  if ("error" in session) return session.error;
  const body = await parseBody(req, z.object({ planId: z.string().uuid() }), 1024);
  if ("error" in body) return body.error;
  try {
    const { run } = await startRun(session.address, body.data.planId);
    return json({ run }, 202);
  } catch (e) {
    if (e instanceof PlanError || e instanceof RunError) return jsonError(e.status, e.code, e.message);
    throw e;
  }
}
