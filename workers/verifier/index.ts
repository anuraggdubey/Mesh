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
import {
  signVerdictReport,
  type FraudReport,
  type VerifierSample,
} from "./verdict-client";

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

  if (SUBMIT_TRANSACTIONS) {
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
  type ProcessedOutcome = {
    claimTx: string;
    outcome: "ok" | "fraud";
    windowEnd: bigint;
    sample: VerifierSample;
    fraud?: FraudReport;
    txHash?: Hex;
    txMined: boolean;
    reported: boolean;
    dryRunLogged: boolean;
    windowClosedLogged: boolean;
  };
  const processed = new Map<string, ProcessedOutcome>();

  const reportVerdict = async (jobId: string, state: ProcessedOutcome) => {
    if (!account || !state.txHash || !state.txMined) return;
    const body = await signVerdictReport(account, {
      jobId: jobId as Hex,
      result: state.outcome,
      sample: state.sample,
      fraud: state.fraud ?? null,
      finalizeTx: state.outcome === "ok" ? state.txHash : null,
      fraudTx: state.outcome === "fraud" ? state.txHash : null,
    });
    const response = await fetch(`${base}/verifier/verdict`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 300);
      throw new Error(
        `API verdict report failed (${response.status}): ${detail}`,
      );
    }
    state.reported = true;
    log(`${state.outcome} verdict reported to API for ${jobId}`);
  };

  const processOutcome = async (jobId: string, state: ProcessedOutcome) => {
    if (!walletClient || !account) {
      if (!state.dryRunLogged) {
        log(
          `DRY RUN ${state.outcome} verdict for ${jobId}; no chain transaction or API report sent`,
        );
        if (state.fraud) {
          log(`Fraud payload: ${JSON.stringify(state.fraud)}`);
        }
        state.dryRunLogged = true;
      }
      return;
    }

    if (!state.txHash) {
      const currentBlock = await publicClient.getBlock({ blockTag: "latest" });
      if (state.outcome === "ok" && currentBlock.timestamp <= state.windowEnd)
        return;
      if (
        state.outcome === "fraud" &&
        currentBlock.timestamp > state.windowEnd
      ) {
        if (!state.windowClosedLogged) {
          log(
            `Fraud found for ${jobId}, but the challenge window has closed; no transaction or API verdict sent`,
          );
          state.windowClosedLogged = true;
        }
        return;
      }

      const gasPrice = await publicClient.getGasPrice();
      const hash =
        state.outcome === "fraud"
          ? await walletClient.writeContract({
              account,
              chain,
              address: receiptAddress,
              abi: meshReceiptAbi,
              functionName: "postFraud",
              args: [
                jobId as Hex,
                state.fraud!.tileIndex,
                getAddress(state.fraud!.owner),
                state.fraud!.expectedTileHash,
                state.fraud!.claimedTileHash,
                state.fraud!.proof,
              ],
              type: "legacy",
              gasPrice,
            })
          : await walletClient.writeContract({
              account,
              chain,
              address: receiptAddress,
              abi: meshReceiptAbi,
              functionName: "finalize",
              args: [jobId as Hex],
              type: "legacy",
              gasPrice,
            });
      state.txHash = hash;
    }

    if (!state.txMined) {
      const txReceipt = await publicClient.waitForTransactionReceipt({
        hash: state.txHash,
        timeout: 90_000,
      });
      if (txReceipt.status !== "success") {
        state.txHash = undefined;
        throw new Error(`${state.outcome} transaction failed`);
      }
      state.txMined = true;
      log(
        `${state.outcome} transaction confirmed for ${jobId}; tx=${state.txHash}`,
      );
    }
    if (!state.reported) await reportVerdict(jobId, state);
  };

  const poll = async () => {
    const jobs = await fetchPendingJobs(base);
    let actionable = 0;
    for (const job of jobs) {
      if (!job.claimTx || !job.merkleRoot) continue;
      actionable += 1;
      const previous = processed.get(job.jobId);
      if (previous?.claimTx === job.claimTx) {
        try {
          await processOutcome(job.jobId, previous);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          log(`Outcome processing failed for ${job.jobId}: ${message}`);
        }
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
        const sample: VerifierSample = {
          beacon: claimReceipt.blockHash,
          seed,
          k: indices.length,
          indices,
        };
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
        let state: ProcessedOutcome;
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
          state = {
            claimTx: job.claimTx,
            outcome: "fraud",
            windowEnd: chainReceipt.windowEnd,
            sample,
            fraud: {
              tileIndex: mismatch.index,
              owner: claimed.owner,
              expectedTileHash: `0x${mismatch.tileHash}` as Hex,
              claimedTileHash: `0x${claimed.tileHash}` as Hex,
              proof,
            },
            txMined: false,
            reported: false,
            dryRunLogged: false,
            windowClosedLogged: false,
          };
        } else {
          state = {
            claimTx: job.claimTx,
            outcome: "ok",
            windowEnd: chainReceipt.windowEnd,
            sample,
            txMined: false,
            reported: false,
            dryRunLogged: false,
            windowClosedLogged: false,
          };
        }
        processed.set(job.jobId, state);
        await processOutcome(job.jobId, state);
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
