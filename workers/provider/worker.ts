import { arch, cpus, loadavg, platform, totalmem } from "node:os";
import {
  formatEther,
  isAddress,
  type Address,
  type Hex,
  createPublicClient,
  defineChain,
  http,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { meshReceiptAbi } from "@/lib/abi/MeshReceipt";
import { meshStakeAbi } from "@/lib/abi/MeshStake";
import { ProviderClient, type ClientTask } from "@/lib/provider-client";
import {
  runDockerTask,
  type ProviderTask,
  type TileOutput,
} from "./docker-runner";

const HEARTBEAT_MS = 5_000;
const POLL_WAIT_SECONDS = 20;
const MAX_INPUT_BYTES = 64 * 1024;
const FAILURE_LOG_BYTES = 4_000;

export function classifyFailure(
  error: unknown,
  stopping = false,
): "timeout" | "hash_mismatch" | "killed" | "crash" {
  const message = error instanceof Error ? error.message : String(error);
  if (stopping || /cancelled|killed|sigterm|sigint/i.test(message))
    return "killed";
  if (/timed out|timeout/i.test(message)) return "timeout";
  if (/hash mismatch|digest does not match|input hash/i.test(message))
    return "hash_mismatch";
  return "crash";
}

export function configureProviderCli(args: string[]): boolean {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        "Usage: npm run worker:provider -- [--api <url>] [--tamper]\n" +
          "Set PROVIDER_PRIVATE_KEY in .env; the worker registers and obtains its API token on startup.\n",
      );
      return false;
    }
    if (arg === "--api") {
      const value = args[index + 1];
      if (!value || value.startsWith("--"))
        throw new Error("--api requires a URL");
      process.env.API_PUBLIC_URL = value;
      index += 1;
      continue;
    }
    if (arg === "--tamper") {
      process.env.MESH_TAMPER = "true";
      continue;
    }
    throw new Error(`Unknown provider worker argument: ${arg}`);
  }
  return true;
}

function parseProviderTask(value: ClientTask): ProviderTask {
  if (
    !value ||
    typeof value.taskId !== "string" ||
    typeof value.jobId !== "string" ||
    typeof value.type !== "string" ||
    typeof value.imageRef !== "string" ||
    typeof value.imageDigest !== "string" ||
    typeof value.inputHash !== "string" ||
    !Array.isArray(value.tiles) ||
    typeof value.timeoutSeconds !== "number"
  ) {
    throw new Error("Task response is missing required fields");
  }
  return value as ProviderTask;
}

function log(message: string): void {
  process.stdout.write(`${new Date().toISOString()} ${message}\n`);
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

function createChain(rpcUrl: string) {
  return defineChain({
    id: Number(process.env.HEDERA_CHAIN_ID ?? "296"),
    name: "Hedera Testnet",
    nativeCurrency: { name: "HBAR", symbol: "HBAR", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
}

async function ensureStakeEligible(
  address: Address,
  publicClient: ReturnType<typeof createPublicClient>,
  stakeAddress: Address,
  receiptAddress: Address,
): Promise<{ stake: bigint; minStake: bigint }> {
  const minStake = await publicClient.readContract({
    address: receiptAddress,
    abi: meshReceiptAbi,
    functionName: "minStake",
  });
  const [eligible, stake] = await Promise.all([
    publicClient.readContract({
      address: stakeAddress,
      abi: meshStakeAbi,
      functionName: "isEligible",
      args: [address, minStake],
    }),
    publicClient.readContract({
      address: stakeAddress,
      abi: meshStakeAbi,
      functionName: "stakeOf",
      args: [address],
    }),
  ]);
  if (!eligible) {
    throw new Error(
      `Provider ${address} is not stake-eligible (stake ${stake}, required ${minStake}); stake before running jobs`,
    );
  }
  return { stake, minStake };
}

async function processTask(
  task: ProviderTask,
  client: ProviderClient,
  signal: AbortSignal,
  tamperPercent: number,
): Promise<void> {
  if (task.type === "infer") {
    await client.reportFailure(
      task.jobId,
      "attestation_missing",
      "The infer worker is not implemented; this provider only runs isolated Docker jobs.",
    );
    return;
  }

  const inputText = await client.getInput(task.jobId, signal);
  const input = Buffer.from(inputText, "utf8");
  if (input.byteLength > MAX_INPUT_BYTES)
    throw new Error("Job input exceeds the 64 KiB limit");

  const uploaded: TileOutput[] = [];
  const outputs = await runDockerTask(task, input, {
    cpus: process.env.PROVIDER_CPUS,
    memory: process.env.PROVIDER_MEMORY,
    dockerCommand: process.env.PROVIDER_DOCKER_COMMAND,
    timeoutSeconds: Number(
      process.env.JOB_TIMEOUT_SECONDS ?? task.timeoutSeconds,
    ),
    signal,
    tamperPercent,
    onTile: async (tile) => {
      await client.putTile(task.jobId, tile.index, tile.bytes, signal);
      uploaded.push(tile);
      log(`Uploaded tile ${tile.index} (${tile.tileHash})`);
    },
  });
  if (outputs.length !== uploaded.length)
    throw new Error("Not all output tiles were uploaded");

  const result = await client.submitClaim(
    task,
    outputs.map(({ index, tileHash }) => ({ index, tileHash })),
    signal,
  );
  log(
    `Claim submitted for job ${task.jobId}; ${result.claimed}/${result.of} providers claimed${result.merkleRoot ? `; merkleRoot=${result.merkleRoot}` : ""}`,
  );
}

export async function startProviderWorker(
  options: { signal?: AbortSignal } = {},
): Promise<void> {
  const privateKeyValue = requiredEnv("PROVIDER_PRIVATE_KEY");
  const privateKey = (
    privateKeyValue.startsWith("0x") ? privateKeyValue : `0x${privateKeyValue}`
  ) as Hex;
  if (!/^0x[a-fA-F0-9]{64}$/.test(privateKey))
    throw new Error("PROVIDER_PRIVATE_KEY must be a 32-byte hex key");
  const account = privateKeyToAccount(privateKey);
  const apiUrl = requiredEnv("API_PUBLIC_URL");
  const stakeAddressValue = requiredEnv("STAKE_ADDRESS");
  const receiptAddressValue = requiredEnv("RECEIPT_ADDRESS");
  if (!isAddress(stakeAddressValue) || !isAddress(receiptAddressValue)) {
    throw new Error(
      "STAKE_ADDRESS and RECEIPT_ADDRESS must be valid EVM addresses",
    );
  }
  const stakeAddress = stakeAddressValue as Address;
  const receiptAddress = receiptAddressValue as Address;
  const chainId = Number(process.env.HEDERA_CHAIN_ID ?? "296");
  const chain = createChain(requiredEnv("HEDERA_RPC_URL"));
  const publicClient = createPublicClient({ chain, transport: http() });
  const api = new ProviderClient({
    baseUrl: apiUrl,
    account,
    chainId,
    receiptAddress,
    hardware: {
      cores: cpus().length,
      memoryGb: Math.round((totalmem() / 1024 ** 3) * 100) / 100,
      os: platform(),
      arch: arch(),
    },
    agentVersion: process.env.MESH_AGENT_VERSION ?? "0.1.0",
  });
  const abortController = new AbortController();
  let currentTask: string | null = null;
  let heartbeatRunning = false;
  const stop = () => abortController.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  options.signal?.addEventListener("abort", stop, { once: true });
  if (options.signal?.aborted) stop();

  const registration = await api.register(abortController.signal);
  log(`Registered provider ${registration.providerId} (${account.address})`);
  const { stake, minStake } = await ensureStakeEligible(
    account.address,
    publicClient,
    stakeAddress,
    receiptAddress,
  );
  log(
    `Provider stake eligibility verified on Hedera testnet (${formatEther(stake)} HBAR staked; ${formatEther(minStake)} HBAR required)`,
  );

  const tamperEnabled = process.env.MESH_TAMPER?.toLowerCase() === "true";
  const tamperPercent = tamperEnabled
    ? Number(process.env.MESH_TAMPER_PERCENT ?? "20")
    : 0;
  if (
    !Number.isFinite(tamperPercent) ||
    (tamperEnabled && (tamperPercent <= 0 || tamperPercent > 100))
  ) {
    throw new Error(
      "MESH_TAMPER_PERCENT must be between 1 and 100 when tamper mode is enabled",
    );
  }
  if (tamperEnabled)
    log(
      `!!! TAMPER MODE ENABLED: corrupting ${tamperPercent}% of task tiles before hashing !!!`,
    );

  const heartbeatLoop = async () => {
    while (!abortController.signal.aborted) {
      if (!heartbeatRunning) {
        heartbeatRunning = true;
        try {
          const cores = Math.max(1, cpus().length);
          const load = Math.max(0, Math.min(1, loadavg()[0] / cores));
          await api.heartbeat(load, currentTask, abortController.signal);
        } catch (error) {
          if (!abortController.signal.aborted) {
            log(
              `Heartbeat failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        } finally {
          heartbeatRunning = false;
        }
      }
      await delay(HEARTBEAT_MS, abortController.signal);
    }
  };
  const heartbeat = heartbeatLoop();
  let retryDelay = 1000;

  try {
    while (!abortController.signal.aborted) {
      let tasks: ProviderTask[];
      try {
        tasks = (
          await api.pollTasks(POLL_WAIT_SECONDS, abortController.signal)
        ).map(parseProviderTask);
        retryDelay = 1000;
      } catch (error) {
        if (abortController.signal.aborted) break;
        log(
          `Task poll failed; retrying: ${error instanceof Error ? error.message : String(error)}`,
        );
        await delay(retryDelay, abortController.signal);
        retryDelay = Math.min(retryDelay * 2, 20_000);
        continue;
      }
      for (const task of tasks) {
        if (abortController.signal.aborted) break;
        currentTask = task.taskId;
        log(
          `Received ${task.type} task ${task.taskId} for job ${task.jobId} (tiles ${task.tiles.join(",")})`,
        );
        try {
          await processTask(task, api, abortController.signal, tamperPercent);
        } catch (error) {
          const reason = classifyFailure(error, abortController.signal.aborted);
          const logTail = (
            error instanceof Error
              ? (error.stack ?? error.message)
              : String(error)
          ).slice(-FAILURE_LOG_BYTES);
          try {
            await api.reportFailure(task.jobId, reason, logTail);
          } catch (reportError) {
            log(
              `Could not report task failure: ${reportError instanceof Error ? reportError.message : String(reportError)}`,
            );
          }
          log(
            `Task ${task.taskId} failed (${reason}): ${error instanceof Error ? error.message : String(error)}`,
          );
        } finally {
          currentTask = null;
        }
      }
    }
  } finally {
    abortController.abort();
    await heartbeat;
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    options.signal?.removeEventListener("abort", stop);
    log("Provider worker stopped");
  }
}
