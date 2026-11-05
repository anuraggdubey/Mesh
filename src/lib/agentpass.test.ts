import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// `connection()` only works inside a real Next.js request.
vi.mock("next/server", () => ({ connection: async () => {} }));

import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import type { JWK } from "jose";
type KeyLike = Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
import { POST as approvalsPost } from "@/app/api/approvals/route";
import { GET as approvalGet } from "@/app/api/approvals/[id]/route";
import { POST as jobsPost, GET as jobsList } from "@/app/api/jobs/route";
import { agentPassConfigured, AgentPassError, pollDeviceGrant, resetAgentPassCaches, startDeviceAuthorization, validateIdToken } from "./agentpass";
import { approvalRequired, bindingFor, consumeApproval, createApproval, getApproval } from "./approvals";
import type { ApprovalParams } from "./approvals";
import { getDb } from "./db";
import { resetEnvCache } from "./env";
import { setupTestEnv, TEST_REQUESTER } from "./testing";

// ───────────────────────── a fake World IdP ─────────────────────────

type Mode = "pending" | "slow_down" | "denied" | "expired" | "invalid_grant" | "down" | "approved";

interface FakeIdp {
  url: string;
  mode: Mode;
  claims: Record<string, unknown>;
  signWith: "good" | "other";
  tokenCalls: number;
  deviceCalls: number;
  stop: () => Promise<void>;
  issue: (over?: Record<string, unknown>, opts?: { key?: "good" | "other"; kid?: string }) => Promise<string>;
}

const CLIENT_ID = "client_test";
const CLIENT_SECRET = "worldidp_client_secret_test";

async function startFakeIdp(): Promise<FakeIdp> {
  const good = await generateKeyPair("RS256");
  const other = await generateKeyPair("RS256");
  const jwk: JWK = { ...(await exportJWK(good.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  const idp = { mode: "approved" as Mode, claims: {} as Record<string, unknown>, tokenCalls: 0, deviceCalls: 0, url: "" } as FakeIdp;

  const keyFor = (which: "good" | "other"): KeyLike => (which === "good" ? good.privateKey : other.privateKey);
  idp.issue = async (over = {}, opts = {}) => {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ acr: "https://world.org/oidc/acr/orb", amr: ["pop"], auth_time: now - 5, ...idp.claims, ...over })
      .setProtectedHeader({ alg: "RS256", kid: opts.kid ?? "k1" })
      .setIssuer(idp.url)
      .setSubject("sub-human-1")
      .setAudience(CLIENT_ID)
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .sign(keyFor(opts.key ?? idp.signWith));
  };
  idp.signWith = "good";

  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const form = new URLSearchParams(Buffer.concat(chunks).toString());
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const authOk = form.get("client_id") === CLIENT_ID && form.get("client_secret") === CLIENT_SECRET;

    if (req.url === "/.well-known/openid-configuration") {
      return send(200, { issuer: idp.url, jwks_uri: `${idp.url}/jwks`, token_endpoint: `${idp.url}/token`, device_authorization_endpoint: `${idp.url}/device` });
    }
    if (req.url === "/jwks") return send(200, { keys: [jwk] });
    if (req.url === "/device") {
      idp.deviceCalls += 1;
      if (!authOk) return send(401, { error: "invalid_client" });
      return send(200, {
        device_code: `dev-${idp.deviceCalls}`,
        user_code: "ABCD-1234",
        verification_uri: "https://world.test/verify",
        verification_uri_complete: "https://world.test/verify?code=ABCD-1234",
        expires_in: 1200,
        interval: 1,
      });
    }
    if (req.url === "/token") {
      idp.tokenCalls += 1;
      if (!authOk) return send(401, { error: "invalid_client" });
      switch (idp.mode) {
        case "pending":
          return send(400, { error: "authorization_pending" });
        case "slow_down":
          return send(400, { error: "slow_down" });
        case "denied":
          return send(400, { error: "access_denied" });
        case "expired":
          return send(400, { error: "expired_token" });
        case "invalid_grant":
          return send(400, { error: "invalid_grant" });
        case "down":
          return send(503, { error: "temporarily_unavailable" });
        case "approved":
          return send(200, { id_token: await idp.issue(), access_token: "opaque", token_type: "Bearer", expires_in: 300 });
      }
    }
    send(404, {});
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  idp.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  idp.stop = () => new Promise<void>((r) => server.close(() => r()));
  return idp;
}

// ───────────────────────── tests ─────────────────────────

const params = (over: Partial<ApprovalParams> = {}): ApprovalParams => ({ purpose: "create-job", requester: TEST_REQUESTER, type: "render", preset: "small", price: "500000", ...over });

describe("World Agent Pass (device grant, ID token validation, approvals)", () => {
  let idp: FakeIdp;
  let cleanup: () => void;

  beforeAll(async () => {
    idp = await startFakeIdp();
  });
  afterAll(() => idp.stop());

  beforeEach(() => {
    cleanup = setupTestEnv();
    process.env.WORLD_IDP_ISSUER = idp.url;
    process.env.WORLD_IDP_CLIENT_ID = CLIENT_ID;
    process.env.WORLD_IDP_CLIENT_SECRET = CLIENT_SECRET;
    process.env.AGENT_APPROVAL_THRESHOLD = "200000";
    process.env.AGENT_APPROVAL_MAX_AGE_SECONDS = "300";
    resetEnvCache();
    resetAgentPassCaches();
    idp.mode = "approved";
    idp.claims = {};
    idp.signWith = "good";
    idp.tokenCalls = 0;
    idp.deviceCalls = 0;
  });
  afterEach(() => cleanup());

  /** Make the next poll due now by rewinding the stored poll time. */
  const makeDue = (id: string) => getDb().prepare("UPDATE approvals SET next_poll_at = 0 WHERE approval_id = ?").run(id);

  describe("device authorization and polling", () => {
    it("is configured only when client id and secret are set", () => {
      expect(agentPassConfigured()).toBe(true);
      process.env.WORLD_IDP_CLIENT_SECRET = "";
      resetEnvCache();
      expect(agentPassConfigured()).toBe(false);
    });

    it("starts a device authorization and returns the human-facing code", async () => {
      const d = await startDeviceAuthorization();
      expect(d).toMatchObject({ userCode: "ABCD-1234", verificationUriComplete: "https://world.test/verify?code=ABCD-1234", expiresIn: 1200, interval: 1 });
      expect(d.deviceCode).toBe("dev-1");
    });

    it("fails clearly with wrong client credentials", async () => {
      process.env.WORLD_IDP_CLIENT_SECRET = "wrong";
      resetEnvCache();
      await expect(startDeviceAuthorization()).rejects.toMatchObject({ code: "request_failed" });
    });

    it("rejects discovery from the wrong issuer", async () => {
      process.env.WORLD_IDP_ISSUER = `${idp.url}/`; // trailing slash is normalised, so use a different host instead
      resetEnvCache();
      resetAgentPassCaches();
      expect(await startDeviceAuthorization()).toBeTruthy();
      process.env.WORLD_IDP_ISSUER = "http://127.0.0.1:1"; // nothing listens there
      resetEnvCache();
      resetAgentPassCaches();
      await expect(startDeviceAuthorization()).rejects.toMatchObject({ code: "discovery_failed" });
    });

    it("maps every poll outcome", async () => {
      const cases: [Mode, string][] = [
        ["pending", "pending"],
        ["slow_down", "slow_down"],
        ["denied", "denied"],
        ["expired", "expired"],
        ["invalid_grant", "expired"],
        ["down", "transient"],
        ["approved", "approved"],
      ];
      for (const [mode, expected] of cases) {
        idp.mode = mode;
        expect((await pollDeviceGrant("dev-x")).status, mode).toBe(expected);
      }
    });

    it("a network failure while polling is transient, never approval", async () => {
      const boom = vi.fn(async (u: string | URL | Request) => {
        if (String(u).includes("/token")) throw new Error("ECONNRESET");
        return fetch(u);
      }) as unknown as typeof fetch;
      expect((await pollDeviceGrant("d", boom)).status).toBe("transient");
    });
  });

  describe("ID token validation", () => {
    it("accepts a good Orb token and returns the identity", async () => {
      const who = await validateIdToken(await idp.issue());
      expect(who).toMatchObject({ issuer: idp.url, sub: "sub-human-1", acr: "https://world.org/oidc/acr/orb", amr: ["pop"] });
    });

    it("rejects a token signed by another key, with an unknown kid, or for another audience/issuer", async () => {
      await expect(validateIdToken(await idp.issue({}, { key: "other" }))).rejects.toBeInstanceOf(AgentPassError);
      await expect(validateIdToken(await idp.issue({}, { kid: "unknown" }))).rejects.toBeInstanceOf(AgentPassError);
      const wrongAud = await new SignJWT({ acr: "https://world.org/oidc/acr/orb", amr: ["pop"], auth_time: Math.floor(Date.now() / 1000) })
        .setProtectedHeader({ alg: "RS256", kid: "k1" })
        .setIssuer(idp.url)
        .setSubject("s")
        .setAudience("someone-else")
        .setExpirationTime("5m")
        .sign((await generateKeyPair("RS256")).privateKey);
      await expect(validateIdToken(wrongAud)).rejects.toBeInstanceOf(AgentPassError);
      await expect(validateIdToken("not.a.jwt")).rejects.toBeInstanceOf(AgentPassError);
    });

    it("rejects an expired token", async () => {
      const t = await new SignJWT({ acr: "https://world.org/oidc/acr/orb", amr: ["pop"], auth_time: 1 })
        .setProtectedHeader({ alg: "RS256", kid: "k1" })
        .setIssuer(idp.url)
        .setSubject("s")
        .setAudience(CLIENT_ID)
        .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
        .sign((await generateKeyPair("RS256")).privateKey);
      await expect(validateIdToken(t)).rejects.toBeInstanceOf(AgentPassError);
    });

    it("enforces the assurance policy: acr, amr and a fresh auth_time", async () => {
      await expect(validateIdToken(await idp.issue({ acr: "https://world.org/oidc/acr/selfie" }))).rejects.toThrow(/not accepted/);
      await expect(validateIdToken(await idp.issue({ acr: undefined }))).rejects.toThrow(/not accepted/);
      await expect(validateIdToken(await idp.issue({ amr: ["mfa"] }))).rejects.toThrow(/amr/);
      await expect(validateIdToken(await idp.issue({ amr: undefined }))).rejects.toThrow(/amr/);
      await expect(validateIdToken(await idp.issue({ auth_time: Math.floor(Date.now() / 1000) - 3600 }))).rejects.toThrow(/too old/);
      await expect(validateIdToken(await idp.issue({ auth_time: Math.floor(Date.now() / 1000) + 3600 }))).rejects.toThrow(/auth_time/);
      await expect(validateIdToken(await idp.issue({ auth_time: undefined }))).rejects.toThrow(/auth_time/);
    });

    it("can accept more than one acr when configured", async () => {
      process.env.WORLD_IDP_ALLOWED_ACR = "https://world.org/oidc/acr/orb, https://world.org/oidc/acr/selfie";
      resetEnvCache();
      expect((await validateIdToken(await idp.issue({ acr: "https://world.org/oidc/acr/selfie" }))).acr).toBe("https://world.org/oidc/acr/selfie");
    });
  });

  describe("approvals", () => {
    it("full journey: pending, then approved after the human acts, then consumed once", async () => {
      idp.mode = "pending";
      const a = await createApproval(params());
      expect(a).toMatchObject({ status: "pending", userCode: "ABCD-1234", verificationUri: "https://world.test/verify?code=ABCD-1234" });
      expect(JSON.stringify(a)).not.toContain("dev-1"); // the device code never leaves the server

      makeDue(a.approvalId);
      expect((await getApproval(a.approvalId)).status).toBe("pending");
      expect(() => consumeApproval(a.approvalId, params())).toThrowError(/not approved yet/);

      idp.mode = "approved";
      makeDue(a.approvalId);
      const done = await getApproval(a.approvalId);
      expect(done.status).toBe("approved");
      expect((getDb().prepare("SELECT subject FROM approvals").get() as { subject: string }).subject).toBe(`${idp.url}|sub-human-1`);

      expect(consumeApproval(a.approvalId, params()).subject).toContain("sub-human-1");
      expect(() => consumeApproval(a.approvalId, params())).toThrowError(/already used/); // single use
      expect((await getApproval(a.approvalId)).status).toBe("used");
    });

    it("DENIED: the human denies, and nothing can be authorized", async () => {
      idp.mode = "denied";
      const a = await createApproval(params());
      makeDue(a.approvalId);
      const r = await getApproval(a.approvalId);
      expect(r.status).toBe("denied");
      expect(() => consumeApproval(a.approvalId, params())).toThrow(/denied|did not approve|human/i);
    });

    it("EXPIRED: the device code expires at World, or our window passes", async () => {
      idp.mode = "expired";
      const a = await createApproval(params());
      makeDue(a.approvalId);
      expect((await getApproval(a.approvalId)).status).toBe("expired");
      expect(() => consumeApproval(a.approvalId, params())).toThrowError(/expired/);

      idp.mode = "pending";
      const b = await createApproval(params());
      getDb().prepare("UPDATE approvals SET expires_at = 1 WHERE approval_id = ?").run(b.approvalId);
      expect((await getApproval(b.approvalId)).status).toBe("expired");
      expect(() => consumeApproval(b.approvalId, params())).toThrowError(/expired/);
    });

    it("an invalid or stale ID token is a denial, not an approval", async () => {
      idp.mode = "approved";
      idp.claims = { acr: "https://world.org/oidc/acr/selfie" }; // lower assurance than policy
      const a = await createApproval(params());
      makeDue(a.approvalId);
      const r = await getApproval(a.approvalId);
      expect(r.status).toBe("denied");
      expect(r.reason).toMatch(/not accepted/);

      idp.claims = { auth_time: 1 }; // far too old
      const b = await createApproval(params());
      makeDue(b.approvalId);
      expect((await getApproval(b.approvalId)).status).toBe("denied");

      idp.claims = {};
      idp.signWith = "other"; // forged signature
      const c = await createApproval(params());
      makeDue(c.approvalId);
      expect((await getApproval(c.approvalId)).status).toBe("denied");
    });

    it("a World outage keeps the approval pending; it never approves", async () => {
      idp.mode = "down";
      const a = await createApproval(params());
      makeDue(a.approvalId);
      expect((await getApproval(a.approvalId)).status).toBe("pending");
      expect(() => consumeApproval(a.approvalId, params())).toThrow();
    });

    it("respects the polling interval and slows down when told to", async () => {
      idp.mode = "slow_down";
      const a = await createApproval(params());
      makeDue(a.approvalId);
      await getApproval(a.approvalId);
      const calls = idp.tokenCalls;
      await getApproval(a.approvalId); // not due yet: must not call World again
      await getApproval(a.approvalId);
      expect(idp.tokenCalls).toBe(calls);
      const row = getDb().prepare("SELECT interval_s FROM approvals WHERE approval_id = ?").get(a.approvalId) as { interval_s: number };
      expect(row.interval_s).toBe(6); // 1 s interval + 5 s slow_down
    });

    it("is bound to the exact action: another preset, price or requester is refused", async () => {
      const a = await createApproval(params());
      makeDue(a.approvalId);
      await getApproval(a.approvalId);
      for (const other of [params({ preset: "full", price: "1000000" }), params({ price: "1" }), params({ requester: "0xC4975d7b34275346d3a6D16C3E4B4Bb68c7dF645" })]) {
        expect(() => consumeApproval(a.approvalId, other)).toThrowError(/different action/);
      }
      expect(consumeApproval(a.approvalId, params()).subject).toBeTruthy(); // still usable for the real action
    });

    it("the binding ignores address case", () => {
      expect(bindingFor(params({ requester: TEST_REQUESTER.toLowerCase() }))).toBe(bindingFor(params()));
    });

    it("unknown approvals are refused", async () => {
      expect(() => consumeApproval("nope", params())).toThrowError(/not found/);
      await expect(getApproval("nope")).rejects.toMatchObject({ code: "not_found" });
    });

    it("cannot be created when Agent Pass is not configured", async () => {
      process.env.WORLD_IDP_CLIENT_ID = "";
      resetEnvCache();
      await expect(createApproval(params())).rejects.toMatchObject({ code: "not_configured" });
    });
  });

  describe("spending threshold", () => {
    it("requires approval only above the threshold, and not at all when unset", () => {
      expect(approvalRequired("200000")).toBe(false);
      expect(approvalRequired("200001")).toBe(true);
      process.env.AGENT_APPROVAL_THRESHOLD = "";
      resetEnvCache();
      expect(approvalRequired("999999999")).toBe(false);
    });
  });

  describe("protected action: POST /api/jobs above the threshold", () => {
    const post = (body: unknown, headers: Record<string, string> = {}) =>
      jobsPost(new Request("http://x/api/jobs", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }));
    const create = (preset: string, requester = TEST_REQUESTER) => ({ type: "render", preset, requester });
    const jobCount = async () => ((await (await jobsList()).json()) as { jobs: unknown[] }).jobs.length;

    beforeEach(() => {
      process.env.MESH_DEV_SKIP_PAYMENT = "true";
      resetEnvCache();
    });

    async function approvedFor(preset: "small" | "full", price: string) {
      const a = await createApproval(params({ preset, price }));
      makeDue(a.approvalId);
      await getApproval(a.approvalId);
      return a.approvalId;
    }

    it("a job below the threshold needs no approval", async () => {
      const res = await post(create("tiny")); // 100000 <= 200000
      expect(res.status).toBe(200);
    });

    it("DENIED path: no approval header, no job", async () => {
      const res = await post(create("small"));
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: "approval_required", reason: "above_threshold" });
      expect(await jobCount()).toBe(0);
    });

    it("DENIED path: a pending, denied or expired approval creates no job", async () => {
      idp.mode = "pending";
      const pending = await createApproval(params());
      makeDue(pending.approvalId);
      await getApproval(pending.approvalId);
      let res = await post(create("small"), { "x-mesh-approval": pending.approvalId });
      expect(res.status).toBe(403);
      expect((await res.json()).reason).toBe("not_approved");

      idp.mode = "denied";
      const denied = await createApproval(params());
      makeDue(denied.approvalId);
      await getApproval(denied.approvalId);
      res = await post(create("small"), { "x-mesh-approval": denied.approvalId });
      expect(res.status).toBe(403);
      expect((await res.json()).reason).toBe("denied");

      idp.mode = "expired";
      const expired = await createApproval(params());
      makeDue(expired.approvalId);
      await getApproval(expired.approvalId);
      res = await post(create("small"), { "x-mesh-approval": expired.approvalId });
      expect((await res.json()).reason).toBe("expired");

      res = await post(create("small"), { "x-mesh-approval": "no-such-approval" });
      expect((await res.json()).reason).toBe("not_found");
      expect(await jobCount()).toBe(0);
    });

    it("SUCCESS path: an approved, matching approval creates the job and is then spent", async () => {
      const id = await approvedFor("small", "500000");
      const res = await post(create("small"), { "x-mesh-approval": id });
      expect(res.status).toBe(200);
      const job = await res.json();
      expect(job.status).toBe("paid");
      expect(await jobCount()).toBe(1);

      const again = await post(create("small"), { "x-mesh-approval": id }); // replay
      expect(again.status).toBe(403);
      expect((await again.json()).reason).toBe("already_used");
      expect(await jobCount()).toBe(1);

      const trail = (getDb().prepare("SELECT type, data FROM job_events WHERE type = 'approval'").all() as { type: string; data: string }[]).map((r) => JSON.parse(r.data));
      expect(trail).toEqual([{ approvalId: id }]);
    });

    it("an approval for a small job cannot be spent on a bigger one, nor for another requester", async () => {
      const id = await approvedFor("small", "500000");
      const bigger = await post(create("full"), { "x-mesh-approval": id });
      expect(bigger.status).toBe(403);
      expect((await bigger.json()).reason).toBe("binding_mismatch");
      const other = await post(create("small", "0xC4975d7b34275346d3a6D16C3E4B4Bb68c7dF645"), { "x-mesh-approval": id });
      expect((await other.json()).reason).toBe("binding_mismatch");
      expect(await jobCount()).toBe(0);
      // the approval is still intact for the job it was granted for
      expect((await post(create("small"), { "x-mesh-approval": id })).status).toBe(200);
    });

    it("the approvals routes: create, read, no device code leak, errors", async () => {
      idp.mode = "pending";
      const createRes = await approvalsPost(new Request("http://x/api/approvals", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(create("small")) }));
      expect(createRes.status).toBe(201);
      const a = await createRes.json();
      expect(a).toMatchObject({ status: "pending", userCode: "ABCD-1234" });
      expect(JSON.stringify(a)).not.toMatch(/device_?code|dev-\d/);

      const get = (id: string) => approvalGet(new Request(`http://x/api/approvals/${id}`), { params: Promise.resolve({ id }) });
      expect(((await (await get(a.approvalId)).json()) as { status: string }).status).toBe("pending");
      expect((await get("00000000-0000-0000-0000-000000000000")).status).toBe(404);
      expect((await get("../etc")).status).toBe(400);

      const bad = await approvalsPost(new Request("http://x/api/approvals", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requester: "nope" }) }));
      expect(bad.status).toBe(400);

      process.env.WORLD_IDP_CLIENT_SECRET = "";
      resetEnvCache();
      const off = await approvalsPost(new Request("http://x/api/approvals", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(create("small")) }));
      expect(off.status).toBe(503);
    });
  });
});
