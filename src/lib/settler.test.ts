import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// `connection()` only works inside a real Next.js request.
vi.mock("next/server", () => ({ connection: async () => {} }));

import { createHash } from "node:crypto";
import { createPublicClient, defineChain, http, parseEther } from "viem";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mockStableAbi } from "./abi/MockStable";
import { resetChainCaches } from "./chain";
import { resetEligibilityCache } from "./assign";
import { resetEnvCache } from "./env";
import { buildJob, getJob, insertJob, listEvents, transitionJob, updateJob } from "./jobs";
import { ANVIL_KEYS, foundryAvailable, startLocalChain } from "./local-chain";
import type { LocalChain } from "./local-chain";
import { ProviderClient } from "./provider-client";
import { BASE, routeFetch } from "./route-fetch";
import { chainTick, isApproved, MAX_CHAIN_ATTEMPTS } from "./settler";
import { TEST_REQUESTER, setupTestEnv } from "./testing";
import type { Job } from "./types";

const canRun = foundryAvailable();
const TILE_BYTES = 32 * 32 * 2; // `tiny` preset
const tileData = (i: number) => Buffer.alloc(TILE_BYTES, i + 1);
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

describe.skipIf(!canRun)("chain loop: lock escrow -> post claim -> finalize (local anvil chain)", () => {
  let chain: LocalChain;
  let cleanup: (() => void) | undefined;
  let pc: ReturnType<typeof createPublicClient>;

  beforeAll(async () => {
    chain = await startLocalChain({ port: 8562, windowSeconds: 5, provisionProviders: [ANVIL_KEYS[3], ANVIL_KEYS[4]] });
    pc = createPublicClient({
      chain: defineChain({ id: chain.chainId, name: "anvil", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [chain.rpcUrl] } } }),
      transport: http(),
    });
  }, 180_000);

  afterAll(() => chain?.stop());

  function env(extra: Record<string, string> = {}) {
    cleanup?.();
    cleanup = setupTestEnv({ MESH_DEV_SKIP_PAYMENT: "true", ...extra });
    process.env.MESH_CHAIN_LOOP = "true";
    process.env.HEDERA_RPC_URL = chain.rpcUrl;
    process.env.HEDERA_CHAIN_ID = String(chain.chainId);
    process.env.STAKE_ADDRESS = chain.contracts.stake;
    process.env.ESCROW_ADDRESS = chain.contracts.escrow;
    process.env.RECEIPT_ADDRESS = chain.contracts.receipt;
    process.env.PAYMENT_TOKEN_ADDRESS = chain.contracts.token;
    process.env.API_PRIVATE_KEY = chain.keys.api;
    for (const [k, v] of Object.entries(extra)) process.env[k] = v;
    resetEnvCache();
    resetChainCaches();
    resetEligibilityCache();
  }

  beforeEach(() => {
    vi.stubGlobal("fetch", ((input: string | URL | Request, init?: RequestInit) => {
      const u = typeof input === "string" || input instanceof URL ? input.toString() : input.url;
      return u.startsWith(BASE) ? routeFetch(input, init) : (globalThis as { __realFetch?: typeof fetch }).__realFetch!(input, init);
    }) as typeof fetch);
  });
  beforeAll(() => {
    (globalThis as { __realFetch?: typeof fetch }).__realFetch = globalThis.fetch;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup?.();
    cleanup = undefined;
  });

  const client = (key: Hex) =>
    new ProviderClient({
      baseUrl: BASE,
      account: privateKeyToAccount(key),
      chainId: chain.chainId,
      receiptAddress: chain.contracts.receipt,
      hardware: { cores: 2, memoryGb: 2, os: "test", arch: "x64" },
    });

  /** Run a job through the provider protocol until it is `pending` (all claims in). */
  async function runJobToPending(clients: ProviderClient[]): Promise<Job> {
    const res = await routeFetch(`${BASE}/api/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "render", preset: "tiny", requester: TEST_REQUESTER }),
    });
    expect(res.status).toBe(200);
    const job = (await res.json()) as Job;
    for (const c of clients) {
      const tasks = await c.pollTasks();
      for (const task of tasks) {
        const tiles: { index: number; tileHash: string }[] = [];
        for (const index of task.tiles) {
          await c.putTile(task.jobId, index, tileData(index));
          tiles.push({ index, tileHash: sha(tileData(index)) });
        }
        await c.submitClaim(task, tiles);
      }
    }
    expect(getJob(job.jobId)?.status).toBe("pending");
    return getJob(job.jobId)!;
  }

  async function advanceChain(seconds: number) {
    for (const [method, params] of [["evm_increaseTime", [seconds]], ["evm_mine", []]] as const) {
      await (globalThis as { __realFetch?: typeof fetch }).__realFetch!(chain.rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
    }
  }

  const tokenBalance = (who: string) => pc.readContract({ address: chain.contracts.token, abi: mockStableAbi, functionName: "balanceOf", args: [who as Hex] });

  it("does nothing when the chain loop is off or unconfigured", async () => {
    env({ MESH_CHAIN_LOOP: "false" });
    expect(await chainTick()).toEqual({ locked: [], claimsPosted: [], finalized: [], refunded: [], errors: [] });
  });

  it("settles a job end to end: lock, post claim, wait out the window, pay the providers", async () => {
    env({ MESH_DEV_AUTO_APPROVE: "true" });
    const a = client(chain.keys.providerA);
    const b = client(chain.keys.providerB);
    await a.register();
    await b.register();
    const job = await runJobToPending([a, b]);
    expect(job.providers).toHaveLength(2); // both are registered and staked, so both are eligible

    // tick 1: lock escrow and post the claim
    const t1 = await chainTick();
    expect(t1.errors).toEqual([]);
    expect(t1.locked).toEqual([job.jobId]);
    expect(t1.claimsPosted).toEqual([job.jobId]);
    expect(t1.finalized).toEqual([]); // window still open

    const posted = getJob(job.jobId)!;
    expect(posted.lockTx).toMatch(/^0x[0-9a-f]{64}$/);
    expect(posted.claimTx).toMatch(/^0x[0-9a-f]{64}$/);
    expect(posted.windowEnd).toBeGreaterThan(0);
    expect(posted.status).toBe("pending");
    expect(await tokenBalance(chain.contracts.escrow)).toBe(BigInt(job.price));

    // tick 2 right away: idempotent, nothing repeated, still not finalizable
    const t2 = await chainTick();
    expect(t2).toEqual({ locked: [], claimsPosted: [], finalized: [], refunded: [], errors: [] });

    // advance chain time past the window: the next tick finalizes and the contract pays the providers
    await advanceChain(10);
    const t3 = await chainTick();
    expect(t3.errors).toEqual([]);
    expect(t3.finalized).toEqual([job.jobId]);

    const done = getJob(job.jobId)!;
    expect(done.status).toBe("final");
    expect(done.finalTx).toMatch(/^0x[0-9a-f]{64}$/);
    expect(done.releaseTx).toBe(done.finalTx);

    const paid = (await tokenBalance(a.address)) + (await tokenBalance(b.address));
    expect(paid).toBe(BigInt(job.price)); // everything went to the two providers
    expect(await tokenBalance(chain.contracts.escrow)).toBe(0n);

    // event trail and the public receipt (read from the chain)
    const kinds = listEvents(job.jobId).map((e) => `${e.type}${e.data.kind ? `:${e.data.kind}` : ""}`);
    expect(kinds).toEqual(expect.arrayContaining(["chain:locked", "claim", "settlement:released"]));
    const receipt = await (await routeFetch(`${BASE}/api/receipts/${job.jobId}`)).json();
    expect(receipt.status).toBe("final");
    expect(receipt.onChain.status).toBe("Final");
    expect(receipt.onChain.merkleRoot).toBe(job.merkleRoot);
    expect(receipt.onChain.providers.map((p: string) => p.toLowerCase()).sort()).toEqual(job.providers.map((p) => p.toLowerCase()).sort());
    expect(receipt.transactions).toMatchObject({ lock: posted.lockTx, claim: posted.claimTx, finalize: done.finalTx });

    // a later tick does not touch a settled job
    expect(await chainTick()).toEqual({ locked: [], claimsPosted: [], finalized: [], refunded: [], errors: [] });
  }, 180_000);

  it("never finalizes an unapproved job, even after the window passes (no verifier verdict, no dev auto-approve)", async () => {
    env({ MESH_DEV_AUTO_APPROVE: "false" });
    const a = client(chain.keys.providerA);
    await a.register();
    const before = await tokenBalance(a.address); // the chain persists across tests, so compare against this
    const job = await runJobToPending([a]);
    expect(isApproved(job)).toBe(false);

    await chainTick(); // lock + post claim
    await advanceChain(10);
    const t = await chainTick();
    expect(t.finalized).toEqual([]);
    expect(getJob(job.jobId)?.status).toBe("pending");
    expect(await tokenBalance(a.address)).toBe(before); // nobody was paid

    // a verifier verdict approves it
    updateJob(job.jobId, { verdict: "ok" });
    const t2 = await chainTick();
    expect(t2.finalized).toEqual([job.jobId]);
    expect(getJob(job.jobId)?.status).toBe("final");
    expect(await tokenBalance(a.address)).toBe(before + BigInt(job.price)); // now paid in full
  }, 180_000);

  it("assigns only providers that are registered and staked on chain", async () => {
    env({ MESH_DEV_AUTO_APPROVE: "true" });
    const stranger = client(chain.keys.requester); // never registered or staked on chain
    await stranger.register();
    const res = await routeFetch(`${BASE}/api/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "render", preset: "tiny", requester: TEST_REQUESTER }),
    });
    const job = (await res.json()) as Job;
    expect(job.status).toBe("paid"); // the only online provider is ineligible, so nothing is assigned
    expect(job.providers).toEqual([]);
    expect(await stranger.pollTasks()).toEqual([]);

    const a = client(chain.keys.providerA);
    await a.register();
    const tasks = await a.pollTasks(); // an eligible provider appears and picks the waiting job up
    expect(tasks).toHaveLength(1);
    expect(tasks[0].tiles).toEqual([0, 1, 2, 3]);
    expect(getJob(job.jobId)?.providers).toEqual([a.address]);
  }, 120_000);

  it("refunds and ends a job whose chain step keeps failing", async () => {
    // payment skip is OFF, so the API will not fund the escrow and `lock` reverts (nothing was paid)
    env({ MESH_DEV_SKIP_PAYMENT: "false" });
    const job = insertJob(buildJob({ type: "render", preset: "tiny", requester: TEST_REQUESTER }));
    transitionJob(job.jobId, "paid");

    for (let i = 0; i < MAX_CHAIN_ATTEMPTS; i++) {
      const r = await chainTick();
      expect(r.errors.some((e) => e.jobId === job.jobId && e.step === "lock")).toBe(true);
    }
    const final = getJob(job.jobId)!;
    expect(final.status).toBe("refunded");
    const errors = listEvents(job.jobId).filter((e) => e.type === "error");
    expect(errors).toHaveLength(MAX_CHAIN_ATTEMPTS);
    expect(errors[0].data.code).toBe("chain_lock");
    expect(listEvents(job.jobId).some((e) => e.type === "settlement" && e.data.kind === "refunded")).toBe(true);
    // the failed job is not retried forever
    expect((await chainTick()).errors).toEqual([]);
  }, 180_000);

  it("a minimum-stake check uses the contract value", async () => {
    env();
    expect(parseEther("1")).toBeGreaterThan(0n);
    const { onChainMinStake } = await import("./chain");
    expect(await onChainMinStake()).toBe(parseEther("1"));
  });
});
