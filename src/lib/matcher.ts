import { randomUUID } from "node:crypto";
import { getAddress } from "viem";
import { getDb, transaction } from "./db";
import { appendEvent, getJob, transitionJob } from "./jobs";
import { listOnlineProviders } from "./providers";
import type { Job } from "./types";

const now = () => Math.floor(Date.now() / 1000);

/** A job is split across at most this many providers (matches the contract's MAX_PROVIDERS). */
export const MAX_PROVIDERS_PER_JOB = 16;

export interface Task {
  taskId: string;
  jobId: string;
  type: Job["type"];
  imageRef: string;
  imageDigest: string;
  inputHash: string;
  tiles: number[];
  timeoutSeconds: number;
}

/**
 * Assign every `paid`, unassigned job to the providers that are currently online.
 * Tile i is owned by providers[i % providers.length] (docs/job-spec.md section 3.3); one task is created per provider.
 * Jobs with no online provider stay `paid` and are picked up the next time this runs. Returns the number assigned.
 */
export function tryAssignPending(): number {
  const online = listOnlineProviders();
  if (online.length === 0) return 0;

  const rows = getDb()
    .prepare("SELECT job_id FROM jobs WHERE status = 'paid' ORDER BY created_at, rowid")
    .all() as { job_id: string }[];

  let assigned = 0;
  for (const { job_id } of rows) {
    const job = getJob(job_id);
    if (!job || job.status !== "paid" || job.providers.length > 0) continue;

    const count = Math.min(online.length, MAX_PROVIDERS_PER_JOB, job.tileCount);
    const chosen = online.slice(0, count);
    const providers = chosen.map((p) => getAddress(p.address));

    transaction((db) => {
      const tiles = job.tiles.map((t) => ({ ...t, owner: providers[t.index % providers.length], status: "assigned" as const }));
      chosen.forEach((p, i) => {
        const mine = tiles.filter((t) => t.index % providers.length === i).map((t) => t.index);
        db.prepare("INSERT INTO tasks (task_id, job_id, provider, tiles, status, created_at) VALUES (?, ?, ?, ?, 'queued', ?)").run(
          randomUUID(),
          job.jobId,
          p.address.toLowerCase(),
          JSON.stringify(mine),
          now(),
        );
      });
      transitionJob(job.jobId, "assigned", { providers, tiles });
      appendEvent(job.jobId, "assigned", { providers, tileCount: job.tileCount });
    });
    assigned += 1;
  }
  return assigned;
}

interface RawTask {
  task_id: string;
  job_id: string;
  tiles: string;
}

/**
 * Hand a provider its queued tasks and mark them delivered. The first delivery moves the job
 * from `assigned` to `running`.
 */
export function deliverTasks(providerAddress: string): Task[] {
  const address = providerAddress.toLowerCase();
  const db = getDb();
  const queued = db
    .prepare("SELECT task_id, job_id, tiles FROM tasks WHERE provider = ? AND status = 'queued' ORDER BY created_at, rowid")
    .all(address) as unknown as RawTask[];

  const out: Task[] = [];
  for (const t of queued) {
    const job = getJob(t.job_id);
    if (!job || (job.status !== "assigned" && job.status !== "running")) {
      db.prepare("UPDATE tasks SET status = 'failed' WHERE task_id = ?").run(t.task_id);
      continue;
    }
    db.prepare("UPDATE tasks SET status = 'delivered', delivered_at = ? WHERE task_id = ?").run(now(), t.task_id);
    if (job.status === "assigned") transitionJob(job.jobId, "running");
    out.push({
      taskId: t.task_id,
      jobId: job.jobId,
      type: job.type,
      imageRef: job.imageRef,
      imageDigest: job.imageDigest,
      inputHash: job.inputHash,
      tiles: JSON.parse(t.tiles) as number[],
      timeoutSeconds: job.timeoutSeconds,
    });
  }
  return out;
}

/** Tiles assigned to a provider for a job (from its task), or null if the provider has no task on this job. */
export function tilesForProvider(jobId: string, providerAddress: string): number[] | null {
  const rows = getDb()
    .prepare("SELECT tiles FROM tasks WHERE job_id = ? AND provider = ? AND status IN ('queued','delivered','done')")
    .all(jobId, providerAddress.toLowerCase()) as { tiles: string }[];
  if (rows.length === 0) return null;
  return rows.flatMap((r) => JSON.parse(r.tiles) as number[]).sort((a, b) => a - b);
}

export function markTaskDone(jobId: string, providerAddress: string): void {
  getDb().prepare("UPDATE tasks SET status = 'done' WHERE job_id = ? AND provider = ? AND status = 'delivered'").run(jobId, providerAddress.toLowerCase());
}

export function markTasksFailed(jobId: string): void {
  getDb().prepare("UPDATE tasks SET status = 'failed' WHERE job_id = ? AND status IN ('queued','delivered')").run(jobId);
}
