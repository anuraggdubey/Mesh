import { describe, expect, it } from "vitest";
import { colorizeTile, iterationColor } from "./colorize";
import { formatDuration, formatToken, shortAddr, shortHash } from "./format";
import { buildTimeline, initialViewState, ownerTileCounts, reduceJobView, renderGeometry } from "./job-view";
import type { ViewAction } from "./job-view";
import { buildJob } from "../jobs";
import { TEST_REQUESTER, setupTestEnv } from "../testing";
import type { JobStatus } from "../constants";
import type { Job } from "../types";

const A = "0x6834228cb6F180C05fA2154a2B2670d92c4FDf59";
const B = "0xC4975d7b34275346d3a6D16C3E4B4Bb68c7dF645";

function tinyJob(): Job {
  const cleanup = setupTestEnv();
  try {
    return buildJob({ type: "render", preset: "tiny", requester: TEST_REQUESTER });
  } finally {
    cleanup();
  }
}

const ev = (id: number, name: string, data: Record<string, unknown> = {}): ViewAction => ({ type: "event", id, name, data });

describe("colorize", () => {
  it("paints points inside the set (n >= maxIter) black and others non-black", () => {
    expect(iterationColor(500, 500)).toEqual([0, 0, 0]);
    expect(iterationColor(900, 500)).toEqual([0, 0, 0]);
    const [r, g, b] = iterationColor(3, 500);
    expect(r + g + b).toBeGreaterThan(0);
  });

  it("is deterministic and brighter further from the set", () => {
    expect(iterationColor(100, 1000)).toEqual(iterationColor(100, 1000));
    const lum = (c: number[]) => c[0] + c[1] + c[2];
    expect(lum(iterationColor(400, 1000))).toBeGreaterThan(lum(iterationColor(2, 1000)));
  });

  it("decodes uint16 little-endian pixels into opaque RGBA", () => {
    // pixel 0: n=500 (0x01F4 -> bytes F4 01) = black at maxIter 500; pixel 1: n=1
    const out = colorizeTile(new Uint8Array([0xf4, 0x01, 0x01, 0x00]), 500);
    expect(out).toHaveLength(8);
    expect([...out.slice(0, 4)]).toEqual([0, 0, 0, 255]);
    expect(out[7]).toBe(255);
    expect(out[4] + out[5] + out[6]).toBeGreaterThan(0);
  });

  it("produces 4 bytes per 2 input bytes for a real tile size", () => {
    expect(colorizeTile(new Uint8Array(32 * 32 * 2), 500)).toHaveLength(32 * 32 * 4);
  });
});

describe("format", () => {
  it("shortens addresses and hashes", () => {
    expect(shortAddr(A)).toBe("0x6834…Df59");
    expect(shortAddr(null)).toBe("unassigned");
    expect(shortHash(`0x${"ab".repeat(32)}`)).toBe("abababab…");
    expect(shortHash(null)).toBe("-");
  });

  it("formats token amounts", () => {
    expect(formatToken("500000")).toBe("0.5 mUSD");
    expect(formatToken("1000000")).toBe("1 mUSD");
    expect(formatToken("100000")).toBe("0.1 mUSD");
    expect(formatToken("1")).toBe("0.000001 mUSD");
    expect(formatToken("12345678")).toBe("12.345678 mUSD");
    expect(formatToken("oops")).toBe("oops mUSD");
  });

  it("formats durations", () => {
    expect(formatDuration(45)).toBe("45s");
    expect(formatDuration(125)).toBe("2m 5s");
  });
});

describe("job view reducer", () => {
  it("seeds from a snapshot", () => {
    const job = tinyJob();
    const s = reduceJobView(initialViewState, { type: "snapshot", job });
    expect(s.total).toBe(4);
    expect(s.tiles).toHaveLength(4);
    expect(s.tiles.every((t) => t.status === "pending")).toBe(true);
    expect(s.status).toBe("created");
    expect(renderGeometry(job)).toMatchObject({ tileW: 32, tileH: 32, maxIter: 500 });
  });

  it("applies tile, progress and claim events", () => {
    let s = reduceJobView(initialViewState, { type: "snapshot", job: tinyJob() });
    s = reduceJobView(s, ev(1, "assigned", { providers: [A, B], tileCount: 4 }));
    s = reduceJobView(s, ev(2, "tile", { index: 1, owner: B, tileHash: "h1" }));
    s = reduceJobView(s, ev(3, "progress", { done: 1, total: 4 }));
    s = reduceJobView(s, ev(4, "claim", { claimTx: null, merkleRoot: "0xroot", windowEnd: 123 }));
    expect(s.providers).toEqual([A, B]);
    expect(s.tiles[1]).toEqual({ status: "uploaded", owner: B, tileHash: "h1" });
    expect(s.done).toBe(1);
    expect(s.merkleRoot).toBe("0xroot");
    expect(s.windowEnd).toBe(123);
    expect(s.claimTx).toBeNull();
    expect(s.log[0].kind).toBe("good");
  });

  it("applies each event id at most once (replays after reconnect are harmless)", () => {
    let s = reduceJobView(initialViewState, { type: "snapshot", job: tinyJob() });
    s = reduceJobView(s, ev(5, "tile", { index: 0, owner: A, tileHash: "h" }));
    const logLen = s.log.length;
    const again = reduceJobView(s, ev(5, "tile", { index: 0, owner: A, tileHash: "h" }));
    const older = reduceJobView(s, ev(3, "progress", { done: 99, total: 4 }));
    expect(again).toBe(s);
    expect(older).toBe(s);
    expect(again.log).toHaveLength(logLen);
  });

  it("records status changes in order without duplicates, and errors", () => {
    let s = reduceJobView(initialViewState, { type: "snapshot", job: tinyJob() });
    for (const [i, st] of (["paid", "assigned", "running", "running"] as JobStatus[]).entries()) {
      s = reduceJobView(s, ev(i + 1, "status", { status: st }));
    }
    expect(s.statuses).toEqual(["created", "paid", "assigned", "running"]);
    expect(s.status).toBe("running");
    s = reduceJobView(s, ev(9, "error", { code: "crash", message: "boom" }));
    expect(s.error).toEqual({ code: "crash", message: "boom" });
    expect(s.log[0].kind).toBe("bad");
  });

  it("grows the tile list for a tile event that arrives before the snapshot", () => {
    const s = reduceJobView(initialViewState, ev(1, "tile", { index: 2, owner: A, tileHash: "x" }));
    expect(s.tiles).toHaveLength(3);
    expect(s.tiles[2].status).toBe("uploaded");
    expect(s.tiles[0].status).toBe("pending");
  });

  it("keeps the log bounded", () => {
    let s = initialViewState;
    for (let i = 1; i <= 100; i++) s = reduceJobView(s, ev(i, "tile", { index: i % 4, owner: A, tileHash: "h" }));
    expect(s.log.length).toBeLessThanOrEqual(40);
  });

  it("counts tiles per owner", () => {
    const counts = ownerTileCounts([
      { status: "uploaded", owner: A, tileHash: "1" },
      { status: "assigned", owner: B, tileHash: null },
      { status: "uploaded", owner: A, tileHash: "2" },
      { status: "pending", owner: null, tileHash: null },
    ]);
    expect(counts).toEqual({ [A]: 2, [B]: 1 });
  });
});

describe("timeline", () => {
  const states = (status: JobStatus, seen: JobStatus[]) => buildTimeline(status, seen).map((s) => `${s.key}:${s.state}`);

  it("is all todo before a status is known", () => {
    expect(buildTimeline(null, []).every((s) => s.state === "todo")).toBe(true);
  });

  it("marks progress through the happy path", () => {
    expect(states("created", ["created"])).toEqual(["created:current", "paid:todo", "assigned:todo", "running:todo", "pending:todo", "final:todo"]);
    expect(states("running", ["created", "paid", "assigned", "running"])).toEqual([
      "created:done",
      "paid:done",
      "assigned:done",
      "running:current",
      "pending:todo",
      "final:todo",
    ]);
  });

  it("finishes cleanly on final", () => {
    const t = buildTimeline("final", ["created", "paid", "assigned", "running", "pending", "final"]);
    expect(t.every((s) => s.state === "done")).toBe(true);
  });

  it("replaces `final` with failure steps when the job goes wrong", () => {
    const t = buildTimeline("failed", ["created", "paid", "assigned", "running", "failed"]);
    expect(t.map((s) => s.key)).toEqual(["created", "paid", "assigned", "running", "pending", "failed"]);
    expect(t[t.length - 1].state).toBe("failed");
    expect(t.find((s) => s.key === "running")?.state).toBe("done");
  });

  it("shows fraud, slash and refund as completed steps once refunded", () => {
    const t = buildTimeline("refunded", ["created", "paid", "assigned", "running", "pending", "rejected", "slashed", "refunded"]);
    expect(t.map((s) => s.key).slice(-3)).toEqual(["rejected", "slashed", "refunded"]);
    expect(t.every((s) => s.state === "done" || s.state === "todo")).toBe(true);
    expect(t[t.length - 1].state).toBe("done");
    expect(t.some((s) => s.state === "failed")).toBe(false);
  });
});
