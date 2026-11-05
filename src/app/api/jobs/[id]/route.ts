import { connection } from "next/server";
import { json, jsonError } from "@/lib/api";
import { getJob } from "@/lib/jobs";
import { jobIdSchema } from "@/lib/types";

/** GET /api/jobs/:id */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  await connection();
  const { id } = await ctx.params;
  if (!jobIdSchema.safeParse(id).success) return jsonError(400, "invalid_job_id", "jobId must be 0x + 64 lowercase hex");
  const job = getJob(id);
  if (!job) return jsonError(404, "job_not_found");
  return json(job);
}
