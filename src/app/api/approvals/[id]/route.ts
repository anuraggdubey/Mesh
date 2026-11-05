import { connection } from "next/server";
import { json, jsonError } from "@/lib/api";
import { AgentPassError } from "@/lib/agentpass";
import { ApprovalError, getApproval } from "@/lib/approvals";

/** GET /api/approvals/:id: current status (pending, approved, denied, expired, used). Polls World while pending. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  await connection();
  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/.test(id)) return jsonError(400, "invalid_approval_id");
  try {
    return json(await getApproval(id));
  } catch (e) {
    if (e instanceof ApprovalError) return jsonError(e.code === "not_found" ? 404 : 400, e.code, e.message);
    if (e instanceof AgentPassError) return jsonError(502, e.code, e.message);
    throw e;
  }
}
