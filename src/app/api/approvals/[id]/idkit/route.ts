import { connection } from "next/server";
import { json, jsonError, readJson } from "@/lib/api";
import { ApprovalError, approveWithIdkit } from "@/lib/approvals";
import { WorldDeniedError } from "@/lib/world";

/**
 * POST /api/approvals/:id/idkit {result}: the approval page sends the IDKit result here. It is verified on the server for the action
 * made for THIS approval. A bad proof is 401 and leaves the approval pending and unauthorized; a World outage is 503, never a pass.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  await connection();
  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/.test(id)) return jsonError(400, "invalid_approval_id");
  const read = await readJson(req, 64 * 1024);
  if ("error" in read) return read.error;
  const result = (read.value as { result?: unknown } | null)?.result;
  try {
    return json(await approveWithIdkit(id, result));
  } catch (e) {
    if (e instanceof WorldDeniedError) {
      const status = e.reason === "verify_unavailable" || e.reason === "not_configured" ? 503 : 401;
      return jsonError(status, "world_denied", e.message, { reason: e.reason });
    }
    if (e instanceof ApprovalError) {
      const status = e.code === "not_found" ? 404 : e.code === "wrong_method" ? 400 : 409;
      return jsonError(status, e.code, e.message);
    }
    throw e;
  }
}
