import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runDockerTask, type ProviderTask } from "./docker-runner";

const digest = `sha256:${"ab".repeat(32)}`;
const otherDigest = `sha256:${"cd".repeat(32)}`;
let tempDir: string | undefined;
let previousLog: string | undefined;

async function createFakeDocker(reportDigest: string): Promise<string> {
  tempDir = await mkdtemp(join(tmpdir(), "mesh-fake-docker-test-"));
  const executable = join(tempDir, "docker");
  previousLog = process.env.MOCK_DOCKER_LOG;
  process.env.MOCK_DOCKER_LOG = join(tempDir, "calls.log");
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.MOCK_DOCKER_LOG, args.join(" ") + "\\n");
if (args[0] === "image" && args[1] === "pull") process.exit(0);
if (args[0] === "image" && args[1] === "inspect") {
  process.stdout.write(JSON.stringify(["ghcr.io/mesh/echo@${reportDigest}"]));
  process.exit(0);
}
  const platform = args[args.indexOf("--platform") + 1];
  if (platform !== "linux/amd64") process.exit(7);
if (args[0] === "run") {
  if (!args.includes("none") || !args.includes("linux/amd64") || !args.includes("--read-only")) process.exit(4);
  const mount = args.find((arg) => arg.includes("target=/output"));
  const outputPath = mount.split(",").find((part) => part.startsWith("source=")).slice("source=".length);
  fs.writeFileSync(path.join(outputPath, "tile-0.bin"), Buffer.from("tile bytes"));
  process.exit(0);
}
process.exit(3);
`;
  await writeFile(executable, script);
  await chmod(executable, 0o755);
  return executable;
}

function makeTask(inputHash: string): ProviderTask {
  return {
    taskId: "test-task",
    jobId: `0x${"12".repeat(32)}`,
    type: "echo",
    imageRef: "ghcr.io/mesh/echo",
    imageDigest: digest,
    inputHash,
    tiles: [0],
    timeoutSeconds: 10,
  };
}

function makeInput() {
  const bytes = Buffer.from('{"spec":"echo-v1","tiles":[0]}');
  const inputHash = createHash("sha256")
    .update('{"spec":"echo-v1"}')
    .digest("hex");
  return { bytes, inputHash };
}

afterEach(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  tempDir = undefined;
  if (previousLog === undefined) delete process.env.MOCK_DOCKER_LOG;
  else process.env.MOCK_DOCKER_LOG = previousLog;
});

// These tests spawn a fake extensionless `docker` script (shebang + chmod), which Windows cannot execute.
// A real docker.exe works on Windows; only this fake is POSIX-only. Run these tests on macOS/Linux or in CI.
describe.skipIf(process.platform === "win32")("provider Docker runner", () => {
  it("runs the pinned image with isolation and returns hashed tile output", async () => {
    const docker = await createFakeDocker(digest);
    const input = makeInput();
    const result = await runDockerTask(makeTask(input.inputHash), input.bytes, {
      dockerCommand: docker,
    });
    const log = await readFile(process.env.MOCK_DOCKER_LOG!, "utf8");
    const expectedHash = createHash("sha256")
      .update("tile bytes")
      .digest("hex");

    expect(result).toHaveLength(1);
    expect(result[0].index).toBe(0);
    expect(result[0].tileHash).toBe(expectedHash);
    expect(result[0].bytes.toString()).toBe("tile bytes");
    expect(log).toContain("--network none");
    expect(log).toContain("--platform linux/amd64");
    expect(log.match(/--platform linux\/amd64/g)).toHaveLength(2);
    expect(log).toContain("pull --platform linux/amd64");
    expect(log).toContain("--read-only");
    expect(log).toContain("--user 65532:65532");
    expect(log).toContain("--cap-drop ALL");
    expect(log).toContain("--security-opt no-new-privileges:true");
  });

  it("refuses an input whose canonical job hash differs", async () => {
    const docker = await createFakeDocker(digest);
    const input = makeInput();
    await expect(
      runDockerTask(makeTask("00".repeat(32)), input.bytes, {
        dockerCommand: docker,
      }),
    ).rejects.toThrow("Input hash mismatch");
    await expect(
      readFile(process.env.MOCK_DOCKER_LOG!, "utf8"),
    ).rejects.toThrow();
  });

  it("refuses an image when the pulled digest differs from the assigned digest", async () => {
    const docker = await createFakeDocker(otherDigest);
    const input = makeInput();
    await expect(
      runDockerTask(makeTask(input.inputHash), input.bytes, {
        dockerCommand: docker,
      }),
    ).rejects.toThrow("Pulled image digest does not match");
    const log = await readFile(process.env.MOCK_DOCKER_LOG!, "utf8");
    expect(log).not.toContain("run --rm");
  });

  it("applies tampering before calculating the uploaded tile hash", async () => {
    const docker = await createFakeDocker(digest);
    const input = makeInput();
    const result = await runDockerTask(makeTask(input.inputHash), input.bytes, {
      dockerCommand: docker,
      tamperPercent: 100,
    });
    const corrupted = Buffer.from("tile bytes");
    corrupted[0] ^= 0xff;

    expect(result[0].bytes).toEqual(corrupted);
    expect(result[0].tileHash).toBe(
      createHash("sha256").update(corrupted).digest("hex"),
    );
  });
});
