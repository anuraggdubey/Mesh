import { randomBytes } from "node:crypto";
import { getDb, transaction } from "./db";
import { getEnv } from "./env";
import { assertTransition } from "./state-machine";
import { renderInputHash } from "./render-input";
import { RENDER_PRESETS, RENDER_PRICE, TILE_COUNT_DEFAULT } from "./constants";
import type { JobStatus } from "./constants";
import type { CreateJobBody, Job, Tile } from "./types";

export interface JobEvent {
  id: number;
  jobId: string;
  type: string;
  data: Record<string, unknown>;
  ts: number;
}

const now = () => Math.floor(Date.now() / 1000);

export function newJobId(): string {
  return `0x${randomBytes(32).toString("hex")}`;
}

export class UnsupportedJobTypeError extends Error {
  constructor(public readonly type: string) {
    super(`job type "${type}" is not available yet`);
    this.name = "UnsupportedJobTypeError";
  }
}

export class JobNotFoundError extends Error {
  constructor(public readonly jobId: string) {
    super(`job ${jobId} not found`);
    this.name = "JobNotFoundError";
  }
}

/** Build a new Job (not yet stored). Only `render` is wired up so far; other types come with their workers. */
export function buildJob(body: CreateJobBody): Job {
  if (body.type !== "render") throw new UnsupportedJobTypeError(body.type);

  const env = getEnv();
  const preset = RENDER_PRESETS[body.preset];
  const tileCount = preset.gridCols * preset.gridRows;
  const tiles: Tile[] = Array.from({ length: tileCount }, (_, index) => ({
    index,
    owner: null,
    status: "pending",
    tileHash: null,
  }));

  return {
    jobId: newJobId(),
    type: "render",
    mode: "deterministic",
    status: "created",
    requester: body.requester,
    worldNullifier: null,
    imageRef: env.RENDER_IMAGE_REF,
    imageDigest: env.RENDER_IMAGE_DIGEST,
    inputHash: renderInputHash(body.preset),
    params: { preset: body.preset, ...preset },
    tileCount: tileCount || TILE_COUNT_DEFAULT,
    providers: [],
    tiles,
    merkleRoot: null,
    price: RENDER_PRICE[body.preset],
    asset: env.PAYMENT_TOKEN_ADDRESS ?? null,
    stakeRequired: env.MIN_STAKE_WEI,
    timeoutSeconds: env.JOB_TIMEOUT_SECONDS,
    createdAt: now(),
    payment: null,
    lockTx: null,
    windowEnd: null,
    chainAttempts: 0,
    claimTx: null,
    finalTx: null,
    fraudTx: null,
    slashTx: null,
    refundTx: null,
    releaseTx: null,
    receiptTx: null,
    hcsSequence: [],
    sample: null,
    verdict: null,
    inference: null,
  };
}

/** Store a freshly built job and log its `created` event. */
export function insertJob(job: Job): Job {
  transaction((db) => {
    db.prepare("INSERT INTO jobs (job_id, status, created_at, data) VALUES (?, ?, ?, ?)").run(
      job.jobId,
      job.status,
      job.createdAt,
      JSON.stringify(job),
    );
    appendEventTx(db, job.jobId, "status", { status: job.status });
  });
  return job;
}

export function getJob(jobId: string): Job | null {
  const row = getDb().prepare("SELECT data FROM jobs WHERE job_id = ?").get(jobId) as { data: string } | undefined;
  return row ? (JSON.parse(row.data) as Job) : null;
}

export function listJobs(limit = 50): Job[] {
  const rows = getDb().prepare("SELECT data FROM jobs ORDER BY created_at DESC, rowid DESC LIMIT ?").all(limit) as {
    data: string;
  }[];
  return rows.map((r) => JSON.parse(r.data) as Job);
}

type Db = ReturnType<typeof getDb>;

function appendEventTx(db: Db, jobId: string, type: string, data: Record<string, unknown>): number {
  const res = db
    .prepare("INSERT INTO job_events (job_id, type, data, ts) VALUES (?, ?, ?, ?)")
    .run(jobId, type, JSON.stringify(data), now());
  return Number(res.lastInsertRowid);
}

export function appendEvent(jobId: string, type: string, data: Record<string, unknown> = {}): number {
  return appendEventTx(getDb(), jobId, type, data);
}

/** Events for a job in order. `afterId` supports resuming an SSE stream. */
export function listEvents(jobId: string, afterId = 0): JobEvent[] {
  const rows = getDb()
    .prepare("SELECT id, job_id, type, data, ts FROM job_events WHERE job_id = ? AND id > ? ORDER BY id")
    .all(jobId, afterId) as { id: number; job_id: string; type: string; data: string; ts: number }[];
  return rows.map((r) => ({ id: r.id, jobId: r.job_id, type: r.type, data: JSON.parse(r.data), ts: r.ts }));
}

/** Merge `patch` into the stored job atomically. */
export function updateJob(jobId: string, patch: Partial<Job>): Job {
  return transaction((db) => {
    const row = db.prepare("SELECT data FROM jobs WHERE job_id = ?").get(jobId) as { data: string } | undefined;
    if (!row) throw new JobNotFoundError(jobId);
    const next = { ...(JSON.parse(row.data) as Job), ...patch, jobId };
    db.prepare("UPDATE jobs SET status = ?, data = ? WHERE job_id = ?").run(next.status, JSON.stringify(next), jobId);
    return next;
  });
}

/**
 * Move a job to a new status. Validates the transition, applies optional extra fields, and logs a
 * `status` event, all in one transaction. Throws InvalidTransitionError / JobNotFoundError.
 */
export function transitionJob(jobId: string, to: JobStatus, extra: Partial<Job> = {}): Job {
  return transaction((db) => {
    const row = db.prepare("SELECT data FROM jobs WHERE job_id = ?").get(jobId) as { data: string } | undefined;
    if (!row) throw new JobNotFoundError(jobId);
    const current = JSON.parse(row.data) as Job;
    assertTransition(current.status, to);
    const next: Job = { ...current, ...extra, jobId, status: to };
    db.prepare("UPDATE jobs SET status = ?, data = ? WHERE job_id = ?").run(to, JSON.stringify(next), jobId);
    appendEventTx(db, jobId, "status", { status: to, from: current.status });
    return next;
  });
}

/** Expire `created` jobs that were never paid within the TTL. Returns the number expired. */
export function expireUnpaidJobs(): number {
  const ttl = getEnv().UNPAID_JOB_TTL_SECONDS;
  const cutoff = now() - ttl;
  const rows = getDb()
    .prepare("SELECT job_id FROM jobs WHERE status = 'created' AND created_at < ?")
    .all(cutoff) as { job_id: string }[];
  for (const r of rows) transitionJob(r.job_id, "expired");
  return rows.length;
}
