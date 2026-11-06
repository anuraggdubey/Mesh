import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/server", () => ({ connection: async () => {} }));

import { GET as receiptGet } from "@/app/api/receipts/[jobId]/route";
import { POST as reviewPost } from "@/app/api/jobs/[id]/review/route";
import { getDb } from "./db";
import { resetEnvCache } from "./env";
import { FAKE_OG_KEY, FAKE_OG_SIGNER, startFakeOg } from "./fake-og";
import type { FakeOg } from "./fake-og";
import { flushHcs, toAudit } from "./hcs";
import { appendEvent, buildJob, getJob, insertJob, listEvents, transitionJob } from "./jobs";
import { autoReview, MAX_REVIEW_ATTEMPTS, resetReviewAttempts, reviewJob } from "./review";
import { setupTestEnv, TEST_REQUESTER } from "./testing";

const sleep = async () => {};
const deps = () => ({ fetch: (...a: Parameters<typeof fetch>) => fetch(...a), sleep });

function jobAt(status: "final" | "pending", withTiles = true): string {
  const job = insertJob(buildJob({ type: "render", preset: "tiny", requester: TEST_REQUESTER }));
  for (const s of ["paid", "assigned", "running", "pending"] as const) transitionJob(job.jobId, s);
  if (status === "final") transitionJob(job.jobId, "final");
  if (withTiles) {
    const db = getDb();
    for (let i = 0; i < 4; i += 1) db.prepare("INSERT INTO job_tiles (job_id, idx, tile_hash, bytes) VALUES (?, ?, ?, ?)").run(job.jobId, i, "h" + i, Buffer.alloc(32 * 32 * 2, i + 1));
  }
  return job.jobId;
}

const call = (id: string) => reviewPost(new Request(`http://x/api/jobs/${id}/review`, { method: "POST" }), { params: Promise.resolve({ id }) });

describe("AI review of a finished render (0G)", () => {
  let fake: FakeOg;
  let cleanup: () => void;
  beforeAll(async () => {
    fake = await startFakeOg();
  });
  afterAll(() => fake.stop());
  beforeEach(() => {
    cleanup = setupTestEnv();
    Object.assign(process.env, { OG_API_KEY: FAKE_OG_KEY, OG_API_BASE_URL: fake.url, OG_SIGNATURE_BASE_URL: fake.origin, OG_SIGNER_ADDRESS: FAKE_OG_SIGNER, OG_TIMEOUT_MS: "1500" });
    resetEnvCache();
    Object.assign(fake, { mode: "ok", tee: true, noRequestId: false, signature: "good" });
    fake.requests.length = 0;
    resetReviewAttempts();
  });
  afterEach(() => cleanup());

  const chatCalls = () => fake.requests.filter((r) => r.path === "/v1/chat/completions").length;

  it("reviews a final job: stores the record, an inference event and shows the 0G request id", async () => {
    const id = jobAt("final");
    const { inference, cached } = await reviewJob(id, deps());
    expect(cached).toBe(false);
    expect(inference).toMatchObject({ requestId: "req_0g_123456", verification: "tee-signature" });
    expect(getJob(id)?.inference?.requestId).toBe("req_0g_123456");
    const ev = listEvents(id).find((e) => e.type === "inference");
    expect(ev?.data).toMatchObject({ requestId: "req_0g_123456", verification: "tee-signature", quality: "good" });
  });

  it("is idempotent: a second review returns the stored one without calling 0G again", async () => {
    const id = jobAt("final");
    await reviewJob(id, deps());
    const again = await reviewJob(id, deps());
    expect(again.cached).toBe(true);
    expect(chatCalls()).toBe(1);
    expect(listEvents(id).filter((e) => e.type === "inference")).toHaveLength(1);
  });

  it("shares one 0G request between concurrent callers", async () => {
    const id = jobAt("final");
    const [a, b] = await Promise.all([reviewJob(id, deps()), reviewJob(id, deps())]);
    expect(a.inference.requestId).toBe(b.inference.requestId);
    expect(chatCalls()).toBe(1);
  });

  it("refuses a job that is not final, and one with missing tiles, without calling 0G", async () => {
    await expect(reviewJob(jobAt("pending"), deps())).rejects.toMatchObject({ code: "job_not_final", status: 409 });
    await expect(reviewJob(jobAt("final", false), deps())).rejects.toMatchObject({ code: "tiles_missing", status: 409 });
    await expect(reviewJob("0x" + "ab".repeat(32), deps())).rejects.toMatchObject({ code: "job_not_found", status: 404 });
    expect(chatCalls()).toBe(0);
  });

  it("answers 503 when no key is configured", async () => {
    process.env.OG_API_KEY = "";
    resetEnvCache();
    const res = await call(jobAt("final"));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("og_not_configured");
  });

  describe("POST /api/jobs/:id/review", () => {
    it("200 with the review, then 200 cached", async () => {
      const id = jobAt("final");
      const first = await call(id);
      expect(first.status).toBe(200);
      expect(await first.json()).toMatchObject({ cached: false, inference: { requestId: "req_0g_123456" } });
      expect(await (await call(id)).json()).toMatchObject({ cached: true });
    });

    it("400 for a bad id, 404 unknown, 409 not final", async () => {
      expect((await call("nope")).status).toBe(400);
      expect((await call("0x" + "cd".repeat(32))).status).toBe(404);
      expect((await call(jobAt("pending"))).status).toBe(409);
    });

    it("maps a 0G rate limit to 429 with Retry-After, and an outage to 502, never leaking the key", async () => {
      const id = jobAt("final");
      fake.mode = "rate-limit-always";
      const limited = await call(id);
      expect(limited.status).toBe(429);
      expect(limited.headers.get("retry-after")).toBe("1");
      fake.mode = "error";
      const down = await call(id);
      expect(down.status).toBe(502);
      expect(JSON.stringify(await down.json())).not.toContain(FAKE_OG_KEY);
      expect(getJob(id)?.inference).toBeNull(); // a failed call leaves nothing behind, so it can be retried
    }, 20_000);
  });

  it("puts the request id on the receipt and an INFERENCE message (without the description) on HCS", async () => {
    const id = jobAt("final");
    await reviewJob(id, deps());
    const receipt = await (await receiptGet(new Request("http://x"), { params: Promise.resolve({ jobId: id }) })).json();
    expect(receipt.inference).toMatchObject({ requestId: "req_0g_123456", verification: "tee-signature", quality: "good" });

    const sent: string[] = [];
    await flushHcs({ submit: async (m) => (sent.push(m), sent.length) });
    const msg = sent.map((m) => JSON.parse(m)).find((m) => m.t === "INFERENCE");
    expect(msg).toMatchObject({ v: 1, jobId: id, data: { requestId: "req_0g_123456", verification: "tee-signature" } });
    expect(JSON.stringify(msg)).not.toContain("Mandelbrot");
    expect(getJob(id)?.hcsSequence.length).toBeGreaterThan(0);
    expect(toAudit({ id: 1, jobId: id, type: "inference", data: { requestId: "r" }, ts: 1 })?.t).toBe("INFERENCE");
  });

  describe("automatic review (chain loop)", () => {
    it("does nothing unless OG_ENABLED is on", async () => {
      jobAt("final");
      expect((await autoReview(2, deps())).reviewed).toEqual([]);
      expect(chatCalls()).toBe(0);
    });

    it("reviews new final jobs only once, and gives up on a job after a few failures", async () => {
      process.env.OG_ENABLED = "true";
      resetEnvCache();
      const ok = jobAt("final");
      expect((await autoReview(2, deps())).reviewed).toEqual([ok]);
      expect((await autoReview(2, deps())).reviewed).toEqual([]); // already reviewed

      fake.mode = "error";
      const bad = jobAt("final");
      for (let i = 0; i < MAX_REVIEW_ATTEMPTS + 2; i += 1) await autoReview(2, deps());
      const failed = fake.requests.length;
      expect(getJob(bad)?.inference).toBeNull();
      await autoReview(2, deps());
      expect(fake.requests.length).toBe(failed); // stopped trying
    });

    it("ignores jobs that are not final", async () => {
      process.env.OG_ENABLED = "true";
      resetEnvCache();
      jobAt("pending");
      expect((await autoReview(2, deps())).reviewed).toEqual([]);
      appendEvent(jobAt("final"), "noop");
    });
  });
});
