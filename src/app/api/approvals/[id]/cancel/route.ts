import { connection } from "next/server";
import { json, jsonError } from "@/lib/api";
import { ApprovalError, cancelApproval } from "@/lib/approvals";

/** POST /api/approvals/:id/cancel: the human turns a pending World ID approval down. Nothing is created or paid. */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  await connection();
  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/.test(id)) return jsonError(400, "invalid_approval_id");
  try {
    return json(cancelApproval(id));
  } catch (e) {
    if (e instanceof ApprovalError) return jsonError(e.code === "not_found" ? 404 : 400, e.code, e.message);
    throw e;
  }
}
