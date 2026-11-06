import { connection } from "next/server";
import { json, jsonError, readJson } from "@/lib/api";
import { ApprovalError, rpContextForApproval } from "@/lib/approvals";
import { createRpContext, isWorldAction, WorldDeniedError } from "@/lib/world";

/**
 * POST /api/world/rp-context: the values the browser needs for the IDKit widget (signature made server-side).
 *   {action: "register-provider"}                  provider onboarding
 *   {action: "approve-spend", approvalId: "<id>"}  one pending World ID approval of an agent spend (action approve-<id>)
 */
export async function POST(req: Request) {
  await connection();
  const read = await readJson(req, 2 * 1024);
  if ("error" in read) return read.error;
  const body = (read.value ?? {}) as { action?: unknown; approvalId?: unknown };
  try {
    if (body.action === "approve-spend") {
      if (typeof body.approvalId !== "string" || !/^[0-9a-f-]{36}$/.test(body.approvalId)) return jsonError(400, "invalid_approval_id");
      return json(rpContextForApproval(body.approvalId));
    }
    if (!isWorldAction(body.action)) return jsonError(400, "unsupported_action", "action must be one of: register-provider, approve-spend");
    return json(createRpContext(body.action));
  } catch (e) {
    if (e instanceof WorldDeniedError) return jsonError(e.reason === "not_configured" ? 503 : 400, e.reason, e.message);
    if (e instanceof ApprovalError) return jsonError(e.code === "not_found" ? 404 : e.code === "wrong_method" ? 400 : 409, e.code, e.message);
    throw e;
  }
}
