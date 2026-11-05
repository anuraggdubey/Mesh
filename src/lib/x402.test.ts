import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// `connection()` only works inside a real Next.js request.
vi.mock("next/server", () => ({ connection: async () => {} }));

import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { decodePaymentRequiredHeader, decodePaymentResponseHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { GET as jobGet } from "@/app/api/jobs/[id]/route";
import { GET as jobsList, POST as jobsPost } from "@/app/api/jobs/route";
import { bindingFor } from "./approvals";
import type { ApprovalParams } from "./approvals";
import { getDb } from "./db";
import { resetEnvCache } from "./env";
import { listEvents } from "./jobs";
import { setupTestEnv, TEST_REQUESTER } from "./testing";
import { hashscanTxUrl, HEADER_REQUIRED, HEADER_RESPONSE, HEADER_SIGNATURE, paymentKey, resetX402, x402Amount } from "./x402";

// ───────────────────────── a fake x402 facilitator and mirror node ─────────────────────────

interface Fake {
  url: string;
  supported: boolean;
  verify: "valid" | "invalid";
  settle: "ok" | "fail" | "error";
  calls: { verify: number; settle: number };
  mirror: "ok" | "missing";
  stop: () => Promise<void>;
}

async function startFake(): Promise<Fake> {
  const f = { supported: true, verify: "valid", settle: "ok", calls: { verify: 0, settle: 0 }, mirror: "ok", url: "" } as Fake;
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    const send = (status: number, b: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(b));
    };
    if (req.url === "/supported") {
      if (!f.supported) return send(503, { error: "down" });
      return send(200, { kinds: [{ x402Version: 2, scheme: "exact", network: "hedera:testnet", extra: { feePayer: "0.0.9185802" } }], extensions: [], signers: {} });
    }
    if (req.url === "/verify") {
      f.calls.verify += 1;
      return send(200, f.verify === "valid" ? { isValid: true, payer: "0.0.5555" } : { isValid: false, invalidReason: "invalid_exact_hedera_payload_signature_invalid", invalidMessage: "payer signature is invalid" });
    }
    if (req.url === "/settle") {
      f.calls.settle += 1;
      if (f.settle === "error") return send(500, { error: "boom" });
      if (f.settle === "fail") return send(200, { success: false, errorReason: "insufficient_funds", errorMessage: "payer has too little balance", transaction: "", network: body.paymentRequirements?.network ?? "hedera:testnet" });
      return send(200, { success: true, transaction: "0.0.9185802@1793900000.123456789", network: "hedera:testnet", payer: "0.0.5555" });
    }
    if (req.url?.startsWith("/api/v1/accounts/")) {
      if (f.mirror === "missing") return send(404, { _status: { messages: [{ message: "Not found" }] } });
      return send(200, { account: "0.0.777" });
    }
    send(404, {});
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  f.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  f.stop = () => new Promise<void>((r) => server.close(() => r()));
  return f;
}

// ───────────────────────── helpers ─────────────────────────

const post = (body: unknown, headers: Record<string, string> = {}) =>
  jobsPost(new Request("http://x/api/jobs", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }));

const small = { type: "render", preset: "small", requester: TEST_REQUESTER };
const tiny = { type: "render", preset: "tiny", requester: TEST_REQUESTER };

/** A client payment for the requirements in a 402: the facilitator is fake, so the signed transaction is an opaque string. */
function payFor(pr: PaymentRequired, over: Partial<PaymentRequirements> = {}, tx = "AAAAbase64signedTransaction1"): string {
  return encodePaymentSignatureHeader({ x402Version: 2, resource: pr.resource, accepted: { ...pr.accepts[0], ...over }, payload: { transaction: tx } });
}

async function challengeFor(body: unknown): Promise<PaymentRequired> {
  const res = await post(body);
  expect(res.status).toBe(402);
  return decodePaymentRequiredHeader(res.headers.get(HEADER_REQUIRED) as string);
}

const jobCount = async () => ((await (await jobsList()).json()) as { jobs: unknown[] }).jobs.length;

describe("x402 on Hedera: POST /api/jobs", () => {
  let fake: Fake;
  let cleanup: () => void;

  beforeAll(async () => {
    fake = await startFake();
  });
  afterAll(() => fake.stop());

  beforeEach(() => {
    cleanup = setupTestEnv();
    process.env.X402_ENABLED = "true";
    process.env.X402_FACILITATOR_URL = fake.url;
    process.env.X402_PAY_TO = "0.0.1234";
    process.env.X402_ASSET = "0.0.0";
    process.env.MIRROR_NODE_URL = fake.url;
    resetEnvCache();
    resetX402();
    fake.supported = true;
    fake.verify = "valid";
    fake.settle = "ok";
    fake.mirror = "ok";
    fake.calls = { verify: 0, settle: 0 };
  });
  afterEach(() => cleanup());

  describe("pricing helpers", () => {
    it("HBAR is priced at 1 HBAR per test-token unit (tinybars = price x 100); HTS tokens are 1:1", () => {
      expect(x402Amount("500000", "0.0.0")).toBe("50000000");
      expect(x402Amount("100000", "0.0.0")).toBe("10000000");
      expect(x402Amount("500000", "0.0.429274")).toBe("500000");
    });

    it("builds a HashScan link from a Hedera transaction id", () => {
      expect(hashscanTxUrl("0.0.9185802@1793900000.123456789", "hedera:testnet")).toBe("https://hashscan.io/testnet/transaction/0.0.9185802-1793900000-123456789");
      expect(hashscanTxUrl("0.0.1@2.3", "hedera:mainnet")).toBe("https://hashscan.io/mainnet/transaction/0.0.1-2-3");
    });

    it("identifies one signed payment by a stable key", () => {
      const a = paymentKey({ x402Version: 2, accepted: {} as PaymentRequirements, payload: { transaction: "abc" } });
      expect(a).toBe(paymentKey({ x402Version: 2, accepted: {} as PaymentRequirements, payload: { transaction: "abc" } }));
      expect(a).not.toBe(paymentKey({ x402Version: 2, accepted: {} as PaymentRequirements, payload: { transaction: "abd" } }));
    });
  });

  describe("the 402 challenge", () => {
    it("quotes the price in HBAR on hedera:testnet, with the facilitator as fee payer, and creates nothing", async () => {
      const res = await post(small);
      expect(res.status).toBe(402);
      const pr = decodePaymentRequiredHeader(res.headers.get(HEADER_REQUIRED) as string);
      expect(pr.x402Version).toBe(2);
      expect(pr.accepts).toHaveLength(1);
      expect(pr.accepts[0]).toMatchObject({ scheme: "exact", network: "hedera:testnet", amount: "50000000", asset: "0.0.0", payTo: "0.0.1234", maxTimeoutSeconds: 120 });
      expect(pr.accepts[0].extra).toMatchObject({ feePayer: "0.0.9185802" });
      expect(pr.resource.url).toBe("http://localhost:3000/api/jobs");
      expect(await res.json()).toEqual(pr); // the body repeats the header
      expect(await jobCount()).toBe(0);
      expect(fake.calls).toEqual({ verify: 0, settle: 0 });
    });

    it("prices by preset and can quote an HTS token such as USDC", async () => {
      expect((await challengeFor(tiny)).accepts[0].amount).toBe("10000000");
      process.env.X402_ASSET = "0.0.429274";
      resetEnvCache();
      const pr = await challengeFor(small);
      expect(pr.accepts[0]).toMatchObject({ asset: "0.0.429274", amount: "500000" });
    });

    it("answers 503 when the facilitator is unreachable, and recovers once it is back", async () => {
      fake.supported = false;
      const down = await post(small);
      expect(down.status).toBe(503);
      expect((await down.json()).error).toBe("facilitator_unavailable");
      fake.supported = true;
      expect((await post(small)).status).toBe(402);
    });

    it("looks up the treasury from the API wallet when X402_PAY_TO is unset", async () => {
      process.env.X402_PAY_TO = "";
      process.env.API_PRIVATE_KEY = `0x${"11".repeat(32)}`;
      resetEnvCache();
      resetX402();
      expect((await challengeFor(small)).accepts[0].payTo).toBe("0.0.777");
    });

    it("answers 503 not_configured when there is neither a treasury nor an API wallet account", async () => {
      process.env.X402_PAY_TO = "";
      resetEnvCache();
      resetX402();
      const none = await post(small);
      expect(none.status).toBe(503);
      expect((await none.json()).error).toBe("not_configured");

      process.env.API_PRIVATE_KEY = `0x${"22".repeat(32)}`;
      resetEnvCache();
      resetX402();
      fake.mirror = "missing";
      const missing = await post(small);
      expect(missing.status).toBe(503);
      expect((await missing.json()).message).toMatch(/no Hedera account/);
    });
  });

  describe("the paid retry", () => {
    it("SUCCESS: verifies, settles on Hedera, then creates a paid job with the transaction id", async () => {
      const pr = await challengeFor(small);
      const res = await post(small, { [HEADER_SIGNATURE]: payFor(pr) });
      expect(res.status).toBe(200);
      const settle = decodePaymentResponseHeader(res.headers.get(HEADER_RESPONSE) as string);
      expect(settle).toMatchObject({ success: true, transaction: "0.0.9185802@1793900000.123456789", network: "hedera:testnet", payer: "0.0.5555" });

      const job = await res.json();
      expect(job.status).toBe("paid");
      expect(job.payment).toEqual({ network: "hedera:testnet", asset: "0.0.0", amount: "50000000", payer: "0.0.5555", transaction: "0.0.9185802@1793900000.123456789" });
      expect(fake.calls).toEqual({ verify: 1, settle: 1 });
      expect(await jobCount()).toBe(1);

      const ev = listEvents(job.jobId).find((e) => e.type === "payment");
      expect(ev?.data).toMatchObject({ transaction: "0.0.9185802@1793900000.123456789", amount: "50000000" });
      // the stored job can be read back with its payment
      const got = await jobGet(new Request("http://x"), { params: Promise.resolve({ id: job.jobId }) });
      expect((await got.json()).payment.transaction).toBe("0.0.9185802@1793900000.123456789");
    });

    it("REPLAY: the same signed payment cannot buy a second job, and is not settled twice", async () => {
      const pr = await challengeFor(small);
      const header = payFor(pr);
      expect((await post(small, { [HEADER_SIGNATURE]: header })).status).toBe(200);
      const again = await post(small, { [HEADER_SIGNATURE]: header });
      expect(again.status).toBe(409);
      expect((await again.json()).error).toBe("payment_replayed");
      expect(await jobCount()).toBe(1);
      expect(fake.calls.settle).toBe(1);
      // the reservation points at the job it paid for
      const row = getDb().prepare("SELECT job_id FROM used_nonces WHERE nonce LIKE 'x402:%'").get() as { job_id: string };
      expect(row.job_id).toMatch(/^0x[0-9a-f]{64}$/);
    });

    it("a different signed payment is a different payment", async () => {
      const pr = await challengeFor(small);
      expect((await post(small, { [HEADER_SIGNATURE]: payFor(pr, {}, "tx-one") })).status).toBe(200);
      expect((await post(small, { [HEADER_SIGNATURE]: payFor(pr, {}, "tx-two") })).status).toBe(200);
      expect(await jobCount()).toBe(2);
    });

    it("MISMATCH: paying too little, to another account, or in another asset gets a fresh quote and no job", async () => {
      const pr = await challengeFor(small);
      for (const over of [{ amount: "1" }, { payTo: "0.0.9999" }, { asset: "0.0.429274" }, { network: "hedera:mainnet" as const }]) {
        const res = await post(small, { [HEADER_SIGNATURE]: payFor(pr, over) });
        expect(res.status, JSON.stringify(over)).toBe(402);
        expect(res.headers.get(HEADER_REQUIRED)).toBeTruthy();
        expect((await res.json()).error).toMatch(/does not match/);
      }
      expect(await jobCount()).toBe(0);
      expect(fake.calls.settle).toBe(0);
      // nothing was reserved, so the honest payment still works afterwards
      expect((await post(small, { [HEADER_SIGNATURE]: payFor(pr) })).status).toBe(200);
    });

    it("INVALID: a payment the facilitator rejects creates no job and settles nothing", async () => {
      fake.verify = "invalid";
      const pr = await challengeFor(small);
      const res = await post(small, { [HEADER_SIGNATURE]: payFor(pr) });
      expect(res.status).toBe(402);
      expect((await res.json()).error).toBe("payer signature is invalid");
      expect(await jobCount()).toBe(0);
      expect(fake.calls.settle).toBe(0);
      fake.verify = "valid";
      expect((await post(small, { [HEADER_SIGNATURE]: payFor(pr) })).status).toBe(200); // not reserved, retry works
    });

    it("SETTLE FAILURE: no job is created, and the payment stays reserved (it may have partly happened)", async () => {
      fake.settle = "fail";
      const pr = await challengeFor(small);
      const header = payFor(pr);
      const res = await post(small, { [HEADER_SIGNATURE]: header });
      expect(res.status).toBe(402);
      expect((await res.json()).error).toBe("payer has too little balance");
      expect(await jobCount()).toBe(0);
      fake.settle = "ok";
      expect((await post(small, { [HEADER_SIGNATURE]: header })).status).toBe(409); // same payment, refused
      expect((await post(small, { [HEADER_SIGNATURE]: payFor(pr, {}, "fresh-tx") })).status).toBe(200); // a new payment works
    });

    it("an indeterminate settlement (facilitator error) is a 502 and creates nothing", async () => {
      fake.settle = "error";
      const pr = await challengeFor(small);
      const res = await post(small, { [HEADER_SIGNATURE]: payFor(pr) });
      expect(res.status).toBe(502);
      expect((await res.json()).error).toBe("settle_failed");
      expect(await jobCount()).toBe(0);
    });

    it("a malformed payment header is a 400", async () => {
      await challengeFor(small);
      for (const bad of ["not-base64!!", Buffer.from("{}").toString("base64"), Buffer.from("[1]").toString("base64")]) {
        const res = await post(small, { [HEADER_SIGNATURE]: bad });
        expect(res.status, bad).toBe(400);
        expect((await res.json()).error).toBe("invalid_payment");
      }
      expect(await jobCount()).toBe(0);
    });

    it("validation still comes first: a bad body never reaches the facilitator", async () => {
      const res = await post({ requester: "nope" });
      expect(res.status).toBe(400);
      expect(fake.calls).toEqual({ verify: 0, settle: 0 });
    });
  });

  describe("with a human approval above the spending threshold", () => {
    const params: ApprovalParams = { purpose: "create-job", requester: TEST_REQUESTER, type: "render", preset: "small", price: "500000" };
    const approval = (status: "approved" | "pending" | "used" = "approved", over: Partial<ApprovalParams> = {}) => {
      const id = `00000000-0000-4000-8000-${String(Math.floor(Math.random() * 1e12)).padStart(12, "0")}`;
      const p = { ...params, ...over };
      const t = Math.floor(Date.now() / 1000);
      getDb()
        .prepare(`INSERT INTO approvals (approval_id, purpose, binding, params, status, device_code, user_code, verification_uri, interval_s, next_poll_at, expires_at, subject, created_at) VALUES (?, ?, ?, ?, ?, 'dc', 'UC', 'https://w', 5, ?, ?, 'iss|sub', ?)`)
        .run(id, p.purpose, bindingFor(p), JSON.stringify(p), status, t + 5, t + 600, t);
      return id;
    };

    beforeEach(() => {
      process.env.AGENT_APPROVAL_THRESHOLD = "200000"; // small (500000) needs approval, tiny (100000) does not
      resetEnvCache();
    });

    it("a small job needs approval before it is even quoted; a tiny job does not", async () => {
      const res = await post(small);
      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe("approval_required");
      expect((await post(tiny)).status).toBe(402);
    });

    it("an approved approval gets the quote, is spent only when the payment goes through, and cannot be reused", async () => {
      const id = approval();
      const res = await post(small, { "x-mesh-approval": id });
      expect(res.status).toBe(402); // peeked, not spent
      const pr = decodePaymentRequiredHeader(res.headers.get(HEADER_REQUIRED) as string);
      expect((getDb().prepare("SELECT status FROM approvals WHERE approval_id = ?").get(id) as { status: string }).status).toBe("approved");

      const paid = await post(small, { "x-mesh-approval": id, [HEADER_SIGNATURE]: payFor(pr, {}, "tx-a") });
      expect(paid.status).toBe(200);
      expect((getDb().prepare("SELECT status FROM approvals WHERE approval_id = ?").get(id) as { status: string }).status).toBe("used");

      const reuse = await post(small, { "x-mesh-approval": id, [HEADER_SIGNATURE]: payFor(pr, {}, "tx-b") });
      expect(reuse.status).toBe(403);
      expect((await reuse.json()).reason).toBe("already_used");
      expect(fake.calls.settle).toBe(1); // the second payment was never settled
      expect(await jobCount()).toBe(1);
    });

    it("DENIED: a pending approval, or one granted for a different job, never reaches payment", async () => {
      const pending = await post(small, { "x-mesh-approval": approval("pending") });
      expect(pending.status).toBe(403);
      expect((await pending.json()).reason).toBe("not_approved");
      const other = await post(small, { "x-mesh-approval": approval("approved", { preset: "full", price: "1000000" }) });
      expect((await other.json()).reason).toBe("binding_mismatch");
      expect(fake.calls).toEqual({ verify: 0, settle: 0 });
      expect(await jobCount()).toBe(0);
    });
  });
});
