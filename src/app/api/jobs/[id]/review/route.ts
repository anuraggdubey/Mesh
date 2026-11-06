import { connection } from "next/server";
import { json, jsonError } from "@/lib/api";
import { OgError, scrub } from "@/lib/og";
import { ReviewError, reviewJob } from "@/lib/review";
import { jobIdSchema } from "@/lib/types";

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/jobs/:id/review: the AI review of a finished render, made on 0G Private Computer. Idempotent (a second call returns
 * the stored review) and only for `final` jobs. The response carries the 0G request id and how it was verified.
 */
export async function POST(_req: Request, ctx: Ctx) {
  await connection();
  const { id } = await ctx.params;
  if (!jobIdSchema.safeParse(id).success) return jsonError(400, "invalid_job_id", "jobId must be 0x + 64 lowercase hex");
  try {
    const r = await reviewJob(id);
    return json({ cached: r.cached, inference: r.inference });
  } catch (e) {
    if (e instanceof ReviewError) return jsonError(e.status, e.code, e.message);
    if (e instanceof OgError) {
      const res = jsonError(e.status, `og_${e.code}`, scrub(e.message));
      if (e.retryAfter) res.headers.set("retry-after", String(e.retryAfter));
      return res;
    }
    throw e;
  }
}
