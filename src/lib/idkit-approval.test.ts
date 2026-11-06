import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/server", () => ({ connection: async () => {} }));

import { randomBytes } from "node:crypto";
import { encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentRequired } from "@x402/core/types";
import { GET as approvalGet } from "@/app/api/approvals/[id]/route";
import { POST as cancelPost } from "@/app/api/approvals/[id]/cancel/route";
import { POST as idkitPost } from "@/app/api/approvals/[id]/idkit/route";
import { POST as approvalsPost } from "@/app/api/approvals/route";
import { POST as jobsPost } from "@/app/api/jobs/route";
import { POST as rpContextPost } from "@/app/api/world/rp-context/route";
import { Agent, AgentRefusal } from "./agent";
import type { AgentConfig, AgentDeps } from "./agent";
import { ApprovalError, checkApproval, consumeApproval, createApproval } from "./approvals";
import type { ApprovalParams } from "./approvals";
import { getDb } from "./db";
import { resetEnvCache } from "./env";
import { startFakeFacilitator } from "./fake-facilitator";
import type { FakeFacilitator } from "./fake-facilitator";
import { IDP_CLIENT_ID, IDP_CLIENT_SECRET, startFakeIdp } from "./fake-idp";
import type { FakeIdp } from "./fake-idp";
import { listJobs } from "./jobs";
import { setupTestEnv, TEST_REQUESTER } from "./testing";
import { approvalAction, consumeNullifier } from "./world";
import { resetX402 } from "./x402";

const RP = "rp_test123";
const NULL1 = "0x04e5f60000000000000000000000000000000000000000000000000000000001";
const realFetch = globalThis.fetch;

const PARAMS: ApprovalParams = { purpose: "create-job", requester: TEST_REQUESTER, type: "render", preset: "small", price: "500000" };

const proof = (action: string, nullifier = NULL1, over: Record<string, unknown> = {}) => ({
  protocol_version: "4.0",
  nonce: "n",
  action,
  environment: "production",
  responses: [{ identifier: "proof_of_human", nullifier, proof: ["0x1", "0x2", "0x3", "0x4", "0x5"], signal_hash: "0x0", issuer_schema_id: 1, expires_at_min: 1 }],
  ...over,
});

type WorldMode = "ok" | "invalid" | "down";
let world: { mode: WorldMode; calls: number };

/** Fake World verify endpoint; everything else (local fake facilitator and IdP) goes to the real fetch. */
const stubFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (!url.includes("/api/v4/verify/")) return realFetch(input, init);
  world.calls += 1;
  if (world.mode === "down") return new Response("down", { status: 503 });
  if (world.mode === "invalid") return Response.json({ success: false, code: "invalid_proof", detail: "proof does not verify" }, { status: 400 });
  return Response.json({ success: true, environment: "production" });
}) as typeof fetch;

const json = (url: string, body: unknown) => new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const answer = (id: string, result: unknown) => idkitPost(json(`http://x/api/approvals/${id}/idkit`, { result }), params(id));
const status = async (id: string) => ((await (await approvalGet(new Request("http://x"), params(id))).json()) as { status: string }).status;

/** Routes called in-process, so the agent talks to the real handlers. */
const inProcessFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  const req = new Request(url, init);
  if (url.pathname === "/api/jobs" && req.method === "POST") return jobsPost(req);
  if (url.pathname === "/api/approvals" && req.method === "POST") return approvalsPost(req);
  const m = /^\/api\/approvals\/([^/]+)$/.exec(url.pathname);
  if (m) return approvalGet(req, params(m[1]));
  return new Response("not found", { status: 404 });
}) as typeof fetch;

describe("World ID approval of an agent spend (IDKit fallback)", () => {
  let cleanup: () => void;
  let fake: FakeFacilitator;
  let idp: FakeIdp;

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
      WORLD_RP_ID: RP,
      WORLD_SIGNING_KEY: randomBytes(32).toString("hex"),
      NEXT_PUBLIC_WORLD_APP_ID: "app_test123",
      API_PUBLIC_URL: "https://mesh.test",
      AGENT_APPROVAL_THRESHOLD: "100000",
      X402_ENABLED: "true",
      X402_FACILITATOR_URL: fake.url,
      X402_PAY_TO: "0.0.1234",
      X402_ASSET: "0.0.0",
      MIRROR_NODE_URL: fake.url,
    });
    resetEnvCache();
    resetX402();
    world = { mode: "ok", calls: 0 };
    fake.verify = "valid";
    fake.settle = "ok";
    fake.calls = { verify: 0, settle: 0 };
    vi.stubGlobal("fetch", stubFetch);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  describe("creating an approval", () => {
    it("uses a World ID proof when only IDKit is configured", async () => {
      const a = await createApproval(PARAMS);
      expect(a).toMatchObject({ method: "idkit", status: "pending", interval: 2, verificationUri: `https://mesh.test/approve/${a.approvalId}` });
      expect(a.userCode).toMatch(/^[0-9A-F]{4}-[0-9A-F]{4}$/);
      expect(a.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
      expect(JSON.stringify(a)).not.toContain("device_code");
    });

    it("still prefers the World IdP device grant when that client is configured", async () => {
      Object.assign(process.env, { WORLD_IDP_ISSUER: idp.url, WORLD_IDP_CLIENT_ID: IDP_CLIENT_ID, WORLD_IDP_CLIENT_SECRET: IDP_CLIENT_SECRET });
      resetEnvCache();
      const a = await createApproval(PARAMS);
      expect(a.method).toBe("device");
      expect(a.verificationUri).toContain("world.test");
    });

    it("fails clearly when neither World product is configured", async () => {
      Object.assign(process.env, { WORLD_RP_ID: "", WORLD_SIGNING_KEY: "", NEXT_PUBLIC_WORLD_APP_ID: "" });
      resetEnvCache();
      await expect(createApproval(PARAMS)).rejects.toMatchObject({ code: "not_configured" });
    });

    it("the POST /api/approvals route returns an idkit approval", async () => {
      const res = await approvalsPost(json("http://x/api/approvals", { type: "render", preset: "small", requester: TEST_REQUESTER }));
      expect(res.status).toBe(201);
      expect((await res.json()).method).toBe("idkit");
    });
  });

  describe("the IDKit request", () => {
    it("is signed for the approval's own action, only while it is pending", async () => {
      const a = await createApproval(PARAMS);
      const res = await rpContextPost(json("http://x", { action: "approve-spend", approvalId: a.approvalId }));
      expect(res.status).toBe(200);
      const ctx = await res.json();
      expect(ctx.action).toBe(approvalAction(a.approvalId));
      expect(ctx.rp_context.signature).toBeTruthy();

      await cancelPost(new Request("http://x", { method: "POST" }), params(a.approvalId));
      expect((await rpContextPost(json("http://x", { action: "approve-spend", approvalId: a.approvalId }))).status).toBe(409);
    });

    it("refuses an unknown approval, a malformed id and a device-grant approval", async () => {
      expect((await rpContextPost(json("http://x", { action: "approve-spend", approvalId: "11111111-1111-1111-1111-111111111111" }))).status).toBe(404);
      expect((await rpContextPost(json("http://x", { action: "approve-spend", approvalId: "nope" }))).status).toBe(400);
      expect((await rpContextPost(json("http://x", { action: "approve-anything" }))).status).toBe(400);

      Object.assign(process.env, { WORLD_IDP_ISSUER: idp.url, WORLD_IDP_CLIENT_ID: IDP_CLIENT_ID, WORLD_IDP_CLIENT_SECRET: IDP_CLIENT_SECRET });
      resetEnvCache();
      const device = await createApproval(PARAMS);
      expect((await rpContextPost(json("http://x", { action: "approve-spend", approvalId: device.approvalId }))).status).toBe(400);
    });
  });

  describe("answering with a proof", () => {
    it("a valid proof approves it, for exactly this job", async () => {
      const a = await createApproval(PARAMS);
      const res = await answer(a.approvalId, proof(approvalAction(a.approvalId)));
      expect(res.status).toBe(200);
      expect((await res.json()).status).toBe("approved");
      expect(checkApproval(a.approvalId, PARAMS).subject).toBe(`world-id|${NULL1}`);
      // bound to the job: a bigger job is not covered
      expect(() => checkApproval(a.approvalId, { ...PARAMS, preset: "full", price: "1000000" })).toThrow(ApprovalError);
      expect(world.calls).toBe(1);
    });

    it("answering twice is harmless and does not call World again", async () => {
      const a = await createApproval(PARAMS);
      await answer(a.approvalId, proof(approvalAction(a.approvalId)));
      const again = await answer(a.approvalId, proof(approvalAction(a.approvalId)));
      expect(again.status).toBe(200);
      expect(world.calls).toBe(1);
    });

    it("a proof made for another action or another approval authorizes nothing", async () => {
      const a = await createApproval(PARAMS);
      const b = await createApproval(PARAMS);
      for (const action of ["register-provider", approvalAction(b.approvalId)]) {
        const res = await answer(a.approvalId, proof(action));
        expect(res.status).toBe(401);
        expect((await res.json()).reason).toBe("wrong_action");
      }
      expect(await status(a.approvalId)).toBe("pending");
      expect(() => checkApproval(a.approvalId, PARAMS)).toThrow(/not approved/);
      expect(world.calls).toBe(0); // rejected before World was asked
    });

    it("a wrong environment, a missing proof and a proof without a nullifier are refused", async () => {
      const a = await createApproval(PARAMS);
      const act = approvalAction(a.approvalId);
      expect((await answer(a.approvalId, proof(act, NULL1, { environment: "staging" }))).status).toBe(401);
      expect((await answer(a.approvalId, undefined)).status).toBe(401);
      expect((await answer(a.approvalId, proof(act, NULL1, { responses: [] }))).status).toBe(401);
      expect(await status(a.approvalId)).toBe("pending");
    });

    it("a proof World rejects leaves it pending", async () => {
      const a = await createApproval(PARAMS);
      world.mode = "invalid";
      const res = await answer(a.approvalId, proof(approvalAction(a.approvalId)));
      expect(res.status).toBe(401);
      expect((await res.json()).reason).toBe("invalid_proof");
      expect(await status(a.approvalId)).toBe("pending");
    });

    it("a World outage is 503 and never an approval", async () => {
      const a = await createApproval(PARAMS);
      world.mode = "down";
      const res = await answer(a.approvalId, proof(approvalAction(a.approvalId)));
      expect(res.status).toBe(503);
      expect(await status(a.approvalId)).toBe("pending");
    });

    it("a nullifier already tied to another approval is refused", async () => {
      const a = await createApproval(PARAMS);
      consumeNullifier(NULL1, approvalAction(a.approvalId), "some-other-approval");
      const res = await answer(a.approvalId, proof(approvalAction(a.approvalId)));
      expect(res.status).toBe(401);
      expect((await res.json()).reason).toBe("nullifier_reused");
      expect(await status(a.approvalId)).toBe("pending");
    });

    it("an expired approval cannot be approved", async () => {
      const a = await createApproval(PARAMS);
      getDb().prepare("UPDATE approvals SET expires_at = ? WHERE approval_id = ?").run(Math.floor(Date.now() / 1000) - 5, a.approvalId);
      const res = await answer(a.approvalId, proof(approvalAction(a.approvalId)));
      expect(res.status).toBe(409);
      expect((await res.json()).error).toBe("expired");
      expect(await status(a.approvalId)).toBe("expired");
      expect(world.calls).toBe(0);
    });

    it("a cancelled approval stays denied even if a valid proof arrives later", async () => {
      const a = await createApproval(PARAMS);
      const c = await cancelPost(new Request("http://x", { method: "POST" }), params(a.approvalId));
      expect((await c.json()).status).toBe("denied");
      const res = await answer(a.approvalId, proof(approvalAction(a.approvalId)));
      expect(res.status).toBe(409);
      expect(() => checkApproval(a.approvalId, PARAMS)).toThrow(/did not approve|cancelled/);
      expect(world.calls).toBe(0);
    });

    it("a spent approval cannot be answered again", async () => {
      const a = await createApproval(PARAMS);
      await answer(a.approvalId, proof(approvalAction(a.approvalId)));
      consumeApproval(a.approvalId, PARAMS);
      expect((await answer(a.approvalId, proof(approvalAction(a.approvalId)))).status).toBe(409);
      expect(() => consumeApproval(a.approvalId, PARAMS)).toThrow(/already used/);
    });

    it("answering an unknown approval is 404, a device approval is 400", async () => {
      expect((await answer("11111111-1111-1111-1111-111111111111", proof("x"))).status).toBe(404);
      Object.assign(process.env, { WORLD_IDP_ISSUER: idp.url, WORLD_IDP_CLIENT_ID: IDP_CLIENT_ID, WORLD_IDP_CLIENT_SECRET: IDP_CLIENT_SECRET });
      resetEnvCache();
      const device = await createApproval(PARAMS);
      expect((await answer(device.approvalId, proof(approvalAction(device.approvalId)))).status).toBe(400);
    });
  });

  describe("an agent that needs a human", () => {
    const config: AgentConfig = { apiUrl: "https://mesh.test", requester: TEST_REQUESTER, budget: 1_000_000n, perJobCap: 500_000n, allowedPresets: ["tiny", "small"], asset: "0.0.0", approvalTimeoutMs: 5_000 };
    const fakePay: AgentDeps["pay"] = async (pr: PaymentRequired) => encodePaymentSignatureHeader({ x402Version: 2, resource: pr.resource, accepted: pr.accepts[0], payload: { transaction: `tx-${Math.random()}` } });

    /** The "human": reacts to the approval link the agent prints. */
    function agentWith(human: (id: string) => Promise<unknown>): Agent {
      let pending: Promise<unknown> = Promise.resolve();
      const deps: AgentDeps = {
        fetch: inProcessFetch,
        pay: fakePay,
        onApprovalNeeded: (a) => {
          pending = human(a.verificationUri.split("/approve/")[1]);
        },
        log: () => {},
        sleep: async () => {
          await pending; // the human has answered before the agent polls
        },
      };
      return new Agent(config, deps);
    }

    it("creates and pays for the job only after the human proves who they are", async () => {
      const agent = agentWith((id) => answer(id, proof(approvalAction(id))));
      const r = await agent.runJob("small");
      expect(r.approvalId).toMatch(/^[0-9a-f-]{36}$/);
      expect(r.paymentTx).not.toBeNull();
      expect(listJobs()).toHaveLength(1);
      expect(fake.calls.settle).toBe(1);
      expect(world.calls).toBe(1);
    });

    it("a cancelled approval creates no job and moves no money", async () => {
      const agent = agentWith((id) => cancelPost(new Request("http://x", { method: "POST" }), params(id)));
      await expect(agent.runJob("small")).rejects.toMatchObject({ code: "approval_denied" });
      expect(listJobs()).toHaveLength(0);
      expect(fake.calls.settle).toBe(0);
      expect(agent.totalSpent).toBe(0n);
    });

    it("a proof World rejects, followed by no answer, creates no job", async () => {
      world.mode = "invalid";
      const agent = new Agent({ ...config, approvalTimeoutMs: 2_500 }, {
        fetch: inProcessFetch,
        pay: fakePay,
        onApprovalNeeded: (a) => void answer(a.verificationUri.split("/approve/")[1], proof(approvalAction(a.verificationUri.split("/approve/")[1]))),
        log: () => {},
        sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 1200))),
      });
      await expect(agent.runJob("small")).rejects.toBeInstanceOf(AgentRefusal);
      expect(listJobs()).toHaveLength(0);
      expect(fake.calls.settle).toBe(0);
    });

    it("a job at or below the threshold needs no human", async () => {
      const agent = agentWith(async () => {
        throw new Error("no human should be asked");
      });
      const r = await agent.runJob("tiny");
      expect(r.approvalId).toBeNull();
      expect(world.calls).toBe(0);
    });
  });
});
