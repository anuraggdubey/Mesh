import { connection } from "next/server";
import { json, jsonError, readJson } from "@/lib/api";
import { failureBodySchema, ProtocolError, reportFailure } from "@/lib/claims";
import { requireProvider } from "@/lib/provider-auth";
import { jobIdSchema } from "@/lib/types";

/** POST /api/jobs/:id/failure (provider only): the provider cannot finish its tiles. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  await connection();
  const auth = requireProvider(req);
  if ("error" in auth) return auth.error;
  const { id } = await ctx.params;
  if (!jobIdSchema.safeParse(id).success) return jsonError(400, "invalid_job_id");

  const read = await readJson(req, 16 * 1024);
  if ("error" in read) return read.error;
  const parsed = failureBodySchema.safeParse(read.value);
  if (!parsed.success) return jsonError(400, "invalid_body", parsed.error.issues[0]?.message);
  if (parsed.data.provider.toLowerCase() !== auth.provider.address) return jsonError(403, "provider_mismatch");

  try {
    reportFailure(id, auth.provider.address, parsed.data.reason, parsed.data.logTail);
    return json({ ok: true });
  } catch (err) {
    if (err instanceof ProtocolError) return jsonError(err.status, err.code, err.message);
    throw err;
  }
}
