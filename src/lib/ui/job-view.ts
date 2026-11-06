import type { JobStatus } from "../constants";
import type { Job } from "../types";

/**
 * Pure state for the live job page. A snapshot (GET /api/jobs/:id) seeds it and Server-Sent Events
 * (docs/job-spec.md section 10.4) update it. Events are idempotent: an event id is applied at most once,
 * so replays after a reconnect never double-count.
 */

export type TileUi = { status: "pending" | "assigned" | "uploaded"; owner: string | null; tileHash: string | null };

export interface LogLine {
  id: number;
  text: string;
  kind: "info" | "good" | "bad";
}

export interface JobViewState {
  job: Job | null;
  status: JobStatus | null;
  statuses: JobStatus[]; // distinct statuses seen, in order
  tiles: TileUi[];
  done: number;
  total: number;
  providers: string[];
  merkleRoot: string | null;
  windowEnd: number | null;
  claimTx: string | null;
  lockTx: string | null;
  finalTx: string | null;
  settlement: "released" | "slashed" | "refunded" | null;
  payment: Job["payment"];
  approvalId: string | null;
  sample: Job["sample"];
  verdict: "ok" | "fraud" | null;
  fraud: NonNullable<Job["fraud"]> | null;
  fraudTx: string | null;
  refundTx: string | null;
  hcsSequence: number[];
  error: { code: string; message: string } | null;
  lastEventId: number;
  log: LogLine[];
}

export const initialViewState: JobViewState = {
  job: null,
  status: null,
  statuses: [],
  tiles: [],
  done: 0,
  total: 0,
  providers: [],
  merkleRoot: null,
  windowEnd: null,
  claimTx: null,
  lockTx: null,
  finalTx: null,
  settlement: null,
  payment: null,
  approvalId: null,
  sample: null,
  verdict: null,
  fraud: null,
  fraudTx: null,
  refundTx: null,
  hcsSequence: [],
  error: null,
  lastEventId: 0,
  log: [],
};

export type ViewAction =
  | { type: "snapshot"; job: Job }
  | { type: "event"; id: number; name: string; data: Record<string, unknown> };

const MAX_LOG = 40;

function pushStatus(statuses: JobStatus[], s: JobStatus): JobStatus[] {
  return statuses.includes(s) ? statuses : [...statuses, s];
}

export function reduceJobView(state: JobViewState, action: ViewAction): JobViewState {
  if (action.type === "snapshot") {
    const { job } = action;
    return {
      ...state,
      job,
      status: job.status,
      statuses: pushStatus(state.statuses, job.status),
      tiles: job.tiles.map((t) => ({
        status: t.status === "uploaded" ? "uploaded" : t.owner ? "assigned" : "pending",
        owner: t.owner,
        tileHash: t.tileHash,
      })),
      done: job.tiles.filter((t) => t.status === "uploaded").length,
      total: job.tileCount,
      providers: job.providers,
      merkleRoot: job.merkleRoot,
      claimTx: job.claimTx,
      lockTx: job.lockTx ?? null,
      finalTx: job.finalTx ?? null,
      windowEnd: job.windowEnd ?? state.windowEnd,
      settlement: job.status === "final" ? "released" : job.status === "refunded" ? "refunded" : job.status === "slashed" ? "slashed" : state.settlement,
      payment: job.payment ?? null,
      approvalId: job.approvalId ?? null,
      sample: job.sample ?? null,
      verdict: job.verdict ?? null,
      fraud: job.fraud ?? null,
      fraudTx: job.fraudTx ?? null,
      refundTx: job.refundTx ?? null,
      hcsSequence: job.hcsSequence ?? [],
    };
  }

  if (action.id <= state.lastEventId) return state; // already applied
  const next: JobViewState = { ...state, lastEventId: action.id };
  const d = action.data;
  const line = (text: string, kind: LogLine["kind"] = "info") => {
    next.log = [{ id: action.id, text, kind }, ...state.log].slice(0, MAX_LOG);
  };

  switch (action.name) {
    case "status": {
      const s = d.status as JobStatus;
      next.status = s;
      next.statuses = pushStatus(state.statuses, s);
      next.job = state.job ? { ...state.job, status: s } : state.job;
      line(`status: ${s}`, s === "rejected" || s === "failed" || s === "expired" ? "bad" : s === "final" ? "good" : "info");
      break;
    }
    case "assigned": {
      const providers = (d.providers as string[]) ?? [];
      next.providers = providers;
      next.total = Number(d.tileCount ?? state.total);
      line(`assigned to ${providers.length} provider${providers.length === 1 ? "" : "s"}`);
      break;
    }
    case "tile": {
      const index = Number(d.index);
      const tiles = [...state.tiles];
      while (tiles.length <= index) tiles.push({ status: "pending", owner: null, tileHash: null });
      tiles[index] = { status: "uploaded", owner: (d.owner as string) ?? null, tileHash: (d.tileHash as string) ?? null };
      next.tiles = tiles;
      line(`tile ${index} computed`);
      break;
    }
    case "progress": {
      next.done = Number(d.done);
      next.total = Number(d.total);
      break;
    }
    case "claim": {
      next.merkleRoot = (d.merkleRoot as string) ?? null;
      next.windowEnd = (d.windowEnd as number) ?? null;
      next.claimTx = (d.claimTx as string | null) ?? state.claimTx;
      line(d.claimTx ? "claim posted on chain; challenge window open" : "all providers signed their claims; Merkle root computed", "good");
      break;
    }
    case "chain": {
      if (d.kind === "locked") {
        next.lockTx = (d.tx as string) ?? "already-locked";
        line("payment locked in escrow on chain", "good");
      } else {
        line(String(d.kind ?? "chain event"));
      }
      break;
    }
    case "settlement": {
      const kind = d.kind === "refunded" ? "refunded" : d.kind === "slashed" ? "slashed" : "released";
      next.settlement = kind;
      if (kind === "released") next.finalTx = (d.tx as string) ?? next.finalTx;
      if (kind === "slashed") next.fraudTx = (d.tx as string) ?? next.fraudTx;
      if (kind === "refunded") next.refundTx = (d.tx as string) ?? next.refundTx;
      line(
        kind === "released" ? "challenge window passed: providers paid from escrow" : kind === "slashed" ? "the cheating provider's stake was slashed" : "payment refunded to the requester",
        kind === "released" ? "good" : kind === "slashed" ? "bad" : "info",
      );
      break;
    }
    case "payment": {
      next.payment = {
        network: String(d.network ?? ""),
        asset: String(d.asset ?? ""),
        amount: String(d.amount ?? ""),
        payer: (d.payer as string | null) ?? null,
        transaction: String(d.transaction ?? ""),
      };
      line("x402 payment settled on Hedera", "good");
      break;
    }
    case "approval": {
      next.approvalId = String(d.approvalId ?? "") || null;
      line("a human approved this job in World", "good");
      break;
    }
    case "sample": {
      next.sample = { beacon: String(d.beacon ?? ""), seed: String(d.seed ?? ""), k: Number(d.k ?? 0), indices: (d.indices as number[]) ?? [] };
      line(`verifier sampled ${next.sample.k} tiles to recompute`);
      break;
    }
    case "verdict": {
      next.verdict = d.result === "fraud" ? "fraud" : "ok";
      if (d.result === "fraud") {
        next.fraud = {
          tileIndex: Number(d.tileIndex),
          owner: String(d.owner ?? ""),
          expectedTileHash: String(d.expectedTileHash ?? ""),
          claimedTileHash: String(d.claimedTileHash ?? ""),
        };
        if (d.fraudTx) next.fraudTx = String(d.fraudTx);
        line(`cheat caught: tile ${next.fraud.tileIndex} does not match the recompute`, "bad");
      } else {
        line("verifier recomputed the sample: all tiles match", "good");
      }
      break;
    }
    case "inference": {
      const quality = String(d.quality ?? "unknown");
      line(`AI review on 0G (request ${String(d.requestId ?? "").slice(0, 12)}): ${quality}`, quality === "good" ? "good" : quality === "unknown" ? "info" : "bad");
      break;
    }
    case "error": {
      next.error = { code: String(d.code ?? "error"), message: String(d.message ?? "") };
      line(`error: ${next.error.code}${next.error.message ? ` (${next.error.message})` : ""}`, "bad");
      break;
    }
    default:
      line(action.name);
  }
  return next;
}

// ───────────────────────── timeline ─────────────────────────

export type StepState = "done" | "current" | "todo" | "failed";
export interface TimelineStep {
  key: string;
  label: string;
  state: StepState;
}

const HAPPY_PATH: { key: JobStatus; label: string }[] = [
  { key: "created", label: "Created" },
  { key: "paid", label: "Paid" },
  { key: "assigned", label: "Assigned" },
  { key: "running", label: "Running" },
  { key: "pending", label: "Verifying" },
  { key: "final", label: "Final" },
];

const FAILURES: JobStatus[] = ["failed", "rejected", "expired", "slashed", "refunded"];
const FAILURE_LABEL: Partial<Record<JobStatus, string>> = {
  failed: "Failed",
  rejected: "Fraud proven",
  expired: "Expired",
  slashed: "Provider slashed",
  refunded: "Refunded",
};

/**
 * Timeline for the page: the happy path, with failure steps appended when the job went wrong.
 * The step matching the current status is "current" (or "failed" for a failure that is still unresolved).
 */
export function buildTimeline(status: JobStatus | null, seen: JobStatus[]): TimelineStep[] {
  if (!status) return HAPPY_PATH.map((s) => ({ key: s.key, label: s.label, state: "todo" as StepState }));

  const wentWrong = FAILURES.some((s) => seen.includes(s));
  const steps: TimelineStep[] = HAPPY_PATH.filter((s) => !(wentWrong && s.key === "final")).map((s) => ({
    key: s.key,
    label: s.label,
    state: seen.includes(s.key) ? (s.key === status ? "current" : "done") : "todo",
  }));

  if (wentWrong) {
    for (const f of FAILURES) {
      if (seen.includes(f)) steps.push({ key: f, label: FAILURE_LABEL[f] ?? f, state: "done" });
    }
    // everything before the latest failure step is done; the latest is "failed" until the refund completes it
    steps.forEach((s) => {
      if (s.state === "current") s.state = "done";
    });
    const last = steps[steps.length - 1];
    last.state = status === "refunded" ? "done" : "failed";
  } else if (status === "final") {
    steps[steps.length - 1].state = "done";
  }
  return steps;
}

export function ownerTileCounts(tiles: TileUi[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of tiles) if (t.owner) out[t.owner] = (out[t.owner] ?? 0) + 1;
  return out;
}

/** Render parameters needed to draw the image, read from the job. */
export function renderGeometry(job: Job) {
  const p = job.params as { width: number; height: number; gridCols: number; gridRows: number; maxIter: number };
  return { ...p, tileW: p.width / p.gridCols, tileH: p.height / p.gridRows };
}
