// Mock provider: speaks the real provider protocol but computes FAKE tiles (no Docker, no heavy work).
// Lets the API and UI be built and tested without Misbah's real worker. Never use it for the demo.
//
//   npm run worker:mock                 # ephemeral wallet
//   MOCK_PROVIDER_PRIVATE_KEY=0x... npm run worker:mock
//
import "dotenv/config";
import { createHash } from "node:crypto";
import os from "node:os";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { ApiRequestError, ProviderClient } from "../../src/lib/provider-client";

const API = process.env.MOCK_API_URL ?? process.env.API_PUBLIC_URL ?? "http://localhost:3000";
const CHAIN_ID = Number(process.env.HEDERA_CHAIN_ID ?? 296);
const RECEIPT = process.env.RECEIPT_ADDRESS as Hex | undefined;
const WAIT_SECONDS = Number(process.env.MOCK_POLL_WAIT ?? 20);
const DELAY_MS = Number(process.env.MOCK_TILE_DELAY_MS ?? 150); // fake "compute time" per tile

const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), "[mock-provider]", ...a);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Deterministic fake pixel data of the right size: sha256 in counter mode. */
function fakeTile(jobId: string, index: number, size: number): Uint8Array {
  const out = Buffer.alloc(size);
  let off = 0;
  for (let ctr = 0; off < size; ctr += 1) {
    const block = createHash("sha256").update(`${jobId}:${index}:${ctr}`).digest();
    block.copy(out, off, 0, Math.min(block.length, size - off));
    off += block.length;
  }
  return out;
}

async function main() {
  if (!RECEIPT) throw new Error("RECEIPT_ADDRESS must be set (it is the EIP-712 verifying contract)");
  const key = (process.env.MOCK_PROVIDER_PRIVATE_KEY as Hex | undefined) ?? generatePrivateKey();
  const account = privateKeyToAccount(key);
  const client = new ProviderClient({
    baseUrl: API,
    account,
    chainId: CHAIN_ID,
    receiptAddress: RECEIPT,
    hardware: { cores: os.cpus().length, memoryGb: Math.round(os.totalmem() / 2 ** 30) || 1, os: process.platform, arch: process.arch },
    agentVersion: "mock-0.1.0",
  });

  const { providerId } = await client.register();
  log(`registered ${account.address} (provider ${providerId}) at ${API}`);

  let currentTask: string | null = null;
  const beat = setInterval(() => client.heartbeat(0.1, currentTask).catch((e) => log("heartbeat failed:", e.message)), 5000);
  process.on("SIGINT", () => {
    clearInterval(beat);
    process.exit(0);
  });

  for (;;) {
    let tasks;
    try {
      tasks = await client.pollTasks(WAIT_SECONDS);
    } catch (e) {
      log("poll failed:", (e as Error).message);
      await sleep(2000);
      continue;
    }
    for (const task of tasks) {
      currentTask = task.jobId;
      log(`job ${task.jobId.slice(0, 10)}…: ${task.tiles.length} tiles`);
      try {
        const input = JSON.parse(await client.getInput(task.jobId)) as { width: number; height: number; gridCols: number; gridRows: number; tiles: number[] };
        const size = (input.width / input.gridCols) * (input.height / input.gridRows) * 2;
        const done: { index: number; tileHash: string }[] = [];
        for (const index of input.tiles) {
          await sleep(DELAY_MS);
          const bytes = fakeTile(task.jobId, index, size);
          const p = await client.putTile(task.jobId, index, bytes);
          done.push({ index, tileHash: createHash("sha256").update(bytes).digest("hex") });
          log(`  tile ${index} uploaded (${p.done}/${p.total})`);
        }
        const res = await client.submitClaim(task, done);
        log(`  claim sent (${res.claimed}/${res.of})${res.merkleRoot ? ` merkleRoot ${res.merkleRoot.slice(0, 12)}…` : ""}`);
      } catch (e) {
        log("  task failed:", e instanceof ApiRequestError ? `${e.message} ${JSON.stringify(e.body)}` : (e as Error).message);
        await client.reportFailure(task.jobId, "crash", (e as Error).message).catch(() => {});
      } finally {
        currentTask = null;
      }
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
