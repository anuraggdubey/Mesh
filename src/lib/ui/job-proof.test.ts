import { describe, expect, it } from "vitest";
import { formatPayment, hashscan, hederaTxPath } from "./format";
import { initialViewState, reduceJobView } from "./job-view";
import type { ViewAction } from "./job-view";
import { buildJob } from "../jobs";
import { TEST_REQUESTER, setupTestEnv } from "../testing";
import type { Job } from "../types";

const ev = (id: number, name: string, data: Record<string, unknown> = {}): ViewAction => ({ type: "event", id, name, data });

function job(over: Partial<Job> = {}): Job {
  const cleanup = setupTestEnv();
  try {
    return { ...buildJob({ type: "render", preset: "tiny", requester: TEST_REQUESTER }), ...over };
  } finally {
    cleanup();
  }
}

const OWNER = "0x6834228cb6F180C05fA2154a2B2670d92c4FDf59";
const TX = "0x" + "ab".repeat(32);

describe("explorer links", () => {
  it("turns a Hedera transaction id into the HashScan form", () => {
    expect(hederaTxPath("0.0.9185802@1793937163.341350400")).toBe("0.0.9185802-1793937163-341350400");
    expect(hashscan.hederaTx("0.0.9185802@1793937163.341350400")).toBe("https://hashscan.io/testnet/transaction/0.0.9185802-1793937163-341350400");
    expect(hederaTxPath("not-an-id")).toBe("not-an-id");
  });

  it("links an HCS topic", () => {
    expect(hashscan.topic("0.0.11333951")).toBe("https://hashscan.io/testnet/topic/0.0.11333951");
  });

  it("formats an x402 amount in the right unit", () => {
    expect(formatPayment("50000000", "0.0.0")).toBe("0.5 HBAR");
    expect(formatPayment("10000000", "0.0.0")).toBe("0.1 HBAR");
    expect(formatPayment("500000", "0.0.429274")).toBe("0.5 tokens");
  });
});

describe("job view state: payment, approval and evidence", () => {
  it("reads the settled payment, approval, sample, verdict and HCS sequences from the snapshot", () => {
    const j = job({
      status: "final",
      payment: { network: "hedera:testnet", asset: "0.0.0", amount: "50000000", payer: "0.0.5555", transaction: "0.0.9@1.2" },
      approvalId: "11111111-2222-3333-4444-555555555555",
      sample: { beacon: "0xb", seed: "0xs", k: 16, indices: [1, 2, 3] },
      verdict: "ok",
      hcsSequence: [1, 2, 3],
    });
    const s = reduceJobView(initialViewState, { type: "snapshot", job: j });
    expect(s.payment?.transaction).toBe("0.0.9@1.2");
    expect(s.approvalId).toBe("11111111-2222-3333-4444-555555555555");
    expect(s.sample?.k).toBe(16);
    expect(s.verdict).toBe("ok");
    expect(s.hcsSequence).toEqual([1, 2, 3]);
    expect(s.settlement).toBe("released");
  });

  it("applies live payment, approval, sample and ok verdict events", () => {
    let s = reduceJobView(initialViewState, { type: "snapshot", job: job() });
    s = reduceJobView(s, ev(1, "payment", { transaction: "0.0.9@1.2", network: "hedera:testnet", asset: "0.0.0", amount: "10000000", payer: "0.0.5555" }));
    s = reduceJobView(s, ev(2, "approval", { approvalId: "abc" }));
    s = reduceJobView(s, ev(3, "sample", { beacon: "0xb", seed: "0xs", k: 4, indices: [0, 1] }));
    s = reduceJobView(s, ev(4, "verdict", { result: "ok" }));
    expect(s.payment).toMatchObject({ transaction: "0.0.9@1.2", amount: "10000000" });
    expect(s.approvalId).toBe("abc");
    expect(s.sample?.indices).toEqual([0, 1]);
    expect(s.verdict).toBe("ok");
    expect(s.log[0].kind).toBe("good");
  });

  it("does not apply the same event twice", () => {
    let s = reduceJobView(initialViewState, { type: "snapshot", job: job() });
    s = reduceJobView(s, ev(5, "approval", { approvalId: "first" }));
    s = reduceJobView(s, ev(5, "approval", { approvalId: "second" }));
    expect(s.approvalId).toBe("first");
  });
});

describe("job view state: the cheat-caught path", () => {
  it("records the fraud details from the verdict event and marks the log as bad", () => {
    let s = reduceJobView(initialViewState, { type: "snapshot", job: job({ status: "pending" }) });
    s = reduceJobView(s, ev(1, "verdict", { result: "fraud", tileIndex: 18, owner: OWNER, expectedTileHash: "0x" + "11".repeat(32), claimedTileHash: "0x" + "22".repeat(32), fraudTx: TX }));
    expect(s.verdict).toBe("fraud");
    expect(s.fraud).toMatchObject({ tileIndex: 18, owner: OWNER });
    expect(s.fraudTx).toBe(TX);
    expect(s.log[0].kind).toBe("bad");
    expect(s.log[0].text).toContain("tile 18");
  });

  it("tells slashed apart from released and refunded settlements", () => {
    let s = reduceJobView(initialViewState, { type: "snapshot", job: job({ status: "slashed" }) });
    expect(s.settlement).toBe("slashed");
    s = reduceJobView(s, ev(1, "settlement", { kind: "slashed", tx: TX }));
    expect(s.settlement).toBe("slashed");
    expect(s.fraudTx).toBe(TX);
    s = reduceJobView(s, ev(2, "settlement", { kind: "refunded", tx: TX }));
    expect(s.settlement).toBe("refunded");
    expect(s.refundTx).toBe(TX);
    expect(s.finalTx).toBeNull(); // a refund is never shown as a payout
  });

  it("shows fraud details after a reload, from the stored job", () => {
    const j = job({
      status: "refunded",
      verdict: "fraud",
      fraud: { tileIndex: 7, owner: OWNER, expectedTileHash: "0xaa", claimedTileHash: "0xbb" },
      fraudTx: TX,
      refundTx: TX,
    });
    const s = reduceJobView(initialViewState, { type: "snapshot", job: j });
    expect(s.verdict).toBe("fraud");
    expect(s.fraud?.tileIndex).toBe(7);
    expect(s.settlement).toBe("refunded");
  });

  it("an honest job never carries fraud state", () => {
    const s = reduceJobView(initialViewState, { type: "snapshot", job: job({ status: "final", verdict: "ok" }) });
    expect(s.fraud).toBeNull();
    expect(s.verdict).toBe("ok");
  });
});
