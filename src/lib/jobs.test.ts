import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getEnv, resetEnvCache } from "./env";
import { canTransition, InvalidTransitionError, isTerminal } from "./state-machine";
import {
  appendEvent,
  buildJob,
  expireUnpaidJobs,
  getJob,
  insertJob,
  JobNotFoundError,
  listEvents,
  listJobs,
  transitionJob,
  UnsupportedJobTypeError,
  updateJob,
} from "./jobs";
import { getDb } from "./db";
import { renderInputHash } from "./render-input";
import { TEST_REQUESTER, setupTestEnv } from "./testing";

describe("state machine", () => {
  it("allows the documented happy path", () => {
    const path = ["created", "paid", "assigned", "running", "pending", "final"] as const;
    for (let i = 0; i < path.length - 1; i++) expect(canTransition(path[i], path[i + 1])).toBe(true);
  });

  it("allows the fraud and failure paths", () => {
    expect(canTransition("pending", "rejected")).toBe(true);
    expect(canTransition("rejected", "slashed")).toBe(true);
    expect(canTransition("slashed", "refunded")).toBe(true);
    expect(canTransition("running", "failed")).toBe(true);
    expect(canTransition("failed", "refunded")).toBe(true);
    expect(canTransition("paid", "expired")).toBe(true);
    expect(canTransition("expired", "refunded")).toBe(true);
  });

  it("rejects skipping steps and going backwards", () => {
    expect(canTransition("created", "running")).toBe(false);
    expect(canTransition("created", "final")).toBe(false);
    expect(canTransition("paid", "created")).toBe(false);
    expect(canTransition("final", "pending")).toBe(false);
    expect(canTransition("final", "rejected")).toBe(false);
    expect(canTransition("refunded", "paid")).toBe(false);
    expect(canTransition("pending", "refunded")).toBe(false); // must go through rejected/expired
  });

  it("knows terminal states", () => {
    expect(isTerminal("final")).toBe(true);
    expect(isTerminal("refunded")).toBe(true);
    expect(isTerminal("pending")).toBe(false);
  });
});

describe("env", () => {
  let cleanup: () => void;
  beforeEach(() => {
    cleanup = setupTestEnv();
  });
  afterEach(() => cleanup());

  it("applies defaults and treats blank values as unset", () => {
    process.env.HEDERA_RPC_URL = "";
    process.env.RECEIPT_ADDRESS = "";
    resetEnvCache();
    const env = getEnv();
    expect(env.HEDERA_RPC_URL).toBe("https://testnet.hashio.io/api");
    expect(env.HEDERA_CHAIN_ID).toBe(296);
    expect(env.RECEIPT_ADDRESS).toBeUndefined();
    expect(env.MESH_DEV_SKIP_PAYMENT).toBe(false);
    delete process.env.HEDERA_RPC_URL;
    delete process.env.RECEIPT_ADDRESS;
  });

  it("reports every invalid variable", () => {
    process.env.ESCROW_ADDRESS = "not-an-address";
    process.env.MESH_DEV_SKIP_PAYMENT = "maybe";
    resetEnvCache();
    expect(() => getEnv()).toThrowError(/ESCROW_ADDRESS[\s\S]*MESH_DEV_SKIP_PAYMENT|MESH_DEV_SKIP_PAYMENT[\s\S]*ESCROW_ADDRESS/);
  });
});

describe("jobs store", () => {
  let cleanup: () => void;
  beforeEach(() => {
    cleanup = setupTestEnv();
  });
  afterEach(() => cleanup());

  const make = () => insertJob(buildJob({ type: "render", preset: "small", requester: TEST_REQUESTER }));

  it("builds a render job matching the spec", () => {
    const job = buildJob({ type: "render", preset: "small", requester: TEST_REQUESTER });
    expect(job.jobId).toMatch(/^0x[0-9a-f]{64}$/);
    expect(job.status).toBe("created");
    expect(job.mode).toBe("deterministic");
    expect(job.tileCount).toBe(64);
    expect(job.tiles).toHaveLength(64);
    expect(job.tiles[0]).toEqual({ index: 0, owner: null, status: "pending", tileHash: null });
    expect(job.inputHash).toBe(renderInputHash("small"));
    expect(job.price).toBe("500000");
    expect(job.params).toMatchObject({ preset: "small", width: 2048, maxIter: 6000 });
  });

  it("tiny preset has 4 tiles (a power of two)", () => {
    const job = buildJob({ type: "render", preset: "tiny", requester: TEST_REQUESTER });
    expect(job.tileCount).toBe(4);
  });

  it("job ids are unique", () => {
    const ids = new Set(Array.from({ length: 50 }, () => buildJob({ type: "render", preset: "tiny", requester: TEST_REQUESTER }).jobId));
    expect(ids.size).toBe(50);
  });

  it("refuses job types that are not wired up yet", () => {
    expect(() => buildJob({ type: "matmul", preset: "small", requester: TEST_REQUESTER })).toThrow(UnsupportedJobTypeError);
  });

  it("stores and reads a job back unchanged", () => {
    const job = make();
    expect(getJob(job.jobId)).toEqual(job);
    expect(getJob("0x" + "ab".repeat(32))).toBeNull();
  });

  it("logs a status event on insert", () => {
    const job = make();
    const events = listEvents(job.jobId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "status", data: { status: "created" } });
  });

  it("transitions a job and records the event trail in order", () => {
    const job = make();
    transitionJob(job.jobId, "paid");
    transitionJob(job.jobId, "assigned", { providers: ["0x6834228cb6F180C05fA2154a2B2670d92c4FDf59"] });
    const got = getJob(job.jobId)!;
    expect(got.status).toBe("assigned");
    expect(got.providers).toHaveLength(1);
    expect(listEvents(job.jobId).map((e) => e.data.status)).toEqual(["created", "paid", "assigned"]);
  });

  it("rejects an invalid transition and leaves the job and events untouched", () => {
    const job = make();
    expect(() => transitionJob(job.jobId, "final")).toThrow(InvalidTransitionError);
    expect(getJob(job.jobId)!.status).toBe("created");
    expect(listEvents(job.jobId)).toHaveLength(1);
  });

  it("throws for an unknown job", () => {
    expect(() => transitionJob("0x" + "cd".repeat(32), "paid")).toThrow(JobNotFoundError);
    expect(() => updateJob("0x" + "cd".repeat(32), {})).toThrow(JobNotFoundError);
  });

  it("updateJob merges fields without changing the id", () => {
    const job = make();
    const next = updateJob(job.jobId, { merkleRoot: "0x" + "11".repeat(32), jobId: "0xhacked" });
    expect(next.jobId).toBe(job.jobId);
    expect(getJob(job.jobId)!.merkleRoot).toBe("0x" + "11".repeat(32));
  });

  it("lists events after a given id (SSE resume)", () => {
    const job = make();
    const first = listEvents(job.jobId)[0];
    appendEvent(job.jobId, "tile", { index: 0 });
    appendEvent(job.jobId, "tile", { index: 1 });
    const after = listEvents(job.jobId, first.id);
    expect(after.map((e) => e.data.index)).toEqual([0, 1]);
    expect(after[0].id).toBeGreaterThan(first.id);
  });

  it("listJobs returns newest first", () => {
    const a = make();
    const b = make();
    expect(listJobs().map((j) => j.jobId)).toEqual([b.jobId, a.jobId]);
  });

  it("expires only unpaid jobs older than the TTL", () => {
    const old = make();
    const fresh = make();
    const paid = make();
    transitionJob(paid.jobId, "paid");
    // age `old` and `paid` past the TTL by rewriting created_at
    const db = getDb();
    for (const j of [old, paid]) {
      const row = getJob(j.jobId)!;
      db.prepare("UPDATE jobs SET created_at = ?, data = ? WHERE job_id = ?").run(
        1,
        JSON.stringify({ ...row, createdAt: 1 }),
        j.jobId,
      );
    }
    expect(expireUnpaidJobs()).toBe(1);
    expect(getJob(old.jobId)!.status).toBe("expired");
    expect(getJob(fresh.jobId)!.status).toBe("created");
    expect(getJob(paid.jobId)!.status).toBe("paid");
  });

  it("a failed transition inside a transaction does not leave a half-written event", () => {
    const job = make();
    const before = listEvents(job.jobId).length;
    try {
      transitionJob(job.jobId, "running");
    } catch {
      // expected
    }
    expect(listEvents(job.jobId)).toHaveLength(before);
  });
});
