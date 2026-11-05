import { execFileSync, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPublicClient, createWalletClient, defineChain, getAddress, http, keccak256, parseEther, toBytes } from "viem";
import type { Address, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { meshStakeAbi } from "./abi/MeshStake";

/**
 * A throwaway local chain for rehearsals and integration tests: starts `anvil`, deploys the Mesh contracts with
 * contracts/script/Deploy.s.sol, and optionally registers and stakes provider wallets. Free, fast, no faucet.
 * The keys below are the public, well-known anvil test keys. They are worthless and must never be used on a real network.
 */

export const ANVIL_KEYS = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80", // 0 deployer
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d", // 1 api
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a", // 2 verifier
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6", // 3 provider A
  "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a", // 4 provider B
  "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba", // 5 requester
] as const satisfies readonly Hex[];

export const LOCAL_CHAIN_ID = 31337;

export function foundryBinDir(): string {
  return process.env.FOUNDRY_BIN ?? path.join(os.homedir(), ".foundry", "bin");
}

function bin(name: string): string {
  return path.join(foundryBinDir(), process.platform === "win32" ? `${name}.exe` : name);
}

/** True when anvil and forge are installed where we expect them. */
export function foundryAvailable(): boolean {
  return existsSync(bin("anvil")) && existsSync(bin("forge"));
}

/**
 * forge keeps its recovery state in the shared contracts/cache directory, so two deploys at the same time (for example
 * two test files running in parallel) collide. Serialize them with a lock directory in the OS temp folder.
 * A lock older than 5 minutes is treated as stale (a crashed run) and taken over.
 */
async function withForgeLock<T>(fn: () => T): Promise<T> {
  const lock = path.join(os.tmpdir(), "mesh-forge-deploy.lock");
  const start = Date.now();
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch {
      try {
        if (Date.now() - statSync(lock).mtimeMs > 5 * 60_000) rmSync(lock, { recursive: true, force: true });
      } catch {
        // someone else just released it
      }
      if (Date.now() - start > 240_000) throw new Error("timed out waiting for another forge deploy to finish");
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

export interface LocalChain {
  rpcUrl: string;
  chainId: number;
  keys: Record<"deployer" | "api" | "verifier" | "providerA" | "providerB" | "requester", Hex>;
  addresses: Record<"deployer" | "api" | "verifier" | "providerA" | "providerB" | "requester", Address>;
  contracts: { token: Address; stake: Address; escrow: Address; receipt: Address };
  stop: () => void;
}

async function waitForRpc(rpcUrl: string, timeoutMs = 30_000): Promise<void> {
  const start = Date.now();
  for (;;) {
    try {
      const res = await fetch(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      });
      if (res.ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() - start > timeoutMs) throw new Error(`local chain did not start at ${rpcUrl}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

export interface StartOptions {
  port?: number;
  windowSeconds?: number;
  /** Register these provider wallets on MeshStake (placeholder nullifier) and stake this much each. */
  provisionProviders?: Hex[];
  stakeEther?: string;
  /** Mine a block every N seconds (anvil otherwise mines only on transactions, so its clock stalls when idle). */
  blockTimeSeconds?: number;
  quiet?: boolean;
}

export async function startLocalChain(opts: StartOptions = {}): Promise<LocalChain> {
  if (!foundryAvailable()) throw new Error(`Foundry not found in ${foundryBinDir()} (set FOUNDRY_BIN)`);
  const port = opts.port ?? 8545;
  const rpcUrl = `http://127.0.0.1:${port}`;

  const anvil: ChildProcess = spawn(bin("anvil"), [
    "--port",
    String(port),
    "--chain-id",
    String(LOCAL_CHAIN_ID),
    "--silent",
    ...(opts.blockTimeSeconds ? ["--block-time", String(opts.blockTimeSeconds)] : []),
  ], {
    stdio: "ignore",
    windowsHide: true,
  });
  const stop = () => {
    try {
      anvil.kill();
    } catch {
      // already gone
    }
  };

  try {
    await waitForRpc(rpcUrl);

    const accounts = ANVIL_KEYS.map((k) => privateKeyToAccount(k));
    const [deployer, api, verifier, providerA, providerB, requester] = accounts.map((a) => a.address);

    const out = await withForgeLock(() => execFileSync(bin("forge"), ["script", "script/Deploy.s.sol", "--rpc-url", rpcUrl, "--broadcast", "--legacy"], {
      cwd: path.join(process.cwd(), "contracts"),
      env: {
        ...process.env,
        DEPLOYER_PRIVATE_KEY: ANVIL_KEYS[0],
        API_ADDRESS: api,
        VERIFIER_ADDRESS: verifier,
        WINDOW_SECONDS: String(opts.windowSeconds ?? 15),
        MIN_STAKE_WEI: parseEther("1").toString(),
        SLASH_AMOUNT_WEI: parseEther("0.5").toString(),
        UNLOCK_DELAY_SECONDS: "300",
        REFUND_AFTER_SECONDS: "3600",
      },
      encoding: "utf8",
      timeout: 180_000,
    }));
    const grab = (name: string): Address => {
      const m = new RegExp(`${name}=(0x[0-9a-fA-F]{40})`).exec(out);
      if (!m) throw new Error(`could not read ${name} from the deploy output:\n${out.slice(-600)}`);
      return getAddress(m[1]);
    };
    const contracts = {
      token: grab("PAYMENT_TOKEN_ADDRESS"),
      stake: grab("STAKE_ADDRESS"),
      escrow: grab("ESCROW_ADDRESS"),
      receipt: grab("RECEIPT_ADDRESS"),
    };

    const chain = defineChain({
      id: LOCAL_CHAIN_ID,
      name: "anvil",
      nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [rpcUrl] } },
    });
    const pc = createPublicClient({ chain, transport: http() });

    for (const key of opts.provisionProviders ?? []) {
      const provider = privateKeyToAccount(key);
      const nullifier = keccak256(toBytes(`mesh-dev-nullifier:${provider.address.toLowerCase()}`));
      const apiClient = createWalletClient({ account: accounts[1], chain, transport: http() });
      const reg = await apiClient.writeContract({ address: contracts.stake, abi: meshStakeAbi, functionName: "registerProvider", args: [provider.address, nullifier] });
      await pc.waitForTransactionReceipt({ hash: reg });
      const providerClient = createWalletClient({ account: provider, chain, transport: http() });
      const st = await providerClient.writeContract({
        address: contracts.stake,
        abi: meshStakeAbi,
        functionName: "stake",
        value: parseEther(opts.stakeEther ?? "1"),
      });
      await pc.waitForTransactionReceipt({ hash: st });
    }

    return {
      rpcUrl,
      chainId: LOCAL_CHAIN_ID,
      keys: { deployer: ANVIL_KEYS[0], api: ANVIL_KEYS[1], verifier: ANVIL_KEYS[2], providerA: ANVIL_KEYS[3], providerB: ANVIL_KEYS[4], requester: ANVIL_KEYS[5] },
      addresses: { deployer, api, verifier, providerA, providerB, requester },
      contracts,
      stop,
    };
  } catch (err) {
    stop();
    throw err;
  }
}
