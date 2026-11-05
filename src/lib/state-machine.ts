import type { JobStatus } from "./constants";

/**
 * Allowed job status transitions (docs/job-spec.md section 2.1).
 *   created -> paid -> assigned -> running -> pending -> final
 *   pending -> rejected -> slashed -> refunded
 *   any non-terminal -> expired -> refunded;  running/assigned -> failed -> refunded
 */
const TRANSITIONS: Record<JobStatus, JobStatus[]> = {
  created: ["paid", "expired"],
  paid: ["assigned", "expired"],
  assigned: ["running", "failed", "expired"],
  running: ["pending", "failed", "expired"],
  pending: ["final", "rejected", "expired"],
  final: [],
  challenged: [], // reserved for a future public-challenge flow
  rejected: ["slashed", "refunded"],
  slashed: ["refunded"],
  refunded: [],
  expired: ["refunded"],
  failed: ["refunded"],
};

export function canTransition(from: JobStatus, to: JobStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function isTerminal(status: JobStatus): boolean {
  return TRANSITIONS[status].length === 0;
}

export class InvalidTransitionError extends Error {
  constructor(
    public readonly from: JobStatus,
    public readonly to: JobStatus,
  ) {
    super(`invalid job status transition: ${from} -> ${to}`);
    this.name = "InvalidTransitionError";
  }
}

export function assertTransition(from: JobStatus, to: JobStatus): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}
