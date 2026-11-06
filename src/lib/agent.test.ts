import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/server", () => ({ connection: async () => {} }));

import { decodePaymentRequiredHeader, encodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentRequired } from "@x402/core/types";
import { GET as approvalGet } from "@/app/api/approvals/[id]/route";
import { POST as approvalPost } from "@/app/api/approvals/route";
import { POST as jobsPost } from "@/app/api/jobs/route";
import { Agent, AgentRefusal, expectedAmount, makeHederaPayer, parsePresetList } from "./agent";
import type { AgentConfig, AgentDeps } from "./agent";
import { resetEnvCache } from "./env";
import { startFakeFacilitator } from "./fake-facilitator";
import type { FakeFacilitator } from "./fake-facilitator";
import { IDP_CLIENT_ID, IDP_CLIENT_SECRET, startFakeIdp } from "./fake-idp";
import type { FakeIdp } from "./fake-idp";
import { setupTestEnv, TEST_REQUESTER } from "./testing";
import { resetX402 } from "./x402";

const API = "http://localhost:3000";

/** A fetch that calls the route handlers in-process. */
const inProcessFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  const req = new Request(url, init);
  if (url.pathname === "/api/jobs" && req.method === "POST") return jobsPost(req);
  if (url.pathname === "/api/approvals" && req.method === "POST") return approvalPost(req);
  const m = /^\/api\/approvals\/([^/]+)$/.exec(url.pathname);
  if (m) return approvalGet(req, { params: Promise.resolve({ id: m[1] }) });
  return new Response("not found", { status: 404 });
}) as typeof fetch;

const config = (over: Partial<AgentConfig> = {}): AgentConfig => ({
  apiUrl: API,
  requester: TEST_REQUESTER,
  budget: 1_000_000n,
  perJobCap: 500_000n,
  allowedPresets: ["tiny", "small"],
  asset: "0.0.0",
  approvalTimeoutMs: 5_000,
  ...over,
});

/** The facilitator is fake, so a "signed payment" is an opaque transaction string. */
const fakePay: AgentDeps["pay"] = async (pr: PaymentRequired) =>
  encodePaymentSignatureHeader({ x402Version: 2, resource: pr.resource, accepted: pr.accepts[0], payload: { transaction: `tx-${Math.random()}` } });

describe("scripted agent", () => {
  let fake: FakeFacilitator;
  let idp: FakeIdp;
  let cleanup: () => void;
  let lines: string[];
  let approvals: { userCode: string; verificationUri: string }[];

  const deps = (over: Partial<AgentDeps> = {}): AgentDeps => ({
    fetch: inProcessFetch,
    pay: fakePay,
    onApprovalNeeded: (a) => approvals.push(a),
    log: (l) => lines.push(l),
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 1200))),
    ...over,
  });

  beforeAll(async () => {
    fake = await startFakeFacilitator();
    idp = await startFakeIdp();
  });
  afterAll(async () => {
    await fake.stop();
    await idp.stop();
  });

  beforeEach(() => {
    cleanup = setupTestEnv();
    Object.assign(process.env, {
      X402_ENABLED: "true",
      X402_FACILITATOR_URL: fake.url,
      X402_PAY_TO: "0.0.1234",
      X402_ASSET: "0.0.0",
      MIRROR_NODE_URL: fake.url,
      WORLD_IDP_ISSUER: idp.url,
      WORLD_IDP_CLIENT_ID: IDP_CLIENT_ID,
      WORLD_IDP_CLIENT_SECRET: IDP_CLIENT_SECRET,
    });
    resetEnvCache();
    resetX402();
    fake.supported = true;
    fake.verify = "valid";
    fake.settle = "ok";
    fake.calls = { verify: 0, settle: 0 };
    idp.mode = "approved";
    lines = [];
    approvals = [];
  });
  afterEach(() => cleanup());

  it("pays the 402 and creates the job, reporting the Hedera transaction", async () => {
    const agent = new Agent(config(), deps());
    const r = await agent.runJob("small");
    expect(r.jobId).toMatch(/^0x[0-9a-f]{64}$/);
    expect(r.paymentTx).toBe("0.0.9185802@1793900000.123456789");
    expect(r.approvalId).toBeNull();
    expect(agent.totalSpent).toBe(500_000n);
    expect(fake.calls).toEqual({ verify: 1, settle: 1 });
    expect(approvals).toHaveLength(0);
  });

  it("tracks the budget across jobs and refuses once it would be exceeded, before any request", async () => {
    const agent = new Agent(config({ budget: 600_000n }), deps());
    await agent.runJob("small"); // 500000 spent, 100000 left
    await agent.runJob("tiny"); // exactly the rest
    expect(agent.remaining).toBe(0n);
    const settledBefore = fake.calls.settle;
    await expect(agent.runJob("tiny")).rejects.toMatchObject({ code: "over_budget" });
    expect(fake.calls.settle).toBe(settledBefore);
  });

  it("refuses a preset off the allowlist and a job above the per-job cap without calling the server", async () => {
    const spy = vi.fn(inProcessFetch);
    const a = new Agent(config({ allowedPresets: ["tiny"] }), deps({ fetch: spy as typeof fetch }));
    await expect(a.runJob("small")).rejects.toMatchObject({ code: "preset_not_allowed" });
    const b = new Agent(config({ perJobCap: 100_000n }), deps({ fetch: spy as typeof fetch }));
    await expect(b.runJob("small")).rejects.toMatchObject({ code: "over_job_cap" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("will not sign for a payee that is not on its allowlist", async () => {
    const pay = vi.fn(fakePay);
    const agent = new Agent(config({ allowedPayTo: ["0.0.9999"] }), deps({ pay }));
    await expect(agent.runJob("tiny")).rejects.toMatchObject({ code: "payee_not_allowed" });
    expect(pay).not.toHaveBeenCalled();
    expect(fake.calls.settle).toBe(0);
  });

  it("will not sign when the server asks for more than the job should cost", async () => {
    const greedy: typeof fetch = async (input, init) => {
      const res = await inProcessFetch(input, init);
      if (res.status !== 402) return res;
      const pr = decodePaymentRequiredHeader(res.headers.get("payment-required") as string);
      pr.accepts[0].amount = "900000000";
      return new Response(JSON.stringify(pr), { status: 402, headers: { "payment-required": encodePaymentRequiredHeader(pr) } });
    };
    const pay = vi.fn(fakePay);
    await expect(new Agent(config(), deps({ fetch: greedy, pay })).runJob("tiny")).rejects.toMatchObject({ code: "price_changed" });
    expect(pay).not.toHaveBeenCalled();
  });

  it("reports a payment the server rejects, and spends nothing", async () => {
    fake.verify = "invalid";
    const agent = new Agent(config(), deps());
    await expect(agent.runJob("tiny")).rejects.toBeInstanceOf(AgentRefusal);
    expect(agent.totalSpent).toBe(0n);
    expect(fake.calls.settle).toBe(0);
  });

  describe("above the approval threshold", () => {
    beforeEach(() => {
      process.env.AGENT_APPROVAL_THRESHOLD = "100000"; // tiny is free to spend, small needs a human
      resetEnvCache();
    });

    it("asks a human, waits for the approval, then pays", async () => {
      const agent = new Agent(config(), deps());
      const r = await agent.runJob("small");
      expect(approvals).toEqual([{ userCode: "ABCD-1234", verificationUri: "https://world.test/verify?code=ABCD-1234", expiresAt: expect.any(Number) }].map((a) => expect.objectContaining({ userCode: a.userCode })));
      expect(r.approvalId).toMatch(/[0-9a-f-]{36}/);
      expect(r.paymentTx).not.toBeNull();
    });

    it("works when the portal client uses HTTP Basic authentication", async () => {
      process.env.WORLD_IDP_CLIENT_AUTH = "basic";
      resetEnvCache();
      const r = await new Agent(config(), deps()).runJob("small");
      expect(r.approvalId).not.toBeNull();
      delete process.env.WORLD_IDP_CLIENT_AUTH;
    });

    it("does not pay when the human denies", async () => {
      idp.mode = "denied";
      const agent = new Agent(config(), deps());
      await expect(agent.runJob("small")).rejects.toMatchObject({ code: "approval_denied" });
      expect(fake.calls.settle).toBe(0);
      expect(agent.totalSpent).toBe(0n);
    });

    it("does not pay when nobody answers in time", async () => {
      idp.mode = "pending";
      const agent = new Agent(config({ approvalTimeoutMs: 2_500 }), deps());
      await expect(agent.runJob("small")).rejects.toMatchObject({ code: "approval_timeout" });
      expect(fake.calls.settle).toBe(0);
    });

    it("needs no approval for a job at or below the threshold", async () => {
      const agent = new Agent(config(), deps());
      const r = await agent.runJob("tiny");
      expect(r.approvalId).toBeNull();
      expect(approvals).toHaveLength(0);
    });
  });

  describe("helpers", () => {
    it("prices HBAR at tinybars = units x 100 and tokens 1:1", () => {
      expect(expectedAmount("500000", "0.0.0")).toBe(50_000_000n);
      expect(expectedAmount("500000", "0.0.429274")).toBe(500_000n);
    });

    it("parses the preset allowlist and rejects unknown names", () => {
      expect(parsePresetList(undefined)).toEqual(["tiny", "small"]);
      expect(parsePresetList("small, tiny")).toEqual(["small", "tiny"]);
      expect(() => parsePresetList("huge")).toThrow(/unknown preset/);
    });
  });

  describe("the real x402 client", () => {
    const required = (asset: string, amount: string): PaymentRequired => ({
      x402Version: 2,
      resource: { url: `${API}/api/jobs`, description: "t", mimeType: "application/json" },
      accepts: [{ scheme: "exact", network: "hedera:testnet", amount, asset, payTo: "0.0.1234", maxTimeoutSeconds: 120, extra: { feePayer: "0.0.9185802" } }],
    });
    const key = "0x" + "11".repeat(32);

    it("signs a HBAR payment offline within the cap", async () => {
      const pay = makeHederaPayer({ accountId: "0.0.5555", privateKey: key, network: "hedera:testnet", asset: "0.0.0", maxAmount: 50_000_000n });
      const header = await pay(required("0.0.0", "50000000"));
      expect(header.length).toBeGreaterThan(100);
    });

    it("refuses to sign above its own per-payment cap, or in another asset", async () => {
      const pay = makeHederaPayer({ accountId: "0.0.5555", privateKey: key, network: "hedera:testnet", asset: "0.0.0", maxAmount: 50_000_000n });
      await expect(pay(required("0.0.0", "50000001"))).rejects.toThrow();
      await expect(pay(required("0.0.429274", "1000"))).rejects.toThrow();
    });
  });
});
