import { connection } from "next/server";
import { json, jsonError, readJson } from "@/lib/api";
import { claimBodySchema, ProtocolError, submitClaim } from "@/lib/claims";
import { requireProvider } from "@/lib/provider-auth";
import { jobIdSchema } from "@/lib/types";

/** POST /api/jobs/:id/claim (provider only): signed claim over the provider's own tiles. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  await connection();
  const auth = requireProvider(req);
  if ("error" in auth) return auth.error;
  const { id } = await ctx.params;
  if (!jobIdSchema.safeParse(id).success) return jsonError(400, "invalid_job_id");

  const read = await readJson(req, 256 * 1024);
  if ("error" in read) return read.error;
  const parsed = claimBodySchema.safeParse(read.value);
  if (!parsed.success) {
    return json({ error: "invalid_body", issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) }, 400);
  }
  try {
    return json({ ok: true, ...(await submitClaim(id, auth.provider.address, parsed.data)) });
  } catch (err) {
    if (err instanceof ProtocolError) return jsonError(err.status, err.code, err.message);
    throw err;
  }
}
