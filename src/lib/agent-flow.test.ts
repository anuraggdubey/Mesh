import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/server", () => ({ connection: async () => {} }));

import { encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentRequired } from "@x402/core/types";
import { POST as planPost } from "@/app/api/agent/plan/route";
import { POST as runPost } from "@/app/api/agent/run/route";
import { GET as runGet } from "@/app/api/agent/runs/[id]/route";
import { GET as approvalGet } from "@/app/api/approvals/[id]/route";
import { POST as approvalPost } from "@/app/api/approvals/route";
import { POST as jobsPost } from "@/app/api/jobs/route";
import { executeRun, getRun, listRuns, RunError, setRunDeps, startRun } from "./agent-runner";
import type { RunDeps } from "./agent-runner";
import { creditDeposit, getBalance, listLedger } from "./credits";
import { getDb } from "./db";
import { resetEnvCache } from "./env";
import { startFakeFacilitator } from "./fake-facilitator";
import type { FakeFacilitator } from "./fake-facilitator";
import { IDP_CLIENT_ID, IDP_CLIENT_SECRET, startFakeIdp } from "./fake-idp";
import type { FakeIdp } from "./fake-idp";
import { FAKE_OG_KEY, startFakeOg } from "./fake-og";
import type { FakeOg } from "./fake-og";
import { getJob, listEvents } from "./jobs";
import { createPlan, consumePlan, getPlan, PlanError, PLAN_TTL_SECONDS } from "./plans";
import { resetRateLimits } from "./rate-limit";
import { setupTestEnv } from "./testing";
import { get, other, post, signIn, user } from "./testing-wallet";
import { resetX402 } from "./x402";

const HBAR = 100_000_000;
const tx = (n: number) => "0x" + n.toString(16).padStart(64, "0");

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

describe("planning with 0G, and the agent paying for the user", () => {
  let fake: FakeFacilitator;
  let idp: FakeIdp;
  let og: FakeOg;
  let cleanup: () => void;
  let cookie: string;

  const deps = (over: Partial<RunDeps> = {}): RunDeps => ({ fetch: inProcessFetch, pay: fakePay, sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 150))), apiUrl: "http://localhost:3000", ...over });

  beforeAll(async () => {
    fake = await startFakeFacilitator();
    idp = await startFakeIdp();
    og = await startFakeOg();
  });
  afterAll(async () => {
    await fake.stop();
    await idp.stop();
    await og.stop();
  });

  beforeEach(async () => {
    cleanup = setupTestEnv();
    Object.assign(process.env, {
      MESH_SESSION_SECRET: "a-test-session-secret-0123456789",
      AGENT_DEPOSIT_ADDRESS: "0x00000000000000000000000000000000000000A1",
      X402_ENABLED: "true",
      X402_FACILITATOR_URL: fake.url,
      X402_PAY_TO: "0.0.1234",
      X402_ASSET: "0.0.0",
      MIRROR_NODE_URL: fake.url,
      WORLD_IDP_ISSUER: idp.url,
      WORLD_IDP_CLIENT_ID: IDP_CLIENT_ID,
      WORLD_IDP_CLIENT_SECRET: IDP_CLIENT_SECRET,
      OG_API_KEY: FAKE_OG_KEY,
      OG_API_BASE_URL: og.url,
      OG_MODEL: "test-model",
    });
    resetEnvCache();
    resetX402();
    resetRateLimits();
    fake.verify = "valid";
    fake.settle = "ok";
    fake.calls = { verify: 0, settle: 0 };
    idp.mode = "approved";
    og.mode = "ok";
    og.tee = true;
    og.signature = "none";
    og.answer = JSON.stringify({ preset: "small", reason: "A quick, detailed render fits best." });
    og.requests = [];
    cookie = await signIn();
  });
  afterEach(() => {
    setRunDeps(null);
    cleanup();
  });

  const plan = async (body: unknown) => planPost(post("/api/agent/plan", body, cookie));
  const planOf = async (preset: "tiny" | "small" | "full" = "small") => createPlan({ address: user.address, preset, reason: "r", prompt: "p", og: null });

  describe("POST /api/agent/plan (0G)", () => {
    it("needs a session", async () => {
      expect((await planPost(post("/api/agent/plan", { prompt: "make a render" }))).status).toBe(401);
    });

    it("turns the user's words into a plan with 0G, keeping the request id and how it was verified", async () => {
      const res = await plan({ prompt: "I need a quick, detailed render for a slide" });
      expect(res.status).toBe(200);
      const { plan: p } = await res.json();
      expect(p).toMatchObject({ source: "og", preset: "small", price: "500000", priceHbar: "0.5", reason: "A quick, detailed render fits best." });
      expect(p.og).toMatchObject({ requestId: "req_0g_123456", verification: "router-checked", teeVerified: true });
      // the model was asked in plain chat, with the user's words as data, TEE verification on, and no key in the body
      const call = og.requests.find((r) => r.path === "/v1/chat/completions");
      expect(call?.auth).toBe(`Bearer ${FAKE_OG_KEY}`);
      expect(call?.body).toMatchObject({ verify_tee: true, model: "test-model" });
      expect(JSON.stringify(call?.body)).not.toContain(FAKE_OG_KEY);
    });

    it("accepts a fenced JSON answer, and says 'unverified' when the Router did not verify", async () => {
      og.answer = '```json\n{"preset":"tiny","reason":"A test."}\n```';
      og.tee = false;
      const { plan: p } = await (await plan({ prompt: "just a test please" })).json();
      expect(p).toMatchObject({ preset: "tiny", og: { verification: "unverified", teeVerified: false } });
    });

    it("claims a TEE signature only when the provider's signature really checked out", async () => {
      process.env.OG_SIGNER_ADDRESS = (await import("./fake-og")).FAKE_OG_SIGNER;
      process.env.OG_SIGNATURE_BASE_URL = og.origin;
      resetEnvCache();
      og.signature = "good";
      expect((await (await plan({ prompt: "a signed answer please" })).json()).plan.og.verification).toBe("tee-signature");
      og.signature = "bad-signer";
      expect((await (await plan({ prompt: "a forged answer please" })).json()).plan.og.verification).toBe("unverified");
    });

    it.each([
      ["not JSON", "I think you should use the small one"],
      ["an unknown size", JSON.stringify({ preset: "huge", reason: "big" })],
      ["a missing reason", JSON.stringify({ preset: "small" })],
      ["an array", JSON.stringify(["small"])],
    ])("refuses a model answer that is %s: an error with manual choices, and no plan is stored", async (_n, answer) => {
      og.answer = answer;
      const res = await plan({ prompt: "make me something" });
      expect(res.status).toBe(502);
      const body = await res.json();
      expect(body.error).toBe("og_bad_response");
      expect(body.manual.presets).toEqual(["tiny", "small", "full"]);
      expect(getDb().prepare("SELECT COUNT(*) AS n FROM plans").get()).toEqual({ n: 0 });
    });

    it("says so when the 0G account has no credit, is rate limited, or is down, and offers manual choices (never a fake 0G plan)", async () => {
      og.mode = "no-credit";
      let res = await plan({ prompt: "plan with no credit" });
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ error: "og_no_credit", manual: { presets: ["tiny", "small", "full"] } });

      og.mode = "rate-limit-always";
      res = await plan({ prompt: "plan while limited" });
      expect(res.status).toBe(429);
      expect((await res.json()).error).toBe("og_rate_limited");

      og.mode = "error";
      res = await plan({ prompt: "plan during an outage" });
      expect(res.status).toBe(503);
      expect((await res.json()).error).toBe("og_unavailable");
      expect(getDb().prepare("SELECT COUNT(*) AS n FROM plans").get()).toEqual({ n: 0 });
    });

    it("answers 503 with manual choices when no 0G key is set", async () => {
      process.env.OG_API_KEY = "";
      resetEnvCache();
      const res = await plan({ prompt: "plan without a key" });
      expect(res.status).toBe(503);
      expect((await res.json()).error).toBe("og_not_configured");
    });

    it("a manual size is a plan labelled manual, with no 0G request id", async () => {
      const { plan: p } = await (await plan({ preset: "full" })).json();
      expect(p).toMatchObject({ source: "manual", preset: "full", price: "1000000", priceHbar: "1", og: null });
      expect(og.requests).toHaveLength(0); // 0G was not called
    });

    it("validates the body and rate limits the 0G calls", async () => {
      expect((await plan({})).status).toBe(400);
      expect((await plan({ prompt: "ab" })).status).toBe(400);
      expect((await plan({ preset: "huge" })).status).toBe(400);
      let last = 200;
      for (let i = 0; i < 12; i++) last = (await plan({ prompt: "a perfectly fine request" })).status;
      expect(last).toBe(429);
    });
  });

  describe("plans are single use, short lived and private", () => {
    it("belongs to its wallet, can be used once, and expires", async () => {
      const p = await planOf();
      expect(() => consumePlan(p.planId, other.address, "r1")).toThrow(PlanError);
      expect(getPlan(p.planId)?.status).toBe("planned");
      consumePlan(p.planId, user.address, "r1");
      expect(() => consumePlan(p.planId, user.address, "r2")).toThrow(/already used/);
      const q = await planOf();
      getDb().prepare("UPDATE plans SET expires_at = ? WHERE plan_id = ?").run(Math.floor(Date.now() / 1000) - 1, q.planId);
      expect(() => consumePlan(q.planId, user.address, "r3")).toThrow(/expired/);
      expect(PLAN_TTL_SECONDS).toBe(600);
    });
  });

  describe("the agent runs a plan", () => {
    it("pays for the job from the user's credit: debited exactly once, job created for the user's address, plan recorded on it", async () => {
      creditDeposit(user.address, 2 * HBAR, tx(1));
      const p = await planOf("small");
      const { run, done } = await startRun(user.address, p.planId, deps());
      await done;
      const final = await getRun(run.runId, user.address);
      expect(final.status).toBe("paid");
      expect(final.jobId).toMatch(/^0x[0-9a-f]{64}$/);
      expect(final.paymentTx).toBe("0.0.9185802@1793900000.123456789");
      expect(getBalance(user.address)).toBe(2 * HBAR - 50_000_000); // 0.5 HBAR, once
      expect(listLedger(user.address).map((l) => l.kind).sort()).toEqual(["deposit", "job_hold"]);
      expect(fake.calls.settle).toBe(1);

      const job = getJob(final.jobId!)!;
      expect(job.requester.toLowerCase()).toBe(user.address.toLowerCase());
      expect(job.payment?.transaction).toBe(final.paymentTx);
      expect(job.plan).toMatchObject({ planId: p.planId, source: "manual", preset: "small", requestId: null });
      expect(getPlan(p.planId)?.status).toBe("used");
    });

    it("records the 0G request id on the job and in the audit events, without the user's own words", async () => {
      creditDeposit(user.address, 2 * HBAR, tx(2));
      const planned = (await (await plan({ prompt: "my secret project needs a render" })).json()).plan;
      const { done, run } = await startRun(user.address, planned.planId, deps());
      await done;
      const job = getJob((await getRun(run.runId, user.address)).jobId!)!;
      expect(job.plan).toMatchObject({ source: "og", requestId: "req_0g_123456", verification: "router-checked" });
      const ev = listEvents(job.jobId).find((e) => e.type === "plan");
      expect(ev?.data).toMatchObject({ requestId: "req_0g_123456", source: "og" });
      expect(JSON.stringify(ev?.data)).not.toContain("secret project");
    });

    it("refuses when the credit does not cover the job, moves no money, and does not use up the plan", async () => {
      creditDeposit(user.address, 10_000_000, tx(3)); // 0.1 HBAR
      const p = await planOf("small");
      await expect(startRun(user.address, p.planId, deps())).rejects.toMatchObject({ code: "insufficient_credit", status: 402 });
      expect(getBalance(user.address)).toBe(10_000_000);
      expect(getPlan(p.planId)?.status).toBe("planned"); // still usable after a deposit
      creditDeposit(user.address, 100_000_000, tx(4));
      const { done } = await startRun(user.address, p.planId, deps());
      await done;
      expect(getBalance(user.address)).toBe(110_000_000 - 50_000_000);
    });

    it("refunds the hold when the payment fails, and leaves no job", async () => {
      creditDeposit(user.address, 2 * HBAR, tx(5));
      fake.verify = "invalid";
      const p = await planOf("small");
      const { done, run } = await startRun(user.address, p.planId, deps());
      await done;
      const final = await getRun(run.runId, user.address);
      expect(final.status).toBe("failed");
      expect(final.error).toMatch(/payment/i);
      expect(getBalance(user.address)).toBe(2 * HBAR); // nothing lost
      expect(fake.calls.settle).toBe(0);
      expect(listLedger(user.address).map((l) => l.kind).sort()).toEqual(["deposit", "job_hold", "job_refund"]);
      expect(getDb().prepare("SELECT COUNT(*) AS n FROM jobs").get()).toEqual({ n: 0 });
    });

    it("another wallet cannot run your plan or read your run", async () => {
      creditDeposit(user.address, 2 * HBAR, tx(6));
      creditDeposit(other.address, 2 * HBAR, tx(7));
      const p = await planOf("tiny");
      await expect(startRun(other.address, p.planId, deps())).rejects.toBeInstanceOf(PlanError);
      const { done, run } = await startRun(user.address, p.planId, deps());
      await done;
      await expect(getRun(run.runId, other.address)).rejects.toBeInstanceOf(RunError);
      const otherCookie = await signIn(other);
      expect((await runGet(get(`/api/agent/runs/${run.runId}`, otherCookie), { params: Promise.resolve({ id: run.runId }) })).status).toBe(404);
      expect((await runGet(get(`/api/agent/runs/${run.runId}`, cookie), { params: Promise.resolve({ id: run.runId }) })).status).toBe(200);
    });

    it("a plan cannot be run twice", async () => {
      creditDeposit(user.address, 2 * HBAR, tx(8));
      const p = await planOf("tiny");
      const first = await startRun(user.address, p.planId, deps());
      await first.done;
      await expect(startRun(user.address, p.planId, deps())).rejects.toMatchObject({ code: "plan_used" });
      expect(getBalance(user.address)).toBe(2 * HBAR - 10_000_000);
    });

    it("never lets concurrent runs spend more than the balance", async () => {
      creditDeposit(user.address, 60_000_000, tx(9)); // 0.6 HBAR: one small (0.5), not two
      const plans = await Promise.all([planOf("small"), planOf("small"), planOf("small")]);
      const results = await Promise.allSettled(plans.map((p) => startRun(user.address, p.planId, deps())));
      const started = results.filter((r) => r.status === "fulfilled");
      expect(started).toHaveLength(1);
      expect(results.filter((r) => r.status === "rejected")).toHaveLength(2);
      await Promise.all(started.map((r) => (r as PromiseFulfilledResult<{ done: Promise<void> }>).value.done));
      expect(getBalance(user.address)).toBe(10_000_000);
      expect(getBalance(user.address)).toBeGreaterThanOrEqual(0);
      expect(fake.calls.settle).toBe(1);
    });

    it("POST /api/agent/run and GET /api/agent/runs/:id work end to end with the session cookie", async () => {
      creditDeposit(user.address, 2 * HBAR, tx(10));
      const p = await planOf("tiny");
      setRunDeps(deps());
      const res = await runPost(post("/api/agent/run", { planId: p.planId }, cookie));
      expect(res.status).toBe(202);
      const { run } = await res.json();
      expect(["queued", "paying", "paid"]).toContain(run.status);
      expect(run.receiptId).toMatch(/^rcpt_/);
      for (let i = 0; i < 40; i++) {
        const body = await (await runGet(get(`/api/agent/runs/${run.runId}`, cookie), { params: Promise.resolve({ id: run.runId }) })).json();
        if (body.run.status === "paid") {
          expect(body.run.jobId).toBeTruthy();
          expect(body.balanceTinybars).toBe(2 * HBAR - 10_000_000);
          return;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error("the run did not finish");
    });

    it("rejects a bad body, a missing session and a plan that does not exist", async () => {
      expect((await runPost(post("/api/agent/run", { planId: "x" }, cookie))).status).toBe(400);
      expect((await runPost(post("/api/agent/run", { planId: "11111111-2222-4333-8444-555555555555" }))).status).toBe(401);
      expect((await runPost(post("/api/agent/run", { planId: "11111111-2222-4333-8444-555555555555" }, cookie))).status).toBe(404);
    });

    it("answers 503 when the server cannot take payments", async () => {
      process.env.X402_ENABLED = "false";
      resetEnvCache();
      creditDeposit(user.address, 2 * HBAR, tx(11));
      const p = await planOf("tiny");
      await expect(startRun(user.address, p.planId, deps())).rejects.toMatchObject({ code: "payments_not_configured", status: 503 });
      expect(getBalance(user.address)).toBe(2 * HBAR);
    });

    it("returns held credit for a run that never finished", async () => {
      creditDeposit(user.address, 2 * HBAR, tx(12));
      const p = await planOf("tiny");
      // a run row left behind by a restart: held, but nothing is working on it
      const { run, done } = await startRun(user.address, p.planId, deps({ fetch: (() => new Promise(() => {})) as typeof fetch }));
      void done;
      expect(getBalance(user.address)).toBe(2 * HBAR - 10_000_000);
      getDb().prepare("UPDATE runs SET updated_at = ? WHERE run_id = ?").run(Math.floor(Date.now() / 1000) - 3600, run.runId);
      (globalThis as unknown as { __meshRuns: Set<string> }).__meshRuns.delete(run.runId);
      const view = await getRun(run.runId, user.address);
      expect(view.status).toBe("failed");
      expect(getBalance(user.address)).toBe(2 * HBAR);
      expect(listRuns(user.address)).toHaveLength(1);
    });
  });

  describe("human approval above the threshold", () => {
    beforeEach(() => {
      process.env.AGENT_APPROVAL_THRESHOLD = "100000";
      resetEnvCache();
    });

    it("waits in needs_approval with the link and code, then pays once the human approves", async () => {
      creditDeposit(user.address, 2 * HBAR, tx(20));
      idp.mode = "pending";
      const p = await planOf("small");
      const { run, done } = await startRun(user.address, p.planId, deps());
      expect(run.status).toBe("needs_approval");
      expect(run.approvalUrl).toContain("https://world.test/verify");
      expect(run.userCode).toBe("ABCD-1234");
      expect(getBalance(user.address)).toBe(2 * HBAR - 50_000_000); // held while waiting
      expect(fake.calls.settle).toBe(0);

      idp.mode = "approved"; // the human approves in World
      await done;
      const final = await getRun(run.runId, user.address);
      expect(final.status).toBe("paid");
      expect(final.approvalUrl).toBeNull();
      expect(getJob(final.jobId!)?.approvalId).toBeTruthy();
      expect(getBalance(user.address)).toBe(2 * HBAR - 50_000_000);
      expect(fake.calls.settle).toBe(1);
    }, 30_000);

    it("returns the credit and pays nothing when the human denies", async () => {
      creditDeposit(user.address, 2 * HBAR, tx(21));
      idp.mode = "denied";
      const p = await planOf("small");
      const { done, run } = await startRun(user.address, p.planId, deps());
      await done;
      const final = await getRun(run.runId, user.address);
      expect(final.status).toBe("failed");
      expect(final.error).toMatch(/approve|denied/i);
      expect(getBalance(user.address)).toBe(2 * HBAR);
      expect(fake.calls.settle).toBe(0);
      expect(getDb().prepare("SELECT COUNT(*) AS n FROM jobs").get()).toEqual({ n: 0 });
    }, 30_000);

    it("a job at or below the threshold needs no approval", async () => {
      creditDeposit(user.address, 2 * HBAR, tx(22));
      const p = await planOf("tiny");
      const { done, run } = await startRun(user.address, p.planId, deps());
      await done;
      expect((await getRun(run.runId, user.address)).status).toBe("paid");
    });
  });

  it("executeRun settles a run row it is given, even directly", async () => {
    creditDeposit(user.address, 2 * HBAR, tx(30));
    const p = await planOf("tiny");
    const { done } = await startRun(user.address, p.planId, deps());
    await done;
    await expect(executeRun("no-such-run", getPlan(p.planId)!, 1, deps())).resolves.toBeUndefined();
  });
});
