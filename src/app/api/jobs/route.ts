import { connection } from "next/server";
import { json, jsonError, readJson } from "@/lib/api";
import { MAX_INPUT_BYTES } from "@/lib/constants";
import { getEnv } from "@/lib/env";
import { buildJob, getJob, insertJob, listJobs, transitionJob, UnsupportedJobTypeError } from "@/lib/jobs";
import { tryAssignPending } from "@/lib/matcher";
import { createJobBodySchema } from "@/lib/types";

/** GET /api/jobs: most recent jobs (newest first). */
export async function GET() {
  await connection();
  return json({ jobs: listJobs(50) });
}

/**
 * POST /api/jobs: create a job and require payment (docs/job-spec.md section 9).
 *
 * Without an X-PAYMENT header the server creates the job in `created` state and answers 402 with x402 payment
 * instructions (nonce = jobId). Verifying the paid retry is the x402 facilitator step (not built yet), so a request
 * that carries X-PAYMENT currently answers 501. For local development only, MESH_DEV_SKIP_PAYMENT=true skips payment
 * and marks the job `paid` immediately.
 */
export async function POST(req: Request) {
  const read = await readJson(req, MAX_INPUT_BYTES);
  if ("error" in read) return read.error;

  const parsed = createJobBodySchema.safeParse(read.value);
  if (!parsed.success) {
    return json(
      { error: "invalid_body", issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) },
      400,
    );
  }

  const env = getEnv();
  const devSkip = env.MESH_DEV_SKIP_PAYMENT;

  if (!devSkip && req.headers.get("x-payment")) {
    return jsonError(501, "x402_not_implemented", "payment verification is not built yet");
  }
  if (!devSkip && !env.ESCROW_ADDRESS) {
    return jsonError(503, "not_configured", "ESCROW_ADDRESS is not set on the server");
  }

  let job;
  try {
    job = insertJob(buildJob(parsed.data));
  } catch (err) {
    if (err instanceof UnsupportedJobTypeError) return jsonError(501, "unsupported_job_type", err.message);
    throw err;
  }

  if (devSkip) {
    const paid = transitionJob(job.jobId, "paid");
    tryAssignPending(); // hand it to any provider that is already online
    return json(getJob(job.jobId) ?? paid, 200, { "X-Mesh-Dev-Payment-Skipped": "true" });
  }

  // x402 challenge. `extra.nonce` is the jobId so the payment is bound to this job.
  return json(
    {
      x402Version: 1,
      error: "X-PAYMENT header is required",
      accepts: [
        {
          scheme: "exact",
          network: "hedera-testnet", // [TBD-VERIFY] against the Hedera x402 docs (docs/job-spec.md section 14)
          maxAmountRequired: job.price,
          resource: `${env.API_PUBLIC_URL}/api/jobs`,
          description: `Mesh ${job.type} job (${String(job.params.preset)})`,
          mimeType: "application/json",
          payTo: env.ESCROW_ADDRESS,
          maxTimeoutSeconds: env.UNPAID_JOB_TTL_SECONDS,
          asset: env.PAYMENT_TOKEN_ADDRESS ?? null,
          extra: { jobId: job.jobId, nonce: job.jobId },
        },
      ],
    },
    402,
  );
}
