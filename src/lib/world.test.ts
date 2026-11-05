import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `connection()` only works inside a real Next.js request.
vi.mock("next/server", () => ({ connection: async () => {} }));

import { randomBytes } from "node:crypto";
import { privateKeyToAccount } from "viem/accounts";
import { POST as registerPost } from "@/app/api/providers/register/route";
import { POST as rpContextPost } from "@/app/api/world/rp-context/route";
import { GET as providersList } from "@/app/api/providers/route";
import { registerMessage } from "./claim";
import { getDb } from "./db";
import { resetEnvCache } from "./env";
import { setupTestEnv } from "./testing";
import {
  assertNullifierAvailable,
  consumeNullifier,
  createRpContext,
  nullifierToBytes32,
  verifyIdkitProof,
  WorldDeniedError,
  worldEnforced,
} from "./world";

const RP = "rp_test123";
const KEY = randomBytes(32).toString("hex");
const NULL1 = "0x04e5f60000000000000000000000000000000000000000000000000000000001";
const NULL2 = "0x04e5f60000000000000000000000000000000000000000000000000000000002";
const A = "0x6834228cb6F180C05fA2154a2B2670d92c4FDf59";
const B = "0xC4975d7b34275346d3a6D16C3E4B4Bb68c7dF645";

const proof = (over: Record<string, unknown> = {}) => ({
  protocol_version: "4.0",
  nonce: "n",
  action: "register-provider",
  environment: "production",
  responses: [{ identifier: "proof_of_human", nullifier: NULL1, proof: ["0x1", "0x2", "0x3", "0x4", "0x5"], signal_hash: "0x0", issuer_schema_id: 1, expires_at_min: 1 }],
  ...over,
});

const verifyOk = (extra: Record<string, unknown> = {}) => vi.fn(async () => Response.json({ success: true, environment: "production", ...extra })) as unknown as typeof fetch;

describe("World ID (IDKit) server side", () => {
  let cleanup: () => void;
  beforeEach(() => {
    cleanup = setupTestEnv();
    process.env.WORLD_RP_ID = RP;
    process.env.WORLD_SIGNING_KEY = KEY;
    process.env.NEXT_PUBLIC_WORLD_APP_ID = "app_test123";
    resetEnvCache();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  describe("configuration", () => {
    it("is enforced only when app id, rp id and signing key are all set", () => {
      expect(worldEnforced()).toBe(true);
      process.env.WORLD_SIGNING_KEY = "";
      resetEnvCache();
      expect(worldEnforced()).toBe(false);
    });

    it("rejects a malformed signing key at startup", async () => {
      process.env.WORLD_SIGNING_KEY = "not-hex";
      resetEnvCache();
      const { getEnv } = await import("./env");
      expect(() => getEnv()).toThrow(/WORLD_SIGNING_KEY/);
    });
  });

  describe("RP context", () => {
    it("signs server-side and never returns the signing key", () => {
      const ctx = createRpContext("register-provider");
      expect(ctx).toMatchObject({ app_id: "app_test123", rp_id: RP, environment: "production", action: "register-provider" });
      expect(ctx.rp_context.signature).toMatch(/^0x[0-9a-f]+$/i);
      expect(ctx.rp_context.expires_at).toBeGreaterThan(ctx.rp_context.created_at);
      expect(JSON.stringify(ctx)).not.toContain(KEY);
    });

    it("each call uses a fresh nonce", () => {
      expect(createRpContext("register-provider").rp_context.nonce).not.toBe(createRpContext("register-provider").rp_context.nonce);
    });

    it("the route returns it, rejects unknown actions and answers 503 when unconfigured", async () => {
      const post = (body: unknown) => rpContextPost(new Request("http://x/api/world/rp-context", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
      const ok = await post({ action: "register-provider" });
      expect(ok.status).toBe(200);
      expect((await ok.json()).rp_context.signature).toBeTruthy();
      expect((await post({ action: "drain-wallet" })).status).toBe(400);
      expect((await post({})).status).toBe(400);

      process.env.WORLD_RP_ID = "";
      resetEnvCache();
      const off = await post({ action: "register-provider" });
      expect(off.status).toBe(503);
      expect((await off.json()).error).toBe("not_configured");
    });
  });

  describe("verifyIdkitProof", () => {
    it("accepts a valid proof, calls the right endpoint and pins the environment", async () => {
      const f = verifyOk();
      const out = await verifyIdkitProof("register-provider", proof(), f);
      expect(out.nullifier).toBe(NULL1);
      const [url, init] = (f as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0];
      expect(url).toBe(`https://developer.world.org/api/v4/verify/${RP}`);
      expect(JSON.parse(init.body as string).environment).toBe("production");
    });

    it("a client cannot pick a test environment", async () => {
      await expect(verifyIdkitProof("register-provider", proof({ environment: "staging" }), verifyOk())).rejects.toMatchObject({ reason: "wrong_environment" });
      await expect(verifyIdkitProof("register-provider", proof({ environment: "sandbox" }), verifyOk())).rejects.toMatchObject({ reason: "wrong_environment" });
    });

    it("rejects a proof made for another action, without a nullifier, or missing", async () => {
      await expect(verifyIdkitProof("register-provider", proof({ action: "other" }), verifyOk())).rejects.toMatchObject({ reason: "wrong_action" });
      await expect(verifyIdkitProof("register-provider", proof({ responses: [{ identifier: "x" }] }), verifyOk())).rejects.toMatchObject({ reason: "no_nullifier" });
      await expect(verifyIdkitProof("register-provider", undefined, verifyOk())).rejects.toMatchObject({ reason: "missing_proof" });
      await expect(verifyIdkitProof("register-provider", "garbage", verifyOk())).rejects.toMatchObject({ reason: "missing_proof" });
    });

    it("rejects a proof World says is invalid", async () => {
      const f = vi.fn(async () => Response.json({ success: false, code: "all_verifications_failed", detail: "All proof verifications failed." }, { status: 400 })) as unknown as typeof fetch;
      await expect(verifyIdkitProof("register-provider", proof(), f)).rejects.toMatchObject({ reason: "invalid_proof", message: "All proof verifications failed." });
    });

    it("a 200 without success:true is NOT approval", async () => {
      const f = vi.fn(async () => Response.json({ success: false })) as unknown as typeof fetch;
      await expect(verifyIdkitProof("register-provider", proof(), f)).rejects.toMatchObject({ reason: "invalid_proof" });
      const g = vi.fn(async () => new Response("<html>", { status: 200 })) as unknown as typeof fetch;
      await expect(verifyIdkitProof("register-provider", proof(), g)).rejects.toMatchObject({ reason: "invalid_proof" });
    });

    it("an outage or network failure is never approval", async () => {
      const down = vi.fn(async () => new Response("", { status: 503 })) as unknown as typeof fetch;
      await expect(verifyIdkitProof("register-provider", proof(), down)).rejects.toMatchObject({ reason: "verify_unavailable" });
      const limited = vi.fn(async () => new Response("", { status: 429 })) as unknown as typeof fetch;
      await expect(verifyIdkitProof("register-provider", proof(), limited)).rejects.toMatchObject({ reason: "verify_unavailable" });
      const boom = vi.fn(async () => {
        throw new Error("ECONNRESET");
      }) as unknown as typeof fetch;
      await expect(verifyIdkitProof("register-provider", proof(), boom)).rejects.toMatchObject({ reason: "verify_unavailable" });
    });

    it("rejects when World reports a different environment", async () => {
      await expect(verifyIdkitProof("register-provider", proof(), verifyOk({ environment: "staging" }))).rejects.toMatchObject({ reason: "wrong_environment" });
    });

    it("every denial is a WorldDeniedError", async () => {
      await expect(verifyIdkitProof("register-provider", {}, verifyOk())).rejects.toBeInstanceOf(WorldDeniedError);
    });
  });

  describe("nullifier store (one human, one provider profile)", () => {
    it("binds a nullifier to one wallet; same wallet may repeat; another wallet is refused", () => {
      expect(() => assertNullifierAvailable(NULL1, "register-provider", A)).not.toThrow();
      consumeNullifier(NULL1, "register-provider", A);
      consumeNullifier(NULL1, "register-provider", A); // idempotent for the same wallet
      expect(() => assertNullifierAvailable(NULL1, "register-provider", A)).not.toThrow();
      expect(() => assertNullifierAvailable(NULL1, "register-provider", B)).toThrow(WorldDeniedError);
      expect(() => consumeNullifier(NULL1, "register-provider", B)).toThrowError(/already registered/);
    });

    it("is case-insensitive and independent per nullifier", () => {
      consumeNullifier(NULL1.toUpperCase().replace("0X", "0x"), "register-provider", A);
      expect(() => consumeNullifier(NULL1, "register-provider", B)).toThrow(WorldDeniedError);
      expect(() => consumeNullifier(NULL2, "register-provider", B)).not.toThrow();
    });

    it("converts a nullifier to a contract bytes32", () => {
      expect(nullifierToBytes32("0x1")).toBe(`0x${"0".repeat(63)}1`);
      expect(nullifierToBytes32(NULL1)).toBe(NULL1);
      expect(() => nullifierToBytes32("0xzz")).toThrow(WorldDeniedError);
      expect(() => nullifierToBytes32(`0x${"f".repeat(65)}`)).toThrow(WorldDeniedError);
    });
  });

  describe("provider registration with World ID enforced", () => {
    const wallet = (n: number) => privateKeyToAccount(`0x${n.toString(16).padStart(64, "0")}` as `0x${string}`);
    async function register(n: number, worldProof?: unknown) {
      const w = wallet(n);
      const nonce = `${Date.now()}-${Math.random().toString(36).slice(2, 14).padEnd(12, "x")}`;
      return registerPost(
        new Request("http://x/api/providers/register", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            address: w.address,
            signature: await w.signMessage({ message: registerMessage(nonce) }),
            nonce,
            cores: 2,
            memoryGb: 2,
            os: "t",
            arch: "t",
            agentVersion: "t",
            ...(worldProof === undefined ? {} : { worldProof }),
          }),
        }),
      );
    }
    const providerCount = () => (getDb().prepare("SELECT COUNT(*) AS n FROM providers").get() as { n: number }).n;
    const stubVerify = (result: "ok" | "invalid" | "down") =>
      vi.stubGlobal("fetch", async () => (result === "ok" ? Response.json({ success: true, environment: "production" }) : result === "invalid" ? Response.json({ success: false, code: "all_verifications_failed", detail: "bad proof" }, { status: 400 }) : new Response("", { status: 503 })));

    it("DENIED path: no proof means no provider and no token", async () => {
      const res = await register(1);
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body).toMatchObject({ error: "world_denied", reason: "missing_proof" });
      expect(body.token).toBeUndefined();
      expect(providerCount()).toBe(0);
    });

    it("DENIED path: an invalid proof registers nothing", async () => {
      stubVerify("invalid");
      const res = await register(1, proof());
      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({ error: "world_denied", reason: "invalid_proof" });
      expect(providerCount()).toBe(0);
      expect((getDb().prepare("SELECT COUNT(*) AS n FROM world_nullifiers").get() as { n: number }).n).toBe(0);
    });

    it("DENIED path: a World outage answers 503 and registers nothing", async () => {
      stubVerify("down");
      const res = await register(1, proof());
      expect(res.status).toBe(503);
      expect(providerCount()).toBe(0);
    });

    it("SUCCESS path: a verified human gets a token and the nullifier is stored", async () => {
      stubVerify("ok");
      const res = await register(1, proof());
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.token).toMatch(/^[0-9a-f]{64}$/);
      expect(providerCount()).toBe(1);
      const row = getDb().prepare("SELECT world_nullifier FROM providers").get() as { world_nullifier: string };
      expect(row.world_nullifier).toBe(NULL1);
      const list = (await (await providersList()).json()) as { providers: { worldVerified: boolean }[] };
      expect(list.providers[0].worldVerified).toBe(true);
    });

    it("the same human cannot register a second wallet, but may re-register the first", async () => {
      stubVerify("ok");
      expect((await register(1, proof())).status).toBe(200);
      const second = await register(2, proof()); // same nullifier, different wallet
      expect(second.status).toBe(401);
      expect(await second.json()).toMatchObject({ error: "world_denied", reason: "nullifier_reused" });
      expect(providerCount()).toBe(1);
      expect((await register(1, proof())).status).toBe(200); // same wallet again is fine
      // a different human may register another wallet
      const other = proof({ responses: [{ identifier: "proof_of_human", nullifier: NULL2, proof: ["0x1", "0x2", "0x3", "0x4", "0x5"] }] });
      expect((await register(2, other)).status).toBe(200);
      expect(providerCount()).toBe(2);
    });

    it("a bad wallet signature does not burn the human's nullifier", async () => {
      stubVerify("ok");
      const w = wallet(1);
      const nonce = `${Date.now()}-${Math.random().toString(36).slice(2, 14).padEnd(12, "x")}`;
      const res = await registerPost(
        new Request("http://x/api/providers/register", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ address: w.address, signature: await wallet(9).signMessage({ message: registerMessage(nonce) }), nonce, cores: 1, memoryGb: 1, os: "t", arch: "t", agentVersion: "t", worldProof: proof() }),
        }),
      );
      expect(res.status).toBe(401);
      expect((await res.json()).error).toBe("bad_signature");
      expect((getDb().prepare("SELECT COUNT(*) AS n FROM world_nullifiers").get() as { n: number }).n).toBe(0);
      expect((await register(1, proof())).status).toBe(200); // the human can still register properly
    });

    it("when World is not configured the old behavior stays (registration works, chain step explains why)", async () => {
      process.env.WORLD_RP_ID = "";
      resetEnvCache();
      const res = await register(3);
      expect(res.status).toBe(200);
      expect((await res.json()).chain).toMatchObject({ registered: false, reason: "world_id_required" });
    });
  });
});

describe("ProviderClient carries the World ID proof", () => {
  it("sends worldProof on register only when one is configured", async () => {
    const { ProviderClient } = await import("./provider-client");
    const seen: unknown[] = [];
    vi.stubGlobal("fetch", async (_u: unknown, init?: RequestInit) => {
      seen.push(JSON.parse(String(init?.body)));
      return Response.json({ providerId: "p", token: "t".repeat(64), address: "0x0", chain: {} });
    });
    const account = privateKeyToAccount(`0x${"01".padStart(64, "0")}` as `0x${string}`);
    const base = { baseUrl: "http://x", account, chainId: 296, receiptAddress: "0x0118652ea87a8616Cb51979F5F121FC598bf3e7E" as const };
    await new ProviderClient(base).register();
    await new ProviderClient({ ...base, worldProof: { action: "register-provider" } }).register();
    vi.unstubAllGlobals();
    expect(seen[0]).not.toHaveProperty("worldProof");
    expect(seen[1]).toMatchObject({ worldProof: { action: "register-provider" } });
  });
});
