import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// `connection()` only works inside a real Next.js request.
vi.mock("next/server", () => ({ connection: async () => {} }));

import { createWalletClient, defineChain, http, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { chainWritesConfigured, devNullifier, isProviderEligible, publicClient, registerProviderOnChain } from "./chain";
import { meshStakeAbi } from "./abi/MeshStake";
import { resetEnvCache } from "./env";
import { foundryAvailable, startLocalChain } from "./local-chain";
import type { LocalChain } from "./local-chain";
import { POST as registerPost } from "@/app/api/providers/register/route";
import { registerMessage } from "./claim";
import { setupTestEnv } from "./testing";

const canRun = foundryAvailable();
const SAVED = { ...process.env };

describe.skipIf(!canRun)("API-side on-chain provider registration (local anvil chain)", () => {
  let chain: LocalChain;
  let cleanupEnv: () => void;

  beforeAll(async () => {
    chain = await startLocalChain({ port: 8561 });
  }, 120_000);

  afterAll(() => chain?.stop());

  function useChainEnv(extra: Record<string, string> = {}) {
    cleanupEnv?.();
    cleanupEnv = setupTestEnv({ MESH_DEV_SKIP_WORLD: "true" });
    process.env.HEDERA_RPC_URL = chain.rpcUrl;
    process.env.HEDERA_CHAIN_ID = String(chain.chainId);
    process.env.STAKE_ADDRESS = chain.contracts.stake;
    process.env.RECEIPT_ADDRESS = chain.contracts.receipt;
    process.env.API_PRIVATE_KEY = chain.keys.api;
    for (const [k, v] of Object.entries(extra)) process.env[k] = v;
    resetEnvCache();
  }

  it("registers a provider once, idempotently, and the wallet can then stake to become eligible", async () => {
    useChainEnv();
    expect(chainWritesConfigured()).toBe(true);
    const provider = privateKeyToAccount(chain.keys.providerA);

    expect(await isProviderEligible(provider.address, parseEther("1"))).toBe(false);

    const first = await registerProviderOnChain(provider.address, devNullifier(provider.address));
    expect(first).toMatchObject({ registered: true, alreadyRegistered: false });
    expect(first.txHash).toMatch(/^0x[0-9a-f]{64}$/);

    const second = await registerProviderOnChain(provider.address, devNullifier(provider.address));
    expect(second).toEqual({ registered: true, alreadyRegistered: true, txHash: null });

    // registered but not staked: still not eligible
    expect(await isProviderEligible(provider.address, parseEther("1"))).toBe(false);

    const client = createWalletClient({
      account: provider,
      chain: defineChain({ id: chain.chainId, name: "anvil", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [chain.rpcUrl] } } }),
      transport: http(),
    });
    const hash = await client.writeContract({ address: chain.contracts.stake, abi: meshStakeAbi, functionName: "stake", value: parseEther("1") });
    await publicClient().waitForTransactionReceipt({ hash });
    expect(await isProviderEligible(provider.address, parseEther("1"))).toBe(true);
    expect(await isProviderEligible(provider.address, parseEther("2"))).toBe(false);
  }, 60_000);

  it("the contract refuses a second wallet for the same human nullifier", async () => {
    useChainEnv();
    const a = privateKeyToAccount(chain.keys.providerA);
    const b = privateKeyToAccount(chain.keys.providerB);
    await registerProviderOnChain(a.address, devNullifier(a.address)); // idempotent, already done
    // same nullifier, different wallet: the contract must reject it
    await expect(registerProviderOnChain(b.address, devNullifier(a.address))).rejects.toThrow();
  }, 60_000);

  it("POST /api/providers/register registers on chain only when the dev World skip is on", async () => {
    const c = privateKeyToAccount(chain.keys.requester); // any wallet will do
    const body = async () => {
      const nonce = `${Date.now()}-${Math.random().toString(36).slice(2, 14).padEnd(12, "x")}`;
      return {
        address: c.address,
        signature: await c.signMessage({ message: registerMessage(nonce) }),
        nonce,
        cores: 2,
        memoryGb: 2,
        os: "t",
        arch: "t",
        agentVersion: "t",
      };
    };
    const post = async () =>
      registerPost(new Request("http://x/api/providers/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(await body()) }));

    // dev skip OFF: registered with the API, but not on chain, with a clear reason
    useChainEnv({ MESH_DEV_SKIP_WORLD: "false" });
    const off = await (await post()).json();
    expect(off.token).toMatch(/^[0-9a-f]{64}$/);
    expect(off.chain).toEqual({ registered: false, txHash: null, reason: "world_id_required" });

    // dev skip ON: registered on chain
    useChainEnv();
    const on = await (await post()).json();
    expect(on.chain.registered).toBe(true);
    expect(on.chain.txHash).toMatch(/^0x[0-9a-f]{64}$/);

    // again: idempotent, no new tx
    const again = await (await post()).json();
    expect(again.chain).toMatchObject({ registered: true, txHash: null });

    // the public provider list reflects it
    const { GET: listProviders } = await import("@/app/api/providers/route");
    const list = (await (await listProviders()).json()) as { providers: { address: string; chainRegistered: boolean }[] };
    expect(list.providers.find((p) => p.address === c.address)?.chainRegistered).toBe(true);
  }, 90_000);

  it("reports a clear chain error (without failing registration) when the API wallet is missing", async () => {
    useChainEnv({ API_PRIVATE_KEY: "" });
    const c = privateKeyToAccount(chain.keys.providerB);
    const nonce = `${Date.now()}-${Math.random().toString(36).slice(2, 14).padEnd(12, "x")}`;
    const res = await registerPost(
      new Request("http://x/api/providers/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          address: c.address,
          signature: await c.signMessage({ message: registerMessage(nonce) }),
          nonce,
          cores: 1,
          memoryGb: 1,
          os: "t",
          arch: "t",
          agentVersion: "t",
        }),
      }),
    );
    const out = await res.json();
    expect(res.status).toBe(200);
    expect(out.token).toBeTruthy();
    expect(out.chain).toEqual({ registered: false, txHash: null, error: "chain_not_configured" });
  }, 60_000);

  it("restores the environment", () => {
    cleanupEnv?.();
    expect(process.env.API_PRIVATE_KEY).toBe(SAVED.API_PRIVATE_KEY);
  });
});
