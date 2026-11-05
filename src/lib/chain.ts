import { createPublicClient, createWalletClient, defineChain, getAddress, http, keccak256, toBytes } from "viem";
import type { Address, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { meshStakeAbi } from "./abi/MeshStake";
import { getEnv } from "./env";

/**
 * Chain access for the API. The API wallet (API_PRIVATE_KEY) is the contracts' `api` role: it registers providers on
 * MeshStake and (in later steps) locks escrow and posts claims. Everything here is server-side only.
 */

export class ChainNotConfiguredError extends Error {
  constructor(missing: string) {
    super(`chain access is not configured: ${missing} is not set`);
    this.name = "ChainNotConfiguredError";
  }
}

function chainFromEnv() {
  const env = getEnv();
  return defineChain({
    id: env.HEDERA_CHAIN_ID,
    name: env.HEDERA_CHAIN_ID === 296 ? "Hedera Testnet" : `chain-${env.HEDERA_CHAIN_ID}`,
    nativeCurrency: { name: "HBAR", symbol: "HBAR", decimals: 18 },
    rpcUrls: { default: { http: [env.HEDERA_RPC_URL] } },
  });
}

export function publicClient() {
  return createPublicClient({ chain: chainFromEnv(), transport: http() });
}

/** True when the API can send transactions (wallet key and the stake contract address are set). */
export function chainWritesConfigured(): boolean {
  const env = getEnv();
  return Boolean(env.API_PRIVATE_KEY && env.STAKE_ADDRESS);
}

function apiWallet() {
  const env = getEnv();
  if (!env.API_PRIVATE_KEY) throw new ChainNotConfiguredError("API_PRIVATE_KEY");
  const account = privateKeyToAccount(env.API_PRIVATE_KEY as Hex);
  return { account, client: createWalletClient({ account, chain: chainFromEnv(), transport: http() }) };
}

/**
 * DEV ONLY placeholder for a World ID nullifier: a stable per-address hash. It keeps the contract's "one profile per
 * human" bookkeeping working while World ID verification is not wired in. Never used when a real proof exists.
 */
export function devNullifier(address: string): Hex {
  return keccak256(toBytes(`mesh-dev-nullifier:${address.toLowerCase()}`));
}

export interface RegisterOnChainResult {
  registered: true;
  alreadyRegistered: boolean;
  txHash: Hex | null;
}

/**
 * Register a provider on MeshStake (idempotent). Requires the API wallet to hold gas. Waits for the receipt and
 * throws if the transaction reverts.
 */
export async function registerProviderOnChain(provider: string, nullifier: Hex): Promise<RegisterOnChainResult> {
  const env = getEnv();
  if (!env.STAKE_ADDRESS) throw new ChainNotConfiguredError("STAKE_ADDRESS");
  const stake = env.STAKE_ADDRESS as Address;
  const address = getAddress(provider);
  const pc = publicClient();

  const already = await pc.readContract({ address: stake, abi: meshStakeAbi, functionName: "isRegistered", args: [address] });
  if (already) return { registered: true, alreadyRegistered: true, txHash: null };

  const { client } = apiWallet();
  const gasPrice = await pc.getGasPrice();
  const hash = await client.writeContract({
    address: stake,
    abi: meshStakeAbi,
    functionName: "registerProvider",
    args: [address, nullifier],
    type: "legacy", // Hedera's JSON-RPC relay is most reliable with legacy transactions
    gasPrice,
  });
  const receipt = await pc.waitForTransactionReceipt({ hash, timeout: 90_000 });
  if (receipt.status !== "success") throw new Error(`registerProvider reverted (tx ${hash})`);
  return { registered: true, alreadyRegistered: false, txHash: hash };
}

/** Read a provider's eligibility (registered and staked at least `minStake`). */
export async function isProviderEligible(provider: string, minStake: bigint): Promise<boolean> {
  const env = getEnv();
  if (!env.STAKE_ADDRESS) throw new ChainNotConfiguredError("STAKE_ADDRESS");
  return publicClient().readContract({
    address: env.STAKE_ADDRESS as Address,
    abi: meshStakeAbi,
    functionName: "isEligible",
    args: [getAddress(provider), minStake],
  });
}
