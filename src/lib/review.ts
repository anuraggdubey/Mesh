import { getTileBytes } from "./claims";
import { getDb } from "./db";
import { getEnv } from "./env";
import { appendEvent, getJob, updateJob } from "./jobs";
import { OgError, ogConfigured, reviewImage, scrub } from "./og";
import type { OgDeps } from "./og";
import { renderTilesToPng } from "./png";
import type { InferenceRecord, Job } from "./types";
import { renderGeometry } from "./ui/job-view";

/**
 * The AI review of a finished render, made on 0G (docs/OG-STATUS.md). It runs once per job: the result is stored on the job,
 * published as an `inference` event (and so to HCS), and shown on the job page. Only a `final` job can be reviewed, so the model
 * never "approves" work that has not passed verification.
 */

export class ReviewError extends Error {
  constructor(
    public readonly code: "job_not_found" | "job_not_final" | "tiles_missing" | "not_supported",
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "ReviewError";
  }
}

const inFlight = new Map<string, Promise<InferenceRecord>>();

export function jobPng(job: Job): Buffer {
  if (job.type !== "render") throw new ReviewError("not_supported", `AI review is only available for render jobs (this is ${job.type})`, 400);
  const tiles: (Uint8Array | null)[] = [];
  for (let i = 0; i < job.tileCount; i += 1) tiles.push(getTileBytes(job.jobId, i));
  try {
    return renderTilesToPng(renderGeometry(job), tiles);
  } catch (e) {
    throw new ReviewError("tiles_missing", e instanceof Error ? e.message : "tiles are missing", 409);
  }
}

/** Review a job. Idempotent: a job that was reviewed returns its stored review; concurrent calls share one 0G request. */
export async function reviewJob(jobId: string, deps?: OgDeps): Promise<{ inference: InferenceRecord; cached: boolean }> {
  const job = getJob(jobId);
  if (!job) throw new ReviewError("job_not_found", "job not found", 404);
  if (job.inference) return { inference: job.inference, cached: true };
  if (job.status !== "final") throw new ReviewError("job_not_final", `only a finished (final) job can be reviewed; this one is ${job.status}`, 409);
  if (!ogConfigured()) throw new OgError("not_configured", "AI review is not configured on this server (OG_API_KEY)", 503);

  const running = inFlight.get(jobId);
  if (running) return { inference: await running, cached: false };

  const p = (async () => {
    const inference = await reviewImage(jobPng(job), deps);
    // another process may have stored one while we waited; keep the first (the request id is on HCS once)
    const fresh = getJob(jobId);
    if (fresh?.inference) return fresh.inference;
    updateJob(jobId, { inference });
    appendEvent(jobId, "inference", {
      requestId: inference.requestId,
      provider: inference.provider,
      model: inference.model,
      verification: inference.verification,
      teeVerified: inference.teeVerified,
      signer: inference.signer,
      digest: inference.digest,
      quality: inference.output.quality,
      description: inference.output.description.slice(0, 300),
    });
    return inference;
  })();
  inFlight.set(jobId, p);
  try {
    return { inference: await p, cached: false };
  } finally {
    inFlight.delete(jobId);
  }
}

// ───────────────────────── automatic review (chain loop) ─────────────────────────

const attempts = new Map<string, number>();
export const MAX_REVIEW_ATTEMPTS = 3;
export function resetReviewAttempts(): void {
  attempts.clear();
}

/** Review final jobs that have no review yet (at most `limit` per call). Failures are counted and given up on after a few tries. */
export async function autoReview(limit = 2, deps?: OgDeps): Promise<{ reviewed: string[]; errors: { jobId: string; message: string }[] }> {
  const out = { reviewed: [] as string[], errors: [] as { jobId: string; message: string }[] };
  if (!getEnv().OG_ENABLED || !ogConfigured()) return out;
  const rows = getDb().prepare("SELECT job_id FROM jobs WHERE status = 'final' ORDER BY created_at DESC, rowid DESC LIMIT 25").all() as unknown as { job_id: string }[];
  for (const r of rows) {
    if (out.reviewed.length + out.errors.length >= limit) break;
    const job = getJob(r.job_id);
    if (!job || job.inference || job.type !== "render" || (attempts.get(job.jobId) ?? 0) >= MAX_REVIEW_ATTEMPTS) continue;
    attempts.set(job.jobId, (attempts.get(job.jobId) ?? 0) + 1);
    try {
      await reviewJob(job.jobId, deps);
      out.reviewed.push(job.jobId);
    } catch (e) {
      out.errors.push({ jobId: job.jobId, message: scrub(e instanceof Error ? e.message : "review failed").slice(0, 200) });
    }
  }
  return out;
}
