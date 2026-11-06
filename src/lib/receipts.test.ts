import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/server", () => ({ connection: async () => {} }));

import { encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentRequired } from "@x402/core/types";
import { GET as receiptGet } from "@/app/api/receipts/by-id/[receiptId]/route";
import { GET as receiptsList } from "@/app/api/wallet/receipts/route";
import { POST as approvalPost } from "@/app/api/approvals/route";
import { GET as approvalGet } from "@/app/api/approvals/[id]/route";
import { POST as jobsPost } from "@/app/api/jobs/route";
import { getRun, startRun } from "./agent-runner";
import type { RunDeps } from "./agent-runner";
import { creditDeposit, listLedger } from "./credits";
import { resetEnvCache } from "./env";
import { startFakeFacilitator } from "./fake-facilitator";
import type { FakeFacilitator } from "./fake-facilitator";
import { getJob, updateJob } from "./jobs";
import { createPlan } from "./plans";
import { buildReceipt, canRead, listReceipts, shareToken } from "./receipt";
import { setupTestEnv } from "./testing";
import { get, other, signIn, user } from "./testing-wallet";
import { resetX402 } from "./x402";

const HBAR = 100_000_000;
const DEPOSIT_TX = "0x" + "d1".repeat(32);
const TX = (c: string) => "0x" + c.repeat(32);

const inProcessFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  const req = new Request(url, init);
  if (url.pathname === "/api/jobs" && req.method === "POST") return jobsPost(req);
  if (url.pathname === "/api/approvals" && req.method === "POST") return approvalPost(req);
  const m = /^\/api\/approvals\/([^/]+)$/.exec(url.pathname);
  if (m) return approvalGet(req, { params: Promise.resolve({ id: m[1] }) });
  return new Response("not found", { status: 404 });
}) as typeof fetch;
const fakePay: RunDeps["pay"] = async (pr: PaymentRequired) => encodePaymentSignatureHeader({ x402Version: 2, resource: pr.resource, accepted: pr.accepts[0], payload: { transaction: `tx-${Math.random()}` } });
const deps: RunDeps = { fetch: inProcessFetch, pay: fakePay, sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 100))), apiUrl: "http://localhost:3000" };

describe("receipts for money events", () => {
  let fake: FakeFacilitator;
  let cleanup: () => void;
  beforeAll(async () => {
    fake = await startFakeFacilitator();
  });
  afterAll(() => fake.stop());
  beforeEach(() => {
    cleanup = setupTestEnv();
    Object.assign(process.env, {
      MESH_SESSION_SECRET: "a-test-session-secret-0123456789",
      AGENT_DEPOSIT_ADDRESS: "0x00000000000000000000000000000000000000A1",
      X402_ENABLED: "true",
      X402_FACILITATOR_URL: fake.url,
      X402_PAY_TO: "0.0.1234",
      X402_ASSET: "0.0.0",
      MIRROR_NODE_URL: fake.url,
      HCS_TOPIC_ID: "0.0.7777",
    });
    resetEnvCache();
    resetX402();
    fake.verify = "valid";
    fake.settle = "ok";
  });
  afterEach(() => cleanup());

  async function paidJob() {
    creditDeposit(user.address, 3 * HBAR, DEPOSIT_TX);
    const plan = createPlan({ address: user.address, preset: "small", reason: "a good default", prompt: "a render for my slide", og: { content: "", requestId: "req_0g_77", provider: "0x" + "ab".repeat(20), model: "m1", teeVerified: true, verification: "router-checked", signer: null, signatureVerified: null, textBound: null, digest: "d" } });
    const { run, done } = await startRun(user.address, plan.planId, deps);
    await done;
    return { plan, run: await getRun(run.runId, user.address) };
  }

  describe("ids", () => {
    it("gives every ledger entry its own stable receipt id", async () => {
      const { run } = await paidJob();
      const rows = listLedger(user.address, 10);
      expect(rows.map((r) => r.kind).sort()).toEqual(["deposit", "job_hold"]);
      expect(run.receiptId).toBe(rows.find((r) => r.kind === "job_hold")!.receipt_id);
      expect(buildReceipt(run.receiptId!)?.receiptId).toBe(run.receiptId); // stable
    });

    it("has no receipt for an unknown id or the internal 'spent' marker", async () => {
      await paidJob();
      expect(buildReceipt("rcpt_0000000000000000")).toBeNull();
      const spent = (await import("./db")).getDb().prepare("SELECT receipt_id FROM ledger WHERE kind = 'job_spent'").get() as { receipt_id: string };
      expect(buildReceipt(spent.receipt_id)).toBeNull();
    });
  });

  describe("deposit receipt", () => {
    it("shows who, how much, the time and a HashScan link to the deposit transaction", () => {
      const { receiptId } = creditDeposit(user.address, 250_000_000, DEPOSIT_TX);
      const r = buildReceipt(receiptId)!;
      expect(r).toMatchObject({ type: "deposit", title: "Credit added", status: "confirmed", statusTone: "ok", wallet: user.address.toLowerCase(), amountTinybars: 250_000_000, amountHbar: "2.5", direction: "credit", testnet: true, page: `/receipts/${receiptId}` });
      expect(r.transactions).toEqual([{ label: "Deposit transaction", hash: DEPOSIT_TX, url: `https://hashscan.io/testnet/transaction/${DEPOSIT_TX}` }]);
      expect(r.job).toBeNull();
      expect(r.description).toContain("2.5 HBAR");
    });

    it("carries a timestamp in UTC that matches the unix time", () => {
      const { receiptId } = creditDeposit(user.address, 100_000_000, DEPOSIT_TX);
      const r = buildReceipt(receiptId)!;
      expect(r.issuedAtIso).toBe(new Date(r.issuedAt * 1000).toISOString());
      expect(r.issuedAtIso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/);
      expect(Math.abs(r.issuedAt - Date.now() / 1000)).toBeLessThan(5);
    });
  });

  describe("job payment receipt", () => {
    it("lists the x402 payment, the job, the 0G plan with its verification, and the HCS topic", async () => {
      const { run } = await paidJob();
      const job = getJob(run.jobId!)!;
      updateJob(job.jobId, { lockTx: TX("11"), claimTx: TX("22"), finalTx: TX("33"), status: "final", hcsSequence: [4, 5, 6] });
      const r = buildReceipt(run.receiptId!)!;
      expect(r).toMatchObject({ type: "job_payment", title: "Job payment", status: "paid", statusTone: "ok", direction: "debit", amountHbar: "0.5", amountTinybars: 50_000_000 });
      expect(r.transactions.map((t) => t.label)).toEqual(["x402 payment (agent to treasury)", "Escrow lock", "Claim posted", "Finalized, providers paid"]);
      expect(r.transactions[0]).toMatchObject({ hash: "0.0.9185802@1793900000.123456789", url: "https://hashscan.io/testnet/transaction/0.0.9185802-1793900000-123456789" });
      expect(r.transactions[1].url).toBe(`https://hashscan.io/testnet/transaction/${TX("11")}`);
      expect(r.job).toEqual({ jobId: job.jobId, status: "final", page: `/jobs/${job.jobId}`, api: `/api/receipts/${job.jobId}` });
      expect(r.plan).toMatchObject({ source: "og", preset: "small", reason: "a good default", request: "a render for my slide", og: { requestId: "req_0g_77", verification: "router-checked", teeVerified: true } });
      expect(r.hcs).toEqual({ topicId: "0.0.7777", sequences: [4, 5, 6], url: "https://hashscan.io/testnet/topic/0.0.7777" });
      expect(r.description).toContain("providers were paid");
    });

    it("tells the cheat story and links the fraud, slash and refund transactions when a provider cheated", async () => {
      const { run } = await paidJob();
      updateJob(run.jobId!, { status: "refunded", verdict: "fraud", lockTx: TX("11"), fraudTx: TX("44"), slashTx: TX("44"), refundTx: TX("55") });
      const r = buildReceipt(run.receiptId!)!;
      expect(r.description).toContain("cheated");
      expect(r.transactions.map((t) => t.label)).toEqual(["x402 payment (agent to treasury)", "Escrow lock", "Fraud proof", "Provider slashed", "Refund to requester"]);
      expect(r.job?.status).toBe("refunded");
    });

    it("says 'chosen by hand' for a manual plan and has no 0G block", async () => {
      creditDeposit(user.address, 3 * HBAR, DEPOSIT_TX);
      const plan = createPlan({ address: user.address, preset: "tiny", reason: null, prompt: null, og: null });
      const { run, done } = await startRun(user.address, plan.planId, deps);
      await done;
      const r = buildReceipt((await getRun(run.runId, user.address)).receiptId!)!;
      expect(r.plan).toMatchObject({ source: "manual", og: null, request: null });
    });

    it("ignores values that are not real transaction hashes", async () => {
      const { run } = await paidJob();
      updateJob(run.jobId!, { lockTx: "already-locked", claimTx: "posted" });
      const r = buildReceipt(run.receiptId!)!;
      expect(r.transactions.map((t) => t.label)).toEqual(["x402 payment (agent to treasury)"]);
    });
  });

  describe("refund receipt", () => {
    it("is issued when a hold is returned, names the reason and points at the payment it returns", async () => {
      creditDeposit(user.address, 3 * HBAR, DEPOSIT_TX);
      fake.verify = "invalid";
      const plan = createPlan({ address: user.address, preset: "small", reason: null, prompt: null, og: null });
      const { run, done } = await startRun(user.address, plan.planId, deps);
      await done;
      const view = await getRun(run.runId, user.address);
      const refundRow = listLedger(user.address, 10).find((l) => l.kind === "job_refund")!;
      const r = buildReceipt(refundRow.receipt_id)!;
      expect(r).toMatchObject({ type: "refund", title: "Credit returned", status: "returned to your credit", direction: "credit", amountHbar: "0.5", relatedReceiptId: view.receiptId });
      expect(r.description).toContain("returned");
      expect(buildReceipt(view.receiptId!)).toMatchObject({ statusTone: "bad", status: "failed, credit returned" });
    });
  });

  describe("who can read a receipt", () => {
    it("the owner can; another wallet and a signed-out visitor cannot; a share token opens that one receipt", () => {
      const { receiptId } = creditDeposit(user.address, 100_000_000, DEPOSIT_TX);
      const second = creditDeposit(user.address, 100_000_000, TX("e2"));
      const r = buildReceipt(receiptId)!;
      expect(canRead(r, user.address, null)).toBe(true);
      expect(canRead(r, user.address.toUpperCase().replace("0X", "0x"), null)).toBe(true);
      expect(canRead(r, other.address, null)).toBe(false);
      expect(canRead(r, null, null)).toBe(false);
      expect(canRead(r, null, shareToken(receiptId))).toBe(true);
      expect(canRead(r, null, shareToken(second.receiptId))).toBe(false); // a token for another receipt does not work
      expect(canRead(r, null, "x".repeat(24))).toBe(false);
    });
  });

  describe("the API", () => {
    it("GET /api/receipts/by-id/:id returns the receipt to its owner, with a share token, and hides it from everyone else", async () => {
      const { receiptId } = creditDeposit(user.address, 100_000_000, DEPOSIT_TX);
      const ctx = { params: Promise.resolve({ receiptId }) };
      const ownerCookie = await signIn();
      const ok = await receiptGet(get(`/api/receipts/by-id/${receiptId}`, ownerCookie), ctx);
      expect(ok.status).toBe(200);
      const body = await ok.json();
      expect(body).toMatchObject({ receiptId, type: "deposit", amountHbar: "1" });
      expect(body.shareToken).toBe(shareToken(receiptId));

      expect((await receiptGet(get(`/api/receipts/by-id/${receiptId}`), ctx)).status).toBe(404); // signed out
      const otherCookie = await signIn(other);
      expect((await receiptGet(get(`/api/receipts/by-id/${receiptId}`, otherCookie), ctx)).status).toBe(404); // another wallet

      const shared = await receiptGet(get(`/api/receipts/by-id/${receiptId}?share=${shareToken(receiptId)}`), ctx);
      expect(shared.status).toBe(200);
      expect((await shared.json()).shareToken).toBeUndefined(); // only the owner is handed the token
      expect((await receiptGet(get(`/api/receipts/by-id/${receiptId}?share=wrong`), ctx)).status).toBe(404);
    });

    it("an unknown or malformed id looks the same as a forbidden one", async () => {
      const cookie = await signIn();
      expect((await receiptGet(get("/api/receipts/by-id/rcpt_0000000000000000", cookie), { params: Promise.resolve({ receiptId: "rcpt_0000000000000000" }) })).status).toBe(404);
      expect((await receiptGet(get("/api/receipts/by-id/nope", cookie), { params: Promise.resolve({ receiptId: "nope" }) })).status).toBe(400);
    });

    it("GET /api/wallet/receipts lists the wallet's receipts newest first, and only its own", async () => {
      const { run } = await paidJob();
      creditDeposit(other.address, 100_000_000, TX("f3"));
      const cookie = await signIn();
      expect((await receiptsList(get("/api/wallet/receipts"))).status).toBe(401);
      const { receipts } = await (await receiptsList(get("/api/wallet/receipts", cookie))).json();
      expect(receipts.map((x: { type: string }) => x.type)).toEqual(["job_payment", "deposit"]);
      expect(receipts[0]).toMatchObject({ receiptId: run.receiptId, title: "Job payment", amountHbar: "0.5", direction: "debit", status: "paid", page: `/receipts/${run.receiptId}` });
      expect(receipts).toHaveLength(2); // the other wallet's deposit is not here
      expect(listReceipts(other.address)).toHaveLength(1);
    });
  });
});
