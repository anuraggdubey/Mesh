import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
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
import {
  runDockerTask,
  type ProviderTask,
  type TileOutput,
} from "./docker-runner";

const HEARTBEAT_MS = 5_000;
const POLL_WAIT_SECONDS = 20;
const MAX_INPUT_BYTES = 64 * 1024;
const FAILURE_LOG_BYTES = 4_000;

export type ProviderRegistration = {
  address: Address;
  signature: Hex;
  nonce: Hex;
  cores: number;
  memoryGb: number;
  os: string;
  arch: string;
  agentVersion: string;
  worldProof: unknown;
};

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function computeTilesDigest(
  tiles: Array<Pick<TileOutput, "index" | "tileHash">>,
): Hex {
  if (tiles.length === 0) throw new Error("Cannot sign a claim without tiles");
  const ordered = [...tiles].sort((a, b) => a.index - b.index);
  const encoded = Buffer.concat(
    ordered.map(({ index, tileHash }) => {
      if (!Number.isInteger(index) || index < 0 || index > 65535) {
        throw new Error(`Invalid tile index ${index}`);
      }
      if (!/^[a-f0-9]{64}$/.test(tileHash)) {
        throw new Error(`Invalid tile hash for tile ${index}`);
      }
      const indexBytes = Buffer.alloc(2);
      indexBytes.writeUInt16BE(index);
      return Buffer.concat([indexBytes, Buffer.from(tileHash, "hex")]);
    }),
  );
  return `0x${sha256Hex(encoded)}`;
}

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
          "Set PROVIDER_PRIVATE_KEY and either PROVIDER_TOKEN or PROVIDER_WORLD_PROOF_FILE in .env.\n",
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

class ProviderApi {
  private readonly root: URL;

  constructor(
    baseUrl: string,
    private token?: string,
  ) {
    this.root = new URL(`${baseUrl.replace(/\/+$/, "")}/api/`);
  }

  setToken(token: string): void {
    this.token = token;
  }

  private async request(
    path: string,
    init: RequestInit = {},
    timeoutMs = 30_000,
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.token) headers.set("Authorization", `Bearer ${this.token}`);
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = init.signal
      ? AbortSignal.any([init.signal, timeoutSignal])
      : timeoutSignal;
    const response = await fetch(new URL(path.replace(/^\/+/, ""), this.root), {
      ...init,
      headers,
      signal,
    });
    if (!response.ok) {
      const body = (await response.text()).slice(0, 1000);
      throw new Error(
        `API ${init.method ?? "GET"} ${path} returned ${response.status}: ${body}`,
      );
    }
    return response;
  }

  async register(
    body: ProviderRegistration,
  ): Promise<{ providerId: string; token: string }> {
    const response = await this.request("providers/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const result = (await response.json()) as {
      providerId?: unknown;
      token?: unknown;
    };
    if (
      typeof result.providerId !== "string" ||
      typeof result.token !== "string"
    ) {
      throw new Error(
        "Provider registration response is missing providerId or token",
      );
    }
    return { providerId: result.providerId, token: result.token };
  }

  async heartbeat(load: number, currentTask: string | null): Promise<void> {
    await this.request("providers/heartbeat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ load, currentTask }),
    });
  }

  async pollTasks(signal: AbortSignal): Promise<ProviderTask[]> {
    const response = await this.request(
      `providers/tasks?wait=${POLL_WAIT_SECONDS}`,
      { signal },
      (POLL_WAIT_SECONDS + 10) * 1000,
    );
    const body = (await response.json()) as { tasks?: unknown };
    if (!Array.isArray(body.tasks))
      throw new Error("Task poll response must contain a tasks array");
    return body.tasks.map(parseProviderTask);
  }

  async getInput(jobId: string, signal: AbortSignal): Promise<Uint8Array> {
    const response = await this.request(
      `jobs/${encodeURIComponent(jobId)}/input`,
      { signal },
    );
    const contentLength = Number(response.headers.get("content-length") ?? 0);
    if (contentLength > MAX_INPUT_BYTES)
      throw new Error("Job input exceeds the 64 KiB limit");
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_INPUT_BYTES)
      throw new Error("Job input exceeds the 64 KiB limit");
    return bytes;
  }

  async uploadTile(
    jobId: string,
    tile: TileOutput,
    signal: AbortSignal,
  ): Promise<void> {
    await this.request(
      `jobs/${encodeURIComponent(jobId)}/tiles/${tile.index}`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/octet-stream",
          "X-Tile-Hash": tile.tileHash,
        },
        body: new Uint8Array(tile.bytes),
        signal,
      },
    );
  }

  async postClaim(
    jobId: string,
    body: {
      provider: Address;
      tilesDigest: Hex;
      signature: Hex;
      tiles: Array<{ index: number; tileHash: string }>;
    },
    signal: AbortSignal,
  ): Promise<void> {
    await this.request(`jobs/${encodeURIComponent(jobId)}/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  }

  async postFailure(
    jobId: string,
    body: {
      provider: Address;
      reason:
        | "timeout"
        | "crash"
        | "hash_mismatch"
        | "killed"
        | "attestation_missing";
      logTail: string;
    },
  ): Promise<void> {
    await this.request(`jobs/${encodeURIComponent(jobId)}/failure`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }
}

function parseProviderTask(value: unknown): ProviderTask {
  if (!value || typeof value !== "object")
    throw new Error("Task must be a JSON object");
  const task = value as Partial<ProviderTask>;
  if (
    typeof task.taskId !== "string" ||
    typeof task.jobId !== "string" ||
    typeof task.type !== "string" ||
    typeof task.imageRef !== "string" ||
    typeof task.imageDigest !== "string" ||
    typeof task.inputHash !== "string" ||
    !Array.isArray(task.tiles) ||
    typeof task.timeoutSeconds !== "number"
  ) {
    throw new Error("Task response is missing required fields");
  }
  return task as ProviderTask;
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

async function readWorldProof(): Promise<unknown> {
  const path = process.env.PROVIDER_WORLD_PROOF_FILE;
  if (!path) {
    throw new Error(
      "Set PROVIDER_TOKEN or PROVIDER_WORLD_PROOF_FILE (JSON from the World ID provider registration flow)",
    );
  }
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error(`Could not read valid World ID proof JSON from ${path}`);
  }
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

export async function signProviderClaim(
  task: ProviderTask,
  account: ReturnType<typeof privateKeyToAccount>,
  tiles: TileOutput[],
  receiptAddress: Address,
  chainId = Number(process.env.HEDERA_CHAIN_ID ?? "296"),
): Promise<{ tilesDigest: Hex; signature: Hex }> {
  if (!/^0x[a-fA-F0-9]{64}$/.test(task.jobId))
    throw new Error("Task jobId must be a bytes32 hex value");
  if (
    !/^0x[a-fA-F0-9]{64}$/.test(`0x${task.imageDigest.replace(/^sha256:/, "")}`)
  ) {
    throw new Error("Task imageDigest must contain 32 digest bytes");
  }
  if (!/^[a-fA-F0-9]{64}$/.test(task.inputHash))
    throw new Error("Task inputHash must contain 32 hash bytes");
  const tilesDigest = computeTilesDigest(tiles);
  const signature = await account.signTypedData({
    domain: {
      name: "Mesh",
      version: "1",
      chainId,
      verifyingContract: receiptAddress,
    },
    types: {
      TileClaim: [
        { name: "jobId", type: "bytes32" },
        { name: "imageDigest", type: "bytes32" },
        { name: "inputHash", type: "bytes32" },
        { name: "provider", type: "address" },
        { name: "tilesDigest", type: "bytes32" },
      ],
    },
    primaryType: "TileClaim",
    message: {
      jobId: task.jobId as Hex,
      imageDigest: `0x${task.imageDigest.replace(/^sha256:/, "")}` as Hex,
      inputHash: `0x${task.inputHash}` as Hex,
      provider: account.address,
      tilesDigest,
    },
  });
  return { tilesDigest, signature };
}

export async function startProviderWorker(): Promise<void> {
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
  const chain = createChain(requiredEnv("HEDERA_RPC_URL"));
  const publicClient = createPublicClient({ chain, transport: http() });
  const api = new ProviderApi(
    apiUrl,
    process.env.PROVIDER_TOKEN?.trim() || undefined,
  );
  const abortController = new AbortController();
  let currentTask: string | null = null;
  let heartbeatRunning = false;
  const stop = () => abortController.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  const proof = apiTokenPresent() ? undefined : await readWorldProof();
  if (!apiTokenPresent()) {
    const nonce = `0x${randomBytes(32).toString("hex")}` as Hex;
    const registrationMessage = `mesh-register:${nonce}`;
    const signature = await account.signMessage({
      message: registrationMessage,
    });
    const registration = await api.register({
      address: account.address,
      signature,
      nonce,
      cores: cpus().length,
      memoryGb: Math.round((totalmem() / 1024 ** 3) * 100) / 100,
      os: platform(),
      arch: arch(),
      agentVersion: process.env.MESH_AGENT_VERSION ?? "0.1.0",
      worldProof: proof,
    });
    api.setToken(registration.token);
    log(`Registered provider ${registration.providerId} (${account.address})`);
  } else {
    log(`Using configured provider token for ${account.address}`);
  }

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
  if (tamperEnabled) {
    log(
      `!!! TAMPER MODE ENABLED: corrupting ${tamperPercent}% of task tiles before hashing !!!`,
    );
  }

  const heartbeatLoop = async () => {
    while (!abortController.signal.aborted) {
      if (!heartbeatRunning) {
        heartbeatRunning = true;
        try {
          const cores = Math.max(1, cpus().length);
          const load = Math.max(0, Math.min(1, loadavg()[0] / cores));
          await api.heartbeat(load, currentTask);
        } catch (error) {
          log(
            `Heartbeat failed: ${error instanceof Error ? error.message : String(error)}`,
          );
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
        tasks = await api.pollTasks(abortController.signal);
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
          if (task.type === "infer") {
            await api.postFailure(task.jobId, {
              provider: account.address,
              reason: "attestation_missing",
              logTail:
                "The infer worker is not implemented; this provider only runs isolated Docker jobs.",
            });
            continue;
          }
          const input = await api.getInput(task.jobId, abortController.signal);
          const outputs: TileOutput[] = [];
          const collected = await runDockerTask(task, input, {
            cpus: process.env.PROVIDER_CPUS,
            memory: process.env.PROVIDER_MEMORY,
            timeoutSeconds: Number(
              process.env.JOB_TIMEOUT_SECONDS ?? task.timeoutSeconds,
            ),
            signal: abortController.signal,
            tamperPercent,
            onTile: async (tile) => {
              await api.uploadTile(task.jobId, tile, abortController.signal);
              outputs.push(tile);
              log(`Uploaded tile ${tile.index} (${tile.tileHash})`);
            },
          });
          if (collected.length !== outputs.length)
            throw new Error("Not all output tiles were uploaded");
          const { tilesDigest, signature } = await signProviderClaim(
            task,
            account,
            collected,
            receiptAddress,
          );
          await api.postClaim(
            task.jobId,
            {
              provider: account.address,
              tilesDigest,
              signature,
              tiles: collected.map(({ index, tileHash }) => ({
                index,
                tileHash,
              })),
            },
            abortController.signal,
          );
          log(
            `Claim submitted for job ${task.jobId}; tilesDigest=${tilesDigest}`,
          );
        } catch (error) {
          const reason = classifyFailure(error, abortController.signal.aborted);
          const logTail = (
            error instanceof Error
              ? (error.stack ?? error.message)
              : String(error)
          ).slice(-FAILURE_LOG_BYTES);
          try {
            await api.postFailure(task.jobId, {
              provider: account.address,
              reason,
              logTail,
            });
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
    log("Provider worker stopped");
  }
}

function apiTokenPresent(): boolean {
  return Boolean(process.env.PROVIDER_TOKEN?.trim());
}
