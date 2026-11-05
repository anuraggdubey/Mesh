import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encode, flushHcs, hashscanTopicUrl, hcsConfigured, MAX_MESSAGE_BYTES, toAudit } from "./hcs";
import type { AuditMessage, EventRow } from "./hcs";
import { buildJob, appendEvent, getJob, insertJob, transitionJob } from "./jobs";
import { getDb } from "./db";
import { resetEnvCache } from "./env";
import { setupTestEnv, TEST_REQUESTER } from "./testing";

const ev = (type: string, data: Record<string, unknown>): EventRow => ({ id: 1, jobId: "0x" + "ab".repeat(32), type, data, ts: 1_700_000_000 });

describe("HCS audit log", () => {
  let cleanup: () => void;
  beforeEach(() => {
    cleanup = setupTestEnv();
  });
  afterEach(() => cleanup());

  describe("event mapping", () => {
    it("maps the events that matter to the spec's message types", () => {
      expect(toAudit(ev("payment", { transaction: "0.0.1@2.3" }))?.t).toBe("PAID");
      expect(toAudit(ev("assigned", { providers: [] }))?.t).toBe("ASSIGNED");
      expect(toAudit(ev("claim", { merkleRoot: "0x1" }))?.t).toBe("CLAIM");
      expect(toAudit(ev("sample", { k: 16 }))?.t).toBe("SAMPLE");
      expect(toAudit(ev("verdict", { result: "ok" }))?.t).toBe("VERDICT");
      expect(toAudit(ev("approval", { approvalId: "a" }))?.t).toBe("APPROVAL");
      expect(toAudit(ev("settlement", { kind: "released" }))?.t).toBe("RELEASE");
      expect(toAudit(ev("settlement", { kind: "slashed" }))?.t).toBe("SLASH");
      expect(toAudit(ev("settlement", { kind: "refunded" }))?.t).toBe("REFUND");
    });

    it("leaves out noise: tiles, progress, status changes, chain bookkeeping, errors, unknown settlement kinds", () => {
      for (const t of ["tile", "progress", "status", "chain", "error"]) expect(toAudit(ev(t, {}))).toBeNull();
      expect(toAudit(ev("settlement", { kind: "mystery" }))).toBeNull();
    });

    it("carries the provider claim signatures on the CLAIM message", () => {
      const m = toAudit(ev("claim", { merkleRoot: "0x1" }), { signatures: [{ provider: "0xp", signature: "0xs" }] });
      expect(m?.data.signatures).toEqual([{ provider: "0xp", signature: "0xs" }]);
    });

    it("keeps every message under 1 KB, replacing oversized data with its digest", () => {
      const small = encode({ v: 1, t: "PAID", jobId: "0x1", ts: 1, data: { a: 1 } });
      expect(JSON.parse(small).data).toEqual({ a: 1 });
      const big = encode({ v: 1, t: "SAMPLE", jobId: "0x1", ts: 1, data: { blob: "x".repeat(5000) } });
      expect(Buffer.byteLength(big)).toBeLessThanOrEqual(MAX_MESSAGE_BYTES);
      expect(JSON.parse(big).data).toMatchObject({ truncated: true, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    });
  });

  describe("flush", () => {
    function jobWithEvents(): string {
      const job = insertJob(buildJob({ type: "render", preset: "tiny", requester: TEST_REQUESTER }));
      transitionJob(job.jobId, "paid"); // status event: not published
      appendEvent(job.jobId, "payment", { transaction: "0.0.9@1.2", amount: "10000000" });
      appendEvent(job.jobId, "tile", { index: 0 }); // not published
      appendEvent(job.jobId, "assigned", { providers: ["0xa"] });
      return job.jobId;
    }

    const recorder = () => {
      const sent: AuditMessage[] = [];
      let seq = 100;
      return { sent, submit: async (m: string) => (sent.push(JSON.parse(m)), (seq += 1)) };
    };

    it("is a no-op when no topic is configured", async () => {
      jobWithEvents();
      expect(hcsConfigured()).toBe(false);
      expect((await flushHcs()).published).toEqual([]);
    });

    it("publishes in order, stores sequence numbers on the job, and publishes each event once", async () => {
      const id = jobWithEvents();
      const r = recorder();
      const first = await flushHcs({ submit: r.submit });
      expect(first.published.map((p) => p.type)).toEqual(["PAID", "ASSIGNED"]);
      expect(r.sent.map((m) => m.t)).toEqual(["PAID", "ASSIGNED"]);
      expect(r.sent[0]).toMatchObject({ v: 1, jobId: id, data: { transaction: "0.0.9@1.2" } });
      expect(getJob(id)?.hcsSequence).toEqual([101, 102]);

      const second = await flushHcs({ submit: r.submit });
      expect(second.published).toEqual([]);
      expect(r.sent).toHaveLength(2);
    });

    it("keeps order and retries when the network fails mid-way", async () => {
      const id = jobWithEvents();
      let calls = 0;
      const sent: string[] = [];
      const flaky = async (m: string) => {
        calls += 1;
        if (calls === 2) throw new Error("hedera node busy");
        sent.push(JSON.parse(m).t);
        return calls;
      };
      const a = await flushHcs({ submit: flaky });
      expect(a.error).toBe("hedera node busy");
      expect(sent).toEqual(["PAID"]);
      const b = await flushHcs({ submit: flaky });
      expect(b.error).toBeNull();
      expect(sent).toEqual(["PAID", "ASSIGNED"]); // ASSIGNED was not lost or reordered
      expect(getJob(id)?.hcsSequence).toHaveLength(2);
    });

    it("only publishes events written after they exist (a late event is picked up on the next flush)", async () => {
      const id = jobWithEvents();
      const r = recorder();
      await flushHcs({ submit: r.submit });
      appendEvent(id, "verdict", { result: "ok" });
      appendEvent(id, "settlement", { kind: "released", tx: "0xabc" });
      await flushHcs({ submit: r.submit });
      expect(r.sent.map((m) => m.t)).toEqual(["PAID", "ASSIGNED", "VERDICT", "RELEASE"]);
    });

    it("marks skipped events so they are not rescanned", async () => {
      jobWithEvents();
      await flushHcs({ submit: recorder().submit });
      const left = getDb().prepare("SELECT COUNT(*) AS n FROM job_events WHERE hcs_seq IS NULL").get() as { n: number };
      expect(left.n).toBe(0);
    });
  });

  it("builds a HashScan topic link", () => {
    expect(hashscanTopicUrl("0.0.1234", 296)).toBe("https://hashscan.io/testnet/topic/0.0.1234");
    expect(hashscanTopicUrl("0.0.1234", 295)).toBe("https://hashscan.io/mainnet/topic/0.0.1234");
  });

  it("is configured only with a topic and the API key", () => {
    process.env.HCS_TOPIC_ID = "0.0.5555";
    resetEnvCache();
    expect(hcsConfigured()).toBe(false);
    process.env.API_PRIVATE_KEY = "0x" + "11".repeat(32);
    resetEnvCache();
    expect(hcsConfigured()).toBe(true);
  });
});
