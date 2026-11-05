// Verifier worker for deterministic render claims. See MISBAH.md §6.
import "dotenv/config";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  getAddress,
  http,
  isAddress,
  parseEventLogs,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { merkleLeaf, merkleProof, merkleRoot, verifyProof } from "@/lib/hash";
import { RENDER_PRESETS } from "@/lib/constants";
import { meshReceiptAbi } from "@/lib/abi/MeshReceipt";
import { renderRunInput } from "@/lib/render-input";
import type { Job, RenderPreset } from "@/lib/types";
import { runDockerTask, type ProviderTask } from "../provider/docker-runner";
import { deriveSampleSeed, selectSampleIndices } from "./sampler";

const POLL_MS = Number(process.env.VERIFIER_POLL_MS ?? "10000");
const SAMPLE_RATE = Number(process.env.VERIFIER_SAMPLE_RATE ?? "0.25");
const SUBMIT_TRANSACTIONS = process.env.VERIFIER_SUBMIT_TRANSACTIONS === "true";
const RECEIPT_STATUS_PENDING = 1;

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} must be set in .env`);
  return value;
}

function apiBase(): string {
  const configured = requiredEnv("API_PUBLIC_URL").replace(/\/+$/, "");
  return `${configured.replace(/\/api$/i, "")}/api`;
}

function createChain(rpcUrl: string, chainId: number) {
  if (chainId !== 296)
    throw new Error("The verifier only supports Hedera testnet (chain ID 296)");
  return defineChain({
    id: chainId,
    name: "Hedera Testnet",
    nativeCurrency: { name: "HBAR", symbol: "HBAR", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
}

function log(message: string): void {
  process.stdout.write(`${new Date().toISOString()} ${message}\n`);
}

async function fetchPendingJobs(base: string): Promise<Job[]> {
  const response = await fetch(`${base}/jobs`, {
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok)
    throw new Error(`API pending-job poll failed (${response.status})`);
  const body = (await response.json()) as { jobs?: Job[] };
  if (!Array.isArray(body.jobs))
    throw new Error("API returned an invalid jobs list");
  return body.jobs.filter((job) => job.status === "pending");
}

function validatedTiles(job: Job): { owner: Address; tileHash: string }[] {
  if (job.tiles.length !== job.tileCount)
    throw new Error(`Job ${job.jobId} has an incomplete tile list`);
  return job.tiles.map((tile, index) => {
    if (tile.index !== index || !tile.owner || !tile.tileHash) {
      throw new Error(
        `Job ${job.jobId} is missing owner/hash for tile ${index}`,
      );
    }
    return { owner: getAddress(tile.owner), tileHash: tile.tileHash };
  });
}

async function assertMerkleCommitment(
  job: Job,
  onchainRoot: Hex,
): Promise<{
  leaves: `0x${string}`[];
  tiles: ReturnType<typeof validatedTiles>;
}> {
  if (
    !job.merkleRoot ||
    job.merkleRoot.toLowerCase() !== onchainRoot.toLowerCase()
  ) {
    throw new Error(
      `Job ${job.jobId} Merkle root does not match the on-chain receipt`,
    );
  }
  const tiles = validatedTiles(job);
  const leaves = await Promise.all(
    tiles.map((tile, index) => merkleLeaf(index, tile.tileHash, tile.owner)),
  );
  const computedRoot = await merkleRoot(leaves);
  if (computedRoot.toLowerCase() !== onchainRoot.toLowerCase()) {
    throw new Error(
      `Job ${job.jobId} tile list does not reconstruct its Merkle root`,
    );
  }
  return { leaves, tiles };
}

async function recomputeSample(job: Job, indices: number[]) {
  if (job.type !== "render" || job.mode !== "deterministic") {
    throw new Error(
      `Verifier currently supports deterministic render jobs only (got ${job.type}/${job.mode})`,
    );
  }
  const presetValue = job.params.preset;
  if (typeof presetValue !== "string" || !(presetValue in RENDER_PRESETS)) {
    throw new Error(`Job ${job.jobId} has an unsupported render preset`);
  }
  const preset = presetValue as RenderPreset;
  const task: ProviderTask = {
    taskId: `verify-${job.jobId}`,
    jobId: job.jobId,
    type: job.type,
    imageRef: job.imageRef,
    imageDigest: job.imageDigest,
    inputHash: job.inputHash,
    tiles: indices,
    timeoutSeconds: job.timeoutSeconds,
  };
  const input = Buffer.from(renderRunInput(preset, indices), "utf8");
  return runDockerTask(task, input, {
    cpus: process.env.VERIFIER_CPUS ?? process.env.PROVIDER_CPUS ?? "4",
    memory: process.env.VERIFIER_MEMORY ?? process.env.PROVIDER_MEMORY ?? "4g",
    timeoutSeconds: job.timeoutSeconds,
  });
}

function transactionEnabled(): boolean {
  return SUBMIT_TRANSACTIONS;
}

async function main(): Promise<void> {
  if (!Number.isFinite(POLL_MS) || POLL_MS < 1000)
    throw new Error("VERIFIER_POLL_MS must be at least 1000");
  if (!Number.isFinite(SAMPLE_RATE) || SAMPLE_RATE <= 0 || SAMPLE_RATE > 1) {
    throw new Error(
      "VERIFIER_SAMPLE_RATE must be greater than 0 and at most 1",
    );
  }

  const rpcUrl = requiredEnv("HEDERA_RPC_URL");
  const chainId = Number(process.env.HEDERA_CHAIN_ID ?? "296");
  const receiptAddressValue = requiredEnv("RECEIPT_ADDRESS");
  if (!isAddress(receiptAddressValue))
    throw new Error("RECEIPT_ADDRESS must be a valid EVM address");
  const receiptAddress = receiptAddressValue as Address;
  const chain = createChain(rpcUrl, chainId);
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
  const base = apiBase();
  let account: ReturnType<typeof privateKeyToAccount> | undefined;
  let walletClient: ReturnType<typeof createWalletClient> | undefined;

  if (transactionEnabled()) {
    const privateKeyValue = requiredEnv("VERIFIER_PRIVATE_KEY");
    const privateKey = (
      privateKeyValue.startsWith("0x")
        ? privateKeyValue
        : `0x${privateKeyValue}`
    ) as Hex;
    if (!/^0x[a-fA-F0-9]{64}$/.test(privateKey))
      throw new Error("VERIFIER_PRIVATE_KEY must be a 32-byte hex key");
    account = privateKeyToAccount(privateKey);
    const verifierRole = await publicClient.readContract({
      address: receiptAddress,
      abi: meshReceiptAbi,
      functionName: "verifier",
    });
    if (account.address.toLowerCase() !== verifierRole.toLowerCase()) {
      throw new Error(
        "VERIFIER_PRIVATE_KEY does not match the verifier address configured in MeshReceipt",
      );
    }
    walletClient = createWalletClient({
      account,
      chain,
      transport: http(rpcUrl),
    });
    log(`Transaction submission enabled for verifier ${account.address}`);
  } else {
    log(
      "Read-only mode: set VERIFIER_SUBMIT_TRANSACTIONS=true only after verifying the local verifier key and funding",
    );
  }

  const stopped = new AbortController();
  const stop = () => stopped.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const processed = new Map<
    string,
    { claimTx: string; outcome: "clean" | "fraud"; windowEnd: bigint }
  >();
  const finalizeReadyReported = new Set<string>();

  const poll = async () => {
    const jobs = await fetchPendingJobs(base);
    let actionable = 0;
    for (const job of jobs) {
      if (!job.claimTx || !job.merkleRoot) continue;
      actionable += 1;
      const previous = processed.get(job.jobId);
      if (previous?.claimTx === job.claimTx) {
        if (previous.outcome === "clean")
          await finalizeIfReady(job.jobId, previous.windowEnd);
        continue;
      }
      try {
        const chainReceipt = await publicClient.readContract({
          address: receiptAddress,
          abi: meshReceiptAbi,
          functionName: "getReceipt",
          args: [job.jobId as Hex],
        });
        if (chainReceipt.status !== RECEIPT_STATUS_PENDING) {
          log(`Skipping ${job.jobId}: receipt is not pending on chain`);
          continue;
        }
        if (
          chainReceipt.merkleRoot.toLowerCase() !== job.merkleRoot.toLowerCase()
        ) {
          throw new Error(
            `API and on-chain Merkle roots differ for ${job.jobId}`,
          );
        }

        const claimReceipt = await publicClient.getTransactionReceipt({
          hash: job.claimTx as Hex,
        });
        if (claimReceipt.status !== "success")
          throw new Error(`Claim transaction ${job.claimTx} did not succeed`);
        const claimEvents = parseEventLogs({
          abi: meshReceiptAbi,
          logs: claimReceipt.logs,
          eventName: "ClaimPosted",
          strict: true,
        });
        if (
          !claimEvents.some(
            (event) =>
              event.args.jobId.toLowerCase() === job.jobId.toLowerCase() &&
              event.args.merkleRoot.toLowerCase() ===
                chainReceipt.merkleRoot.toLowerCase(),
          )
        ) {
          throw new Error(
            `Claim transaction ${job.claimTx} has no matching ClaimPosted event for ${job.jobId}`,
          );
        }
        const seed = deriveSampleSeed(
          job.jobId,
          job.merkleRoot,
          claimReceipt.blockHash,
        );
        const indices = selectSampleIndices(seed, job.tileCount, SAMPLE_RATE);
        const { leaves, tiles } = await assertMerkleCommitment(
          job,
          chainReceipt.merkleRoot,
        );
        log(
          `Verifying ${job.jobId}: sampled ${indices.length}/${job.tileCount} tiles [${indices.join(",")}]`,
        );

        const recomputed = await recomputeSample(job, indices);
        const mismatch = recomputed.find(
          (tile) =>
            tile.tileHash.toLowerCase() !==
            tiles[tile.index]?.tileHash.toLowerCase(),
        );
        const windowEnd = chainReceipt.windowEnd;
        if (mismatch) {
          const claimed = tiles[mismatch.index];
          const proof = await merkleProof(leaves, mismatch.index);
          const validProof = await verifyProof(
            leaves[mismatch.index],
            mismatch.index,
            proof,
            chainReceipt.merkleRoot,
          );
          if (!validProof)
            throw new Error(
              `Local Merkle proof validation failed for tile ${mismatch.index}`,
            );
          processed.set(job.jobId, {
            claimTx: job.claimTx,
            outcome: "fraud",
            windowEnd,
          });
          const currentBlock = await publicClient.getBlock({
            blockTag: "latest",
          });
          if (currentBlock.timestamp > windowEnd) {
            log(
              `Fraud found for ${job.jobId}, but the challenge window has closed; no fraud transaction sent`,
            );
            continue;
          }
          if (walletClient) {
            const gasPrice = await publicClient.getGasPrice();
            const hash = await walletClient.writeContract({
              account: account!,
              chain,
              address: receiptAddress,
              abi: meshReceiptAbi,
              functionName: "postFraud",
              args: [
                job.jobId as Hex,
                mismatch.index,
                claimed.owner,
                `0x${mismatch.tileHash}` as Hex,
                `0x${claimed.tileHash}` as Hex,
                proof,
              ],
              type: "legacy",
              gasPrice,
            });
            const txReceipt = await publicClient.waitForTransactionReceipt({
              hash,
              timeout: 90_000,
            });
            if (txReceipt.status !== "success")
              throw new Error(`postFraud transaction failed: ${hash}`);
            log(
              `Fraud submitted for ${job.jobId}, tile ${mismatch.index}; tx=${hash}`,
            );
            log(
              "API verdict notification is pending an API endpoint; the current API does not expose one.",
            );
          } else {
            log(
              `DRY RUN fraud payload for ${job.jobId}, tile ${mismatch.index}: owner=${claimed.owner}, expected=0x${mismatch.tileHash}, claimed=0x${claimed.tileHash}, proof=${JSON.stringify(proof)}`,
            );
            log(
              "API verdict notification is pending an API endpoint; the current API does not expose one.",
            );
          }
          continue;
        }

        processed.set(job.jobId, {
          claimTx: job.claimTx,
          outcome: "clean",
          windowEnd,
        });
        log(
          `Sample passed for ${job.jobId}; challenge window ends at ${windowEnd}`,
        );
        await finalizeIfReady(job.jobId, windowEnd);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log(`Verification failed for ${job.jobId}: ${message}`);
      }
    }
    if (actionable === 0)
      log(
        `No pending API jobs with a mined claim transaction (${jobs.length} pending job(s) scanned)`,
      );
  };

  const finalizeIfReady = async (jobId: string, windowEnd: bigint) => {
    const currentBlock = await publicClient.getBlock({ blockTag: "latest" });
    if (currentBlock.timestamp <= windowEnd) return;
    if (walletClient) {
      const gasPrice = await publicClient.getGasPrice();
      const hash = await walletClient.writeContract({
        account: account!,
        chain,
        address: receiptAddress,
        abi: meshReceiptAbi,
        functionName: "finalize",
        args: [jobId as Hex],
        type: "legacy",
        gasPrice,
      });
      const txReceipt = await publicClient.waitForTransactionReceipt({
        hash,
        timeout: 90_000,
      });
      if (txReceipt.status !== "success")
        throw new Error(`finalize transaction failed: ${hash}`);
      processed.delete(jobId);
      log(`Finalized ${jobId}; tx=${hash}`);
      log(
        "API status update is pending an API endpoint; the current API does not expose one.",
      );
    } else if (!finalizeReadyReported.has(jobId)) {
      finalizeReadyReported.add(jobId);
      log(
        `DRY RUN: ${jobId} passed verification and its challenge window has closed; finalize is ready`,
      );
    }
  };

  do {
    await poll().catch((error: unknown) =>
      log(
        `Poll failed: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
    if (process.argv.includes("--once") || stopped.signal.aborted) break;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, POLL_MS);
      stopped.signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  } while (!stopped.signal.aborted);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`mesh verifier worker failed: ${message}`);
  process.exitCode = 1;
});
