import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/server", () => ({ connection: async () => {} }));

import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { POST as verdictPost } from "@/app/api/verifier/verdict/route";
import { resetEnvCache } from "./env";
import { buildJob, getJob, insertJob, listEvents, transitionJob } from "./jobs";
import { ANVIL_KEYS } from "./local-chain";
import { setupTestEnv, TEST_REQUESTER } from "./testing";
import { resetVerifierCache, verdictMessage } from "./verifier";

const verifier = privateKeyToAccount(ANVIL_KEYS[2] as Hex);
const stranger = privateKeyToAccount(ANVIL_KEYS[5] as Hex);
const TX_A = "0x" + "aa".repeat(32);
const now = () => Math.floor(Date.now() / 1000);

function pendingJob(): string {
  const job = insertJob(buildJob({ type: "render", preset: "tiny", requester: TEST_REQUESTER }));
  for (const s of ["paid", "assigned", "running", "pending"] as const) transitionJob(job.jobId, s);
  return job.jobId;
}

async function report(jobId: string, result: "ok" | "fraud", extra: Record<string, unknown> = {}, opts: { signer?: typeof verifier; timestamp?: number } = {}) {
  const timestamp = opts.timestamp ?? now();
  const signature = await (opts.signer ?? verifier).signMessage({ message: verdictMessage(jobId, result, timestamp) });
  const res = await verdictPost(new Request("http://x/api/verifier/verdict", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jobId, result, timestamp, signature, ...extra }) }));
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const fraud = { tileIndex: 17, owner: TEST_REQUESTER, expectedTileHash: "0x" + "11".repeat(32), claimedTileHash: "0x" + "22".repeat(32), proof: [] };
const sample = { beacon: "0x" + "bb".repeat(32), seed: "0x" + "cc".repeat(32), k: 16, indices: [1, 2, 3] };

describe("POST /api/verifier/verdict", () => {
  let cleanup: () => void;
  beforeEach(() => {
    cleanup = setupTestEnv();
    process.env.VERIFIER_ADDRESS = verifier.address;
    resetEnvCache();
    resetVerifierCache();
  });
  afterEach(() => cleanup());

  describe("authentication", () => {
    it("rejects a verdict signed by anyone but the verifier", async () => {
      const id = pendingJob();
      const r = await report(id, "ok", {}, { signer: stranger });
      expect(r.status).toBe(401);
      expect(r.body.error).toBe("unauthorized");
      expect(getJob(id)?.verdict).toBeNull();
    });

    it("rejects a signature made for a different result, so 'ok' cannot be flipped to 'fraud'", async () => {
      const id = pendingJob();
      const timestamp = now();
      const signature = await verifier.signMessage({ message: verdictMessage(id, "ok", timestamp) });
      const res = await verdictPost(new Request("http://x", { method: "POST", body: JSON.stringify({ jobId: id, result: "fraud", timestamp, signature, fraud }) }));
      expect(res.status).toBe(401);
      expect(getJob(id)?.status).toBe("pending");
    });

    it("rejects a stale timestamp (replay of an old signed verdict)", async () => {
      const id = pendingJob();
      const r = await report(id, "ok", {}, { timestamp: now() - 3600 });
      expect(r.status).toBe(401);
      expect(r.body.error).toBe("stale_timestamp");
    });

    it("rejects a malformed signature or body with 400", async () => {
      const id = pendingJob();
      const bad = await verdictPost(new Request("http://x", { method: "POST", body: JSON.stringify({ jobId: id, result: "ok", timestamp: now(), signature: "nope" }) }));
      expect(bad.status).toBe(400);
      const bad2 = await verdictPost(new Request("http://x", { method: "POST", body: "{broken" }));
      expect(bad2.status).toBe(400);
    });

    it("answers 503 when no verifier address is known", async () => {
      process.env.VERIFIER_ADDRESS = "";
      process.env.RECEIPT_ADDRESS = "";
      resetEnvCache();
      resetVerifierCache();
      const r = await report(pendingJob(), "ok");
      expect(r.status).toBe(503);
      expect(r.body.error).toBe("verifier_unknown");
    });
  });

  describe("an ok verdict", () => {
    it("records the verdict and sample, leaves the job pending for the chain loop to finalize", async () => {
      const id = pendingJob();
      const r = await report(id, "ok", { sample });
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ status: "pending", verdict: "ok" });
      expect(getJob(id)?.sample).toMatchObject({ k: 16 });
      expect(listEvents(id).map((e) => e.type)).toContain("verdict");
    });

    it("finalizes when the verifier reports it already did", async () => {
      const id = pendingJob();
      const r = await report(id, "ok", { finalizeTx: TX_A });
      expect(r.body.status).toBe("final");
      expect(getJob(id)).toMatchObject({ finalTx: TX_A, releaseTx: TX_A });
    });

    it("is idempotent: the same verdict twice changes nothing", async () => {
      const id = pendingJob();
      await report(id, "ok");
      const again = await report(id, "ok");
      expect(again.status).toBe(200);
      expect(listEvents(id).filter((e) => e.type === "verdict")).toHaveLength(1);
    });
  });

  describe("a fraud verdict", () => {
    it("without the fraud details is rejected, and the job is untouched", async () => {
      const id = pendingJob();
      const r = await report(id, "fraud");
      expect(r.status).toBe(400);
      expect(r.body.error).toBe("fraud_details_missing");
      expect(getJob(id)?.status).toBe("pending");
    });

    it("with the on-chain fraud tx slashes the provider and refunds the requester (rejected -> slashed -> refunded)", async () => {
      const id = pendingJob();
      const r = await report(id, "fraud", { fraud, fraudTx: TX_A, sample });
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ status: "refunded", verdict: "fraud" });
      expect(getJob(id)).toMatchObject({ fraudTx: TX_A, slashTx: TX_A, refundTx: TX_A });
      const events = listEvents(id);
      expect(events.find((e) => e.type === "verdict")?.data).toMatchObject({ result: "fraud", tileIndex: 17, owner: TEST_REQUESTER });
      expect(events.filter((e) => e.type === "settlement").map((e) => (e.data as { kind: string }).kind)).toEqual(["slashed", "refunded"]);
    });

    it("without a fraud tx stays rejected until the chain confirms it", async () => {
      const id = pendingJob();
      const r = await report(id, "fraud", { fraud });
      expect(r.body.status).toBe("rejected");
    });

    it("cannot be flipped to ok afterwards", async () => {
      const id = pendingJob();
      await report(id, "fraud", { fraud, fraudTx: TX_A });
      const r = await report(id, "ok");
      expect(r.status).toBe(409);
      expect(getJob(id)?.status).toBe("refunded");
    });
  });

  it("404 for an unknown job, 409 for a job that is not pending", async () => {
    expect((await report("0x" + "ab".repeat(32), "ok")).status).toBe(404);
    const job = insertJob(buildJob({ type: "render", preset: "tiny", requester: TEST_REQUESTER }));
    const r = await report(job.jobId, "ok");
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("invalid_state");
  });
});
