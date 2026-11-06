import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type ProviderTask = {
  taskId: string;
  jobId: string;
  type: string;
  imageRef: string;
  imageDigest: string;
  inputHash: string;
  tiles: number[];
  timeoutSeconds: number;
};

export type RunnerOptions = {
  cpus?: string;
  memory?: string;
  pidsLimit?: number;
  timeoutSeconds?: number;
  dockerCommand?: string;
  signal?: AbortSignal;
  onTile?: (tile: TileOutput) => Promise<void> | void;
  tamperPercent?: number;
};

export type TileOutput = {
  index: number;
  bytes: Buffer;
  tileHash: string;
};

const HASH_RE = /^[a-f0-9]{64}$/;
const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;
const MAX_TILE_BYTES = 1024 * 1024;

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function validateTask(task: ProviderTask): void {
  if (!task.taskId || !task.jobId || !task.imageRef) {
    throw new Error("Task is missing a required identifier or image reference");
  }
  if (!DIGEST_RE.test(task.imageDigest)) {
    throw new Error("Task imageDigest must be a sha256 digest");
  }
  if (!HASH_RE.test(task.inputHash)) {
    throw new Error("Task inputHash must be 64 hexadecimal characters");
  }
  if (!Number.isSafeInteger(task.timeoutSeconds) || task.timeoutSeconds <= 0) {
    throw new Error("Task timeoutSeconds must be a positive integer");
  }
  if (
    !Array.isArray(task.tiles) ||
    task.tiles.length === 0 ||
    task.tiles.some(
      (tile) => !Number.isInteger(tile) || tile < 0 || tile > 65535,
    ) ||
    new Set(task.tiles).size !== task.tiles.length
  ) {
    throw new Error(
      "Task tiles must be a non-empty list of distinct uint16 indexes",
    );
  }
}

function getPinnedImageReference(task: ProviderTask): string {
  const separator = task.imageRef.lastIndexOf("@");
  if (separator !== -1) {
    const suppliedDigest = task.imageRef.slice(separator + 1);
    if (suppliedDigest.toLowerCase() !== task.imageDigest.toLowerCase()) {
      throw new Error("imageRef digest does not match imageDigest");
    }
    return task.imageRef;
  }
  return `${task.imageRef}@${task.imageDigest}`;
}

function runProcess(
  command: string,
  args: string[],
  timeoutMs: number,
  abortSignal?: AbortSignal,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let cancelled = false;
    const cancel = () => {
      cancelled = true;
      child.kill("SIGTERM");
      const killTimer = setTimeout(() => child.kill("SIGKILL"), 1500);
      killTimer.unref();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1500).unref();
    }, timeoutMs);
    if (abortSignal?.aborted) cancel();
    abortSignal?.addEventListener("abort", cancel, { once: true });
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout = (stdout + chunk).slice(-16_000);
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-16_000);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      abortSignal?.removeEventListener("abort", cancel);
      reject(error);
    });
    child.once("close", (code, exitSignal) => {
      clearTimeout(timer);
      abortSignal?.removeEventListener("abort", cancel);
      if (timedOut) {
        reject(
          new Error(
            `Process timed out after ${timeoutMs}ms\n${stderr.slice(-4000)}`,
          ),
        );
      } else if (cancelled) {
        reject(new Error(`Process cancelled\n${stderr.slice(-4000)}`));
      } else if (code !== 0) {
        reject(
          new Error(
            `Process exited with ${exitSignal ? `signal ${exitSignal}` : `code ${code}`}\n${stderr.slice(-4000)}`,
          ),
        );
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

/**
 * Verify the job-level input hash, pull the immutable image, and run the task
 * in the isolated container shape defined by docs/job-spec.md.
 * `inputBytes` is the exact task-specific /input/job.json response from the API.
 */
export async function runDockerTask(
  task: ProviderTask,
  inputBytes: Uint8Array,
  options: RunnerOptions = {},
): Promise<TileOutput[]> {
  validateTask(task);
  const image = getPinnedImageReference(task);
  let input: Record<string, unknown>;
  try {
    input = JSON.parse(Buffer.from(inputBytes).toString("utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    throw new Error("Task input is not valid UTF-8 JSON");
  }
  if (!input || Array.isArray(input) || typeof input !== "object") {
    throw new Error("Task input must be a JSON object");
  }
  const jobInput = Object.fromEntries(
    Object.entries(input).filter(([key]) => key !== "tiles"),
  );
  if (
    sha256(Buffer.from(JSON.stringify(jobInput), "utf8")) !==
    task.inputHash.toLowerCase()
  ) {
    throw new Error("Input hash mismatch; refusing to run task");
  }
  if (
    !Array.isArray(input.tiles) ||
    JSON.stringify(input.tiles) !== JSON.stringify(task.tiles)
  ) {
    throw new Error("Input tile list does not match the assigned task");
  }
  const tamperPercent = options.tamperPercent ?? 0;
  if (
    !Number.isFinite(tamperPercent) ||
    tamperPercent < 0 ||
    tamperPercent > 100
  ) {
    throw new Error("tamperPercent must be between 0 and 100");
  }
  const tamperCount = Math.ceil((task.tiles.length * tamperPercent) / 100);
  const tamperedTiles = new Set(
    [...task.tiles].sort((a, b) => a - b).slice(0, tamperCount),
  );

  const docker = options.dockerCommand ?? "docker";
  const workdir = await mkdtemp(join(tmpdir(), "mesh-provider-"));
  const inputDir = join(workdir, "input");
  const outputDir = join(workdir, "output");
  const containerName = `mesh-${randomUUID()}`;
  await Promise.all([mkdir(inputDir), mkdir(outputDir)]);

  try {
    await writeFile(join(inputDir, "job.json"), inputBytes, { flag: "wx" });
    // Only this job's result directory can be changed by the unprivileged job.
    await chmod(outputDir, 0o777);
    await runProcess(docker, ["image", "pull", "--platform", "linux/amd64", image], 5 * 60_000);
    const inspect = await runProcess(
      docker,
      ["image", "inspect", "--format", "{{json .RepoDigests}}", image],
      30_000,
    );
    let repoDigests: unknown;
    try {
      repoDigests = JSON.parse(inspect.stdout.trim());
    } catch {
      throw new Error("Docker did not return image repository digests");
    }
    if (
      !Array.isArray(repoDigests) ||
      !repoDigests.some(
        (digest) =>
          typeof digest === "string" && digest.endsWith(`@${task.imageDigest}`),
      )
    ) {
      throw new Error(
        "Pulled image digest does not match the task; refusing to execute it",
      );
    }

    const timeoutSeconds = options.timeoutSeconds ?? task.timeoutSeconds;
    const args = [
      "run",
      "--rm",
      "--name",
      containerName,
      "--platform",
      "linux/amd64",
      "--network",
      "none",
      "--cpus",
      options.cpus ?? process.env.PROVIDER_CPUS ?? "4",
      "--memory",
      options.memory ?? process.env.PROVIDER_MEMORY ?? "4g",
      "--pids-limit",
      String(options.pidsLimit ?? 256),
      "--read-only",
      "--user",
      "65532:65532",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges:true",
      "--tmpfs",
      "/tmp:rw,size=64m",
      "--mount",
      `type=bind,source=${inputDir},target=/input,readonly`,
      "--mount",
      `type=bind,source=${outputDir},target=/output`,
      image,
    ];
    try {
      await runProcess(docker, args, timeoutSeconds * 1000, options.signal);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.startsWith("Process timed out")
      ) {
        await runProcess(docker, ["kill", containerName], 10_000).catch(
          () => undefined,
        );
        throw new Error(
          `Task ${task.taskId} timed out after ${timeoutSeconds}s`,
        );
      }
      if (
        error instanceof Error &&
        error.message.startsWith("Process cancelled")
      ) {
        await runProcess(docker, ["kill", containerName], 10_000).catch(
          () => undefined,
        );
        throw new Error(`Task ${task.taskId} was cancelled`);
      }
      throw error;
    }

    const outputs: TileOutput[] = [];
    for (const index of task.tiles) {
      const tilePath = join(outputDir, `tile-${index}.bin`);
      const fileStat = await stat(tilePath).catch(() => null);
      if (
        !fileStat?.isFile() ||
        fileStat.size === 0 ||
        fileStat.size > MAX_TILE_BYTES
      ) {
        throw new Error(`Task did not produce a valid tile-${index}.bin`);
      }
      const bytes = await readFile(tilePath);
      if (tamperedTiles.has(index)) bytes[0] ^= 0xff;
      const output = { index, bytes, tileHash: sha256(bytes) };
      outputs.push(output);
      await options.onTile?.(output);
    }
    const unexpected = (await readdir(outputDir)).filter((name) => {
      const match = /^tile-(\d+)\.bin$/.exec(name);
      return !match || !task.tiles.includes(Number(match[1]));
    });
    if (unexpected.length > 0) {
      throw new Error(
        `Task produced unexpected output files: ${unexpected.join(", ")}`,
      );
    }
    return outputs;
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
}
