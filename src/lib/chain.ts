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

// ───────────────────────── escrow, claims, settlement (step 11) ─────────────────────────

import { meshEscrowAbi } from "./abi/MeshEscrow";
import { meshReceiptAbi } from "./abi/MeshReceipt";
import { mockStableAbi } from "./abi/MockStable";
import { imageDigestToBytes32, with0x } from "./claim";
import type { Job } from "./types";

/** True when the chain loop can run: write access plus all three contract addresses. */
export function chainLoopConfigured(): boolean {
  const env = getEnv();
  return Boolean(env.API_PRIVATE_KEY && env.STAKE_ADDRESS && env.ESCROW_ADDRESS && env.RECEIPT_ADDRESS);
}

function addrs() {
  const env = getEnv();
  if (!env.STAKE_ADDRESS || !env.ESCROW_ADDRESS || !env.RECEIPT_ADDRESS) throw new ChainNotConfiguredError("contract addresses");
  return { stake: env.STAKE_ADDRESS as Address, escrow: env.ESCROW_ADDRESS as Address, receipt: env.RECEIPT_ADDRESS as Address, token: env.PAYMENT_TOKEN_ADDRESS as Address | undefined };
}

async function send(request: (gasPrice: bigint) => Promise<Hex>): Promise<Hex> {
  const pc = publicClient();
  const hash = await request(await pc.getGasPrice());
  const receipt = await pc.waitForTransactionReceipt({ hash, timeout: 90_000 });
  if (receipt.status !== "success") throw new Error(`transaction reverted (tx ${hash})`);
  return hash;
}

/** Current chain time in unix seconds (the latest block's timestamp). Windows are measured on chain time, not the host clock. */
export async function chainNow(): Promise<number> {
  return Number((await publicClient().getBlock()).timestamp);
}

export const ESCROW_STATUS = ["None", "Locked", "Released", "Refunded"] as const;
export const RECEIPT_STATUS = ["None", "Pending", "Final", "Rejected", "Attested"] as const;

export async function escrowStatus(jobId: string): Promise<(typeof ESCROW_STATUS)[number]> {
  const n = await publicClient().readContract({ address: addrs().escrow, abi: meshEscrowAbi, functionName: "statusOf", args: [jobId as Hex] });
  return ESCROW_STATUS[Number(n)];
}

export interface OnChainReceipt {
  status: (typeof RECEIPT_STATUS)[number];
  requester: Address;
  merkleRoot: Hex;
  postedAt: number;
  windowEnd: number;
  providers: Address[];
}

export async function readOnChainReceipt(jobId: string): Promise<OnChainReceipt> {
  const { receipt } = addrs();
  const pc = publicClient();
  const r = await pc.readContract({ address: receipt, abi: meshReceiptAbi, functionName: "getReceipt", args: [jobId as Hex] });
  const providers = await pc.readContract({ address: receipt, abi: meshReceiptAbi, functionName: "providersOf", args: [jobId as Hex] });
  return {
    status: RECEIPT_STATUS[Number(r.status)],
    requester: r.requester,
    merkleRoot: r.merkleRoot,
    postedAt: Number(r.postedAt),
    windowEnd: Number(r.windowEnd),
    providers: [...providers],
  };
}

/**
 * Lock the requester's payment in escrow (idempotent). In production the x402 payment has already moved tokens to
 * the escrow contract; with `devFund` (DEV payment skip) the API first mints test tokens to the escrow so there is
 * something to lock. MockStable's mint is open, so this only works with the test token.
 */
export async function lockEscrowOnChain(job: Pick<Job, "jobId" | "requester" | "price">, opts: { devFund: boolean }): Promise<{ txHash: Hex | null; alreadyLocked: boolean }> {
  const { escrow, token } = addrs();
  if ((await escrowStatus(job.jobId)) !== "None") return { txHash: null, alreadyLocked: true };
  const { client } = apiWallet();
  const amount = BigInt(job.price);

  if (opts.devFund) {
    if (!token) throw new ChainNotConfiguredError("PAYMENT_TOKEN_ADDRESS");
    await send((gasPrice) =>
      client.writeContract({ address: token, abi: mockStableAbi, functionName: "mint", args: [escrow, amount], type: "legacy", gasPrice }),
    );
  }
  const txHash = await send((gasPrice) =>
    client.writeContract({
      address: escrow,
      abi: meshEscrowAbi,
      functionName: "lock",
      args: [job.jobId as Hex, getAddress(job.requester), amount],
      type: "legacy",
      gasPrice,
    }),
  );
  return { txHash, alreadyLocked: false };
}

/** Post the providers' combined claim (opens the challenge window). Idempotent: recovers the tx if it was already posted. */
export async function postClaimOnChain(job: Job): Promise<{ txHash: Hex | null; windowEnd: number }> {
  if (!job.merkleRoot) throw new Error("job has no Merkle root yet");
  const { receipt } = addrs();
  const existing = await readOnChainReceipt(job.jobId);
  if (existing.status !== "None") {
    const logs = await publicClient().getContractEvents({ address: receipt, abi: meshReceiptAbi, eventName: "ClaimPosted", args: { jobId: job.jobId as Hex }, fromBlock: 0n });
    return { txHash: (logs[0]?.transactionHash as Hex | undefined) ?? null, windowEnd: existing.windowEnd };
  }
  const { client } = apiWallet();
  const txHash = await send((gasPrice) =>
    client.writeContract({
      address: receipt,
      abi: meshReceiptAbi,
      functionName: "postClaim",
      args: [
        job.jobId as Hex,
        getAddress(job.requester),
        imageDigestToBytes32(job.imageDigest),
        with0x(job.inputHash),
        job.merkleRoot as Hex,
        job.providers.map((p) => getAddress(p)),
        job.tileCount,
      ],
      type: "legacy",
      gasPrice,
    }),
  );
  return { txHash, windowEnd: (await readOnChainReceipt(job.jobId)).windowEnd };
}

/** Finalize a receipt whose challenge window has passed; the contract pays the providers from escrow in the same tx. */
export async function finalizeOnChain(jobId: string): Promise<Hex> {
  const { receipt } = addrs();
  const { client } = apiWallet();
  return send((gasPrice) => client.writeContract({ address: receipt, abi: meshReceiptAbi, functionName: "finalize", args: [jobId as Hex], type: "legacy", gasPrice }));
}

/** Return a locked payment to the requester (used when a job cannot complete). */
export async function refundOnChain(jobId: string): Promise<Hex | null> {
  const { escrow } = addrs();
  if ((await escrowStatus(jobId)) !== "Locked") return null;
  const { client } = apiWallet();
  return send((gasPrice) => client.writeContract({ address: escrow, abi: meshEscrowAbi, functionName: "refund", args: [jobId as Hex], type: "legacy", gasPrice }));
}

let minStakeCache: { value: bigint; at: number } | null = null;

/** The receipt contract's minimum stake (cached 60 s). */
export async function onChainMinStake(): Promise<bigint> {
  if (minStakeCache && Date.now() - minStakeCache.at < 60_000) return minStakeCache.value;
  const value = await publicClient().readContract({ address: addrs().receipt, abi: meshReceiptAbi, functionName: "minStake" });
  minStakeCache = { value, at: Date.now() };
  return value;
}

export function resetChainCaches(): void {
  minStakeCache = null;
}
