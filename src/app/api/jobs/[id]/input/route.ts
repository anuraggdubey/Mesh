import { connection } from "next/server";
import { jsonError } from "@/lib/api";
import { getJob } from "@/lib/jobs";
import { tilesForProvider } from "@/lib/matcher";
import { requireProvider } from "@/lib/provider-auth";
import { renderRunInput } from "@/lib/render-input";
import { jobIdSchema } from "@/lib/types";
import type { RenderPreset } from "@/lib/constants";

/**
 * GET /api/jobs/:id/input (provider only): the exact job.json bytes for THIS provider's tiles
 * (docs/job-spec.md section 4.1: canonical input plus a `tiles` list).
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  await connection();
  const auth = requireProvider(req);
  if ("error" in auth) return auth.error;
  const { id } = await ctx.params;
  if (!jobIdSchema.safeParse(id).success) return jsonError(400, "invalid_job_id");

  const job = getJob(id);
  if (!job) return jsonError(404, "job_not_found");
  const tiles = tilesForProvider(id, auth.provider.address);
  if (!tiles) return jsonError(403, "no_task", "you have no tiles on this job");

  const body = renderRunInput(String((job.params as { preset: string }).preset) as RenderPreset, tiles);
  return new Response(body, { headers: { "content-type": "application/json" } });
}
