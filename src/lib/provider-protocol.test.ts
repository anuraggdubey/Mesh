import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `connection()` only works inside a real Next.js request; the live-server run covers the real behavior.
vi.mock("next/server", () => ({ connection: async () => {} }));

import { createHash } from "node:crypto";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { POST as jobsPost, GET as jobsList } from "@/app/api/jobs/route";
import { GET as jobGet } from "@/app/api/jobs/[id]/route";
import { GET as inputGet } from "@/app/api/jobs/[id]/input/route";
import { GET as tileGet, PUT as tilePut } from "@/app/api/jobs/[id]/tiles/[index]/route";
import { POST as claimPost } from "@/app/api/jobs/[id]/claim/route";
import { POST as failurePost } from "@/app/api/jobs/[id]/failure/route";
import { GET as eventsGet } from "@/app/api/jobs/[id]/events/route";
import { GET as providersList } from "@/app/api/providers/route";
import { POST as registerPost } from "@/app/api/providers/register/route";
import { POST as heartbeatPost } from "@/app/api/providers/heartbeat/route";
import { GET as tasksGet } from "@/app/api/providers/tasks/route";
import { ProviderClient, ApiRequestError } from "./provider-client";
import { computeTilesDigest, registerMessage, tileClaimTypedData, imageDigestToBytes32, with0x } from "./claim";
import { merkleLeaf, merkleRoot } from "./hash";
import { getDb } from "./db";
import { getJob, listEvents, transitionJob } from "./jobs";
import { TEST_RECEIPT, TEST_REQUESTER, setupTestEnv } from "./testing";

// Test-only wallets (well-known anvil keys; never hold value).
const KEY_A = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;
const KEY_B = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex;
const KEY_C = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a" as Hex;
const BASE = "http://mesh.test";
const TILE_BYTES = 32 * 32 * 2; // `tiny` preset: 64x64 image, 2x2 grid -> 32x32 pixels, 2 bytes each

/** Route fetch() calls straight into the Next route handlers (no network). */
async function routeFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = new URL(typeof input === "string" || input instanceof URL ? input.toString() : input.url);
  const req = new Request(url, init);
  const p = url.pathname;
  const m = req.method;
  const id = (re: RegExp) => re.exec(p)?.slice(1) ?? null;
  const ctx = (params: Record<string, string>) => ({ params: Promise.resolve(params) }) as never;

  if (p === "/api/jobs") return m === "POST" ? jobsPost(req) : jobsList();
  if (p === "/api/providers") return providersList();
  if (p === "/api/providers/register") return registerPost(req);
  if (p === "/api/providers/heartbeat") return heartbeatPost(req);
  if (p === "/api/providers/tasks") return tasksGet(req);
  let g: string[] | null;
  if ((g = id(/^\/api\/jobs\/(0x[0-9a-f]+)$/))) return jobGet(req, ctx({ id: g[0] }));
  if ((g = id(/^\/api\/jobs\/([^/]+)\/input$/))) return inputGet(req, ctx({ id: g[0] }));
  if ((g = id(/^\/api\/jobs\/([^/]+)\/claim$/))) return claimPost(req, ctx({ id: g[0] }));
  if ((g = id(/^\/api\/jobs\/([^/]+)\/failure$/))) return failurePost(req, ctx({ id: g[0] }));
  if ((g = id(/^\/api\/jobs\/([^/]+)\/events$/))) return eventsGet(req, ctx({ id: g[0] }));
  if ((g = id(/^\/api\/jobs\/([^/]+)\/tiles\/([^/]+)$/))) {
    return m === "PUT" ? tilePut(req, ctx({ id: g[0], index: g[1] })) : tileGet(req, ctx({ id: g[0], index: g[1] }));
  }
  return new Response(JSON.stringify({ error: "no_route", path: p }), { status: 404 });
}

const hw = { cores: 4, memoryGb: 8, os: "test", arch: "x64" };
function makeClient(key: Hex, opts: { chainId?: number; receipt?: Hex } = {}) {
  return new ProviderClient({
    baseUrl: BASE,
    account: privateKeyToAccount(key),
    chainId: opts.chainId ?? 296,
    receiptAddress: opts.receipt ?? (TEST_RECEIPT as Hex),
    hardware: hw,
  });
}

const tileData = (index: number) => Buffer.alloc(TILE_BYTES, index + 1);
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

async function createJob(preset: "tiny" | "small" = "tiny") {
  const res = await routeFetch(`${BASE}/api/jobs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "render", preset, requester: TEST_REQUESTER }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as ReturnType<typeof getJob> & object;
}

async function expectStatus(p: Promise<unknown>, status: number, code?: string) {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ApiRequestError);
    expect((e as ApiRequestError).status).toBe(status);
    if (code) expect(((e as ApiRequestError).body as { error: string }).error).toBe(code);
    return;
  }
  throw new Error(`expected HTTP ${status}${code ? ` ${code}` : ""} but the request succeeded`);
}

describe("provider protocol", () => {
  let cleanup: () => void;
  beforeEach(() => {
    cleanup = setupTestEnv({ MESH_DEV_SKIP_PAYMENT: "true" });
    vi.stubGlobal("fetch", routeFetch);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  describe("registration", () => {
    it("registers a provider and lists it publicly without secrets", async () => {
      const a = makeClient(KEY_A);
      const { providerId } = await a.register();
      expect(providerId).toMatch(/^[0-9a-f-]{36}$/);
      const list = (await (await providersList()).json()) as { providers: Record<string, unknown>[] };
      expect(list.providers).toHaveLength(1);
      expect(list.providers[0]).toMatchObject({ address: a.address, cores: 4, online: true, worldVerified: false });
      expect(JSON.stringify(list)).not.toMatch(/token/i);
    });

    const body = async (key: Hex, nonce: string, extra: Record<string, unknown> = {}, signWith: Hex = key) => ({
      address: privateKeyToAccount(key).address,
      signature: await privateKeyToAccount(signWith).signMessage({ message: registerMessage(nonce) }),
      nonce,
      cores: 2,
      memoryGb: 4,
      os: "x",
      arch: "y",
      agentVersion: "t",
      ...extra,
    });
    const post = (b: unknown) =>
      registerPost(new Request(`${BASE}/api/providers/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }));
    const freshNonce = () => `${Date.now()}-${Math.random().toString(36).slice(2, 14).padEnd(12, "x")}`;

    it("rejects a signature from a different key", async () => {
      const res = await post(await body(KEY_A, freshNonce(), {}, KEY_B));
      expect(res.status).toBe(401);
      expect((await res.json()).error).toBe("bad_signature");
    });

    it("rejects a replayed nonce", async () => {
      const b = await body(KEY_A, freshNonce());
      expect((await post(b)).status).toBe(200);
      const again = await post(b);
      expect(again.status).toBe(409);
      expect((await again.json()).error).toBe("nonce_replayed");
    });

    it("rejects stale, future and malformed nonces", async () => {
      const old = `${Date.now() - 10 * 60 * 1000}-abcdefghijkl`;
      const future = `${Date.now() + 10 * 60 * 1000}-abcdefghijkl`;
      expect((await (await post(await body(KEY_A, old))).json()).error).toBe("nonce_expired");
      expect((await (await post(await body(KEY_A, future))).json()).error).toBe("nonce_expired");
      expect((await (await post(await body(KEY_A, "not-a-valid-nonce-format"))).json()).error).toBe("bad_nonce");
    });

    it("rejects invalid bodies", async () => {
      const res = await post(await body(KEY_A, freshNonce(), { cores: 0 }));
      expect(res.status).toBe(400);
      expect((await post({ address: "nope" })).status).toBe(400);
    });

    it("re-registering rotates the token and invalidates the old one", async () => {
      const a = makeClient(KEY_A);
      await a.register();
      const oldClient = Object.create(a) as ProviderClient; // keeps the first token
      const first = (a as unknown as { token: string }).token;
      await a.register();
      expect((a as unknown as { token: string }).token).not.toBe(first);
      (oldClient as unknown as { token: string }).token = first;
      await expectStatus(oldClient.heartbeat(), 401, "unauthorized");
      await a.heartbeat(); // the new token works
      const list = (await (await providersList()).json()) as { providers: unknown[] };
      expect(list.providers).toHaveLength(1);
    });
  });

  describe("authentication", () => {
    it("every provider endpoint refuses missing or bad tokens", async () => {
      const job = await createJob();
      const h = (token?: string) => ({ ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" });
      const calls: [string, string, BodyInit | undefined][] = [
        ["POST", "/api/providers/heartbeat", "{}"],
        ["GET", "/api/providers/tasks", undefined],
        ["GET", `/api/jobs/${job.jobId}/input`, undefined],
        ["PUT", `/api/jobs/${job.jobId}/tiles/0`, "x"],
        ["POST", `/api/jobs/${job.jobId}/claim`, "{}"],
        ["POST", `/api/jobs/${job.jobId}/failure`, "{}"],
      ];
      for (const [method, path, b] of calls) {
        for (const token of [undefined, "short", "z".repeat(64), "0".repeat(64)]) {
          const res = await routeFetch(`${BASE}${path}`, { method, headers: h(token), body: b });
          expect(res.status, `${method} ${path} token=${token}`).toBe(401);
        }
      }
    });

    it("heartbeat records load and current task", async () => {
      const a = makeClient(KEY_A);
      await a.register();
      await a.heartbeat(0.75, "some-job");
      const list = (await (await providersList()).json()) as { providers: { load: number; currentTask: string }[] };
      expect(list.providers[0]).toMatchObject({ load: 0.75, currentTask: "some-job" });
    });
  });

  describe("assignment", () => {
    it("holds a paid job until a provider is online, then assigns it", async () => {
      const job = await createJob();
      expect(job.status).toBe("paid");
      expect(job.providers).toEqual([]);

      const a = makeClient(KEY_A);
      await a.register();
      const tasks = await a.pollTasks();
      expect(tasks).toHaveLength(1);
      expect(tasks[0].tiles).toEqual([0, 1, 2, 3]);
      expect(getJob(job.jobId)?.status).toBe("running");
    });

    it("assigns immediately when a provider is already online and splits tiles round-robin", async () => {
      const a = makeClient(KEY_A);
      const b = makeClient(KEY_B);
      await a.register();
      await b.register();
      const job = await createJob();
      expect(job.status).toBe("assigned");

      // order is registration time then address, so work out who is providers[0]
      const order = [...[a, b]].sort((x, y) => x.address.toLowerCase().localeCompare(y.address.toLowerCase()));
      expect(job.providers.map((p: string) => p.toLowerCase())).toEqual(order.map((c) => c.address.toLowerCase()));
      job.tiles.forEach((t: { index: number; owner: string | null; status: string }) => {
        expect(t.owner?.toLowerCase()).toBe(order[t.index % 2].address.toLowerCase());
        expect(t.status).toBe("assigned");
      });

      const t0 = await order[0].pollTasks();
      const t1 = await order[1].pollTasks();
      expect(t0[0].tiles).toEqual([0, 2]);
      expect(t1[0].tiles).toEqual([1, 3]);
      expect(getJob(job.jobId)?.status).toBe("running");
    });

    it("does not assign work to a provider that stopped heartbeating", async () => {
      const a = makeClient(KEY_A);
      await a.register();
      getDb().prepare("UPDATE providers SET last_seen = 1").run(); // long offline
      const job = await createJob();
      expect(job.status).toBe("paid");
    });

    it("delivers a task only once", async () => {
      const a = makeClient(KEY_A);
      await a.register();
      await createJob();
      expect(await a.pollTasks()).toHaveLength(1);
      expect(await a.pollTasks()).toHaveLength(0);
    });

    it("hands the exact per-provider input file and refuses other providers", async () => {
      const a = makeClient(KEY_A);
      const b = makeClient(KEY_B);
      await a.register();
      await b.register();
      const job = await createJob();
      const tasks = await a.pollTasks();
      const input = JSON.parse(await a.getInput(job.jobId));
      expect(input).toMatchObject({ spec: "render-v1", width: 64, gridCols: 2, maxIter: 500 });
      expect(input.tiles).toEqual(tasks[0].tiles);

      const c = makeClient(KEY_C);
      await c.register();
      await expectStatus(c.getInput(job.jobId), 403, "no_task");
    });
  });

  describe("full happy path with two providers", () => {
    it("assign -> run -> upload -> claim -> pending with the correct Merkle root", async () => {
      const a = makeClient(KEY_A);
      const b = makeClient(KEY_B);
      await a.register();
      await b.register();
      const job = await createJob();
      const providers = job.providers as string[];

      const clientFor = (addr: string) => (addr.toLowerCase() === a.address.toLowerCase() ? a : b);
      const hashes: Record<number, string> = {};

      for (const addr of providers) {
        const c = clientFor(addr);
        const [task] = await c.pollTasks();
        const mine: { index: number; tileHash: string }[] = [];
        for (const index of task.tiles) {
          const bytes = tileData(index);
          const progress = await c.putTile(job.jobId, index, bytes);
          expect(progress.total).toBe(4);
          hashes[index] = sha(bytes);
          mine.push({ index, tileHash: hashes[index] });
        }
        const res = await c.submitClaim(task, mine);
        expect(res.ok).toBe(true);
        if (addr === providers[0]) {
          expect(res).toMatchObject({ claimed: 1, of: 2, merkleRoot: null });
          expect(getJob(job.jobId)?.status).toBe("running");
        } else {
          expect(res.claimed).toBe(2);
        }
      }

      const done = getJob(job.jobId)!;
      expect(done.status).toBe("pending");
      const leaves = await Promise.all([0, 1, 2, 3].map((i) => merkleLeaf(i, hashes[i], providers[i % 2])));
      expect(done.merkleRoot).toBe(await merkleRoot(leaves));
      expect(done.tiles.every((t) => t.status === "uploaded" && t.tileHash === hashes[t.index])).toBe(true);

      // the tile bytes are retrievable by anyone
      const raw = await routeFetch(`${BASE}/api/jobs/${job.jobId}/tiles/2`);
      expect(raw.status).toBe(200);
      expect(Buffer.from(await raw.arrayBuffer()).equals(tileData(2))).toBe(true);
      expect((await routeFetch(`${BASE}/api/jobs/${job.jobId}/tiles/9`)).status).toBe(404);

      // event trail: status changes, tiles, progress, claim
      const types = listEvents(job.jobId).map((e) => e.type);
      expect(types.filter((t) => t === "tile")).toHaveLength(4);
      expect(types).toContain("assigned");
      expect(types).toContain("claim");
      const statuses = listEvents(job.jobId).filter((e) => e.type === "status").map((e) => e.data.status);
      expect(statuses).toEqual(["created", "paid", "assigned", "running", "pending"]);
      const progress = listEvents(job.jobId).filter((e) => e.type === "progress").map((e) => e.data.done);
      expect(progress).toEqual([1, 2, 3, 4]);
    });

    it("works for a single provider owning every tile", async () => {
      const a = makeClient(KEY_A);
      await a.register();
      const job = await createJob();
      const [task] = await a.pollTasks();
      expect(task.tiles).toEqual([0, 1, 2, 3]);
      const tiles = [];
      for (const index of task.tiles) {
        await a.putTile(job.jobId, index, tileData(index));
        tiles.push({ index, tileHash: sha(tileData(index)) });
      }
      const res = await a.submitClaim(task, tiles);
      expect(res).toMatchObject({ claimed: 1, of: 1 });
      expect(getJob(job.jobId)?.status).toBe("pending");
    });
  });

  describe("tile upload validation", () => {
    async function runningJob() {
      const a = makeClient(KEY_A);
      const b = makeClient(KEY_B);
      await a.register();
      await b.register();
      const job = await createJob();
      const order = [a, b].sort((x, y) => x.address.toLowerCase().localeCompare(y.address.toLowerCase()));
      const [t0] = await order[0].pollTasks();
      const [t1] = await order[1].pollTasks();
      return { job, p0: order[0], p1: order[1], t0, t1 };
    }
    const rawPut = (client: ProviderClient, jobId: string, index: number, bytes: Uint8Array, hash: string) =>
      routeFetch(`${BASE}/api/jobs/${jobId}/tiles/${index}`, {
        method: "PUT",
        headers: { authorization: `Bearer ${(client as unknown as { token: string }).token}`, "x-tile-hash": hash },
        body: Buffer.from(bytes),
      });

    it("rejects a tile the provider does not own", async () => {
      const { job, p0 } = await runningJob();
      await expectStatus(p0.putTile(job.jobId, 1, tileData(1)), 403, "not_tile_owner");
    });

    it("rejects wrong sizes, hash mismatches and malformed hashes", async () => {
      const { job, p0 } = await runningJob();
      await expectStatus(p0.putTile(job.jobId, 0, Buffer.alloc(10)), 400, "bad_tile_size");
      await expectStatus(p0.putTile(job.jobId, 0, Buffer.alloc(0)), 413);
      expect((await (await rawPut(p0, job.jobId, 0, tileData(0), "0".repeat(64))).json()).error).toBe("tile_hash_mismatch");
      expect((await (await rawPut(p0, job.jobId, 0, tileData(0), "xyz")).json()).error).toBe("bad_tile_hash");
      expect((await (await rawPut(p0, job.jobId, 99, tileData(0), sha(tileData(0)))).json()).error).toBe("bad_tile_index");
    });

    it("is idempotent for identical bytes and rejects a conflicting re-upload", async () => {
      const { job, p0 } = await runningJob();
      await p0.putTile(job.jobId, 0, tileData(0));
      await p0.putTile(job.jobId, 0, tileData(0)); // same bytes: fine
      expect(getJob(job.jobId)!.tiles.filter((t) => t.status === "uploaded")).toHaveLength(1);
      await expectStatus(p0.putTile(job.jobId, 0, tileData(7)), 409, "tile_conflict");
      expect(listEvents(job.jobId).filter((e) => e.type === "tile")).toHaveLength(1);
    });

    it("refuses uploads once the job is no longer running", async () => {
      const { job, p0, t0 } = await runningJob();
      await p0.reportFailure(job.jobId, "crash");
      await expectStatus(p0.putTile(job.jobId, t0.tiles[0], tileData(0)), 409, "job_not_running");
    });

    it("404s for unknown jobs and 400s for bad ids", async () => {
      const { p0 } = await runningJob();
      await expectStatus(p0.putTile("0x" + "ab".repeat(32), 0, tileData(0)), 404, "job_not_found");
      const res = await routeFetch(`${BASE}/api/jobs/not-an-id/tiles/0`, {
        method: "PUT",
        headers: { authorization: `Bearer ${(p0 as unknown as { token: string }).token}`, "x-tile-hash": "0".repeat(64) },
        body: "x",
      });
      expect(res.status).toBe(400);
    });
  });

  describe("claim validation", () => {
    async function readyToClaim() {
      const a = makeClient(KEY_A);
      await a.register();
      const job = await createJob();
      const [task] = await a.pollTasks();
      const tiles: { index: number; tileHash: string }[] = [];
      for (const index of task.tiles) {
        await a.putTile(job.jobId, index, tileData(index));
        tiles.push({ index, tileHash: sha(tileData(index)) });
      }
      return { a, job, task, tiles };
    }
    const rawClaim = async (a: ProviderClient, jobId: string, body: Record<string, unknown>) =>
      routeFetch(`${BASE}/api/jobs/${jobId}/claim`, {
        method: "POST",
        headers: { authorization: `Bearer ${(a as unknown as { token: string }).token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const sign = async (key: Hex, job: { jobId: string; imageDigest: string; inputHash: string }, tilesDigest: Hex, o: { chainId?: number; verifying?: Hex } = {}) =>
      privateKeyToAccount(key).signTypedData(
        tileClaimTypedData(
          {
            jobId: job.jobId as Hex,
            imageDigest: imageDigestToBytes32(job.imageDigest),
            inputHash: with0x(job.inputHash),
            provider: privateKeyToAccount(KEY_A).address,
            tilesDigest,
          },
          o.chainId ?? 296,
          o.verifying ?? (TEST_RECEIPT as Hex),
        ),
      );

    it("rejects a claim before every tile is uploaded", async () => {
      const a = makeClient(KEY_A);
      await a.register();
      const job = await createJob();
      const [task] = await a.pollTasks();
      await a.putTile(job.jobId, 0, tileData(0));
      const tiles = task.tiles.map((index) => ({ index, tileHash: sha(tileData(index)) }));
      await expectStatus(a.submitClaim(task, tiles), 409, "tile_missing");
    });

    it("rejects a claim over the wrong set of tiles", async () => {
      const { a, task, tiles } = await readyToClaim();
      await expectStatus(a.submitClaim(task, tiles.slice(0, 2)), 400, "tiles_mismatch");
    });

    it("rejects a claim whose tile hash differs from the uploaded tile", async () => {
      const { a, task, tiles } = await readyToClaim();
      const bad = tiles.map((t, i) => (i === 0 ? { ...t, tileHash: sha(Buffer.from("other")) } : t));
      await expectStatus(a.submitClaim(task, bad), 400, "tile_hash_mismatch");
    });

    it("rejects a wrong tilesDigest", async () => {
      const { a, job, tiles } = await readyToClaim();
      const wrong = `0x${"11".repeat(32)}` as Hex;
      const res = await rawClaim(a, job.jobId, { provider: a.address, tilesDigest: wrong, signature: await sign(KEY_A, job, wrong), tiles });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("tiles_digest_mismatch");
    });

    it("rejects a signature from another key, another chain, or another verifying contract", async () => {
      const { a, job, tiles } = await readyToClaim();
      const digest = computeTilesDigest(tiles);
      const cases: [string, string][] = [
        ["other key", await sign(KEY_B, job, digest)],
        ["other chain", await sign(KEY_A, job, digest, { chainId: 1 })],
        ["other contract", await sign(KEY_A, job, digest, { verifying: "0x16eFE46De1CdA06Be455607A63514319aE130010" })],
      ];
      for (const [label, signature] of cases) {
        const res = await rawClaim(a, job.jobId, { provider: a.address, tilesDigest: digest, signature, tiles });
        expect(res.status, label).toBe(400);
        expect((await res.json()).error, label).toBe("bad_signature");
      }
      expect(getJob(job.jobId)?.status).toBe("running");
    });

    it("rejects a claim naming a different provider", async () => {
      const { a, job, tiles } = await readyToClaim();
      const digest = computeTilesDigest(tiles);
      const res = await rawClaim(a, job.jobId, {
        provider: privateKeyToAccount(KEY_B).address,
        tilesDigest: digest,
        signature: await sign(KEY_A, job, digest),
        tiles,
      });
      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe("provider_mismatch");
    });

    it("rejects a second claim from the same provider", async () => {
      const a = makeClient(KEY_A);
      const b = makeClient(KEY_B);
      await a.register();
      await b.register();
      const job = await createJob();
      const order = [a, b].sort((x, y) => x.address.toLowerCase().localeCompare(y.address.toLowerCase()));
      const [task] = await order[0].pollTasks();
      const tiles = [];
      for (const index of task.tiles) {
        await order[0].putTile(job.jobId, index, tileData(index));
        tiles.push({ index, tileHash: sha(tileData(index)) });
      }
      await order[0].submitClaim(task, tiles);
      await expectStatus(order[0].submitClaim(task, tiles), 409, "already_claimed");
    });

    it("refuses a claim from a provider with no tiles on the job", async () => {
      const { job, task, tiles } = await readyToClaim();
      const c = makeClient(KEY_C);
      await c.register();
      await expectStatus(c.submitClaim(task, tiles), 403, "no_task");
      expect(getJob(job.jobId)?.status).toBe("running");
    });
  });

  describe("failure reporting", () => {
    it("fails the job and records an error event", async () => {
      const a = makeClient(KEY_A);
      await a.register();
      const job = await createJob();
      await a.pollTasks();
      await a.reportFailure(job.jobId, "timeout", "container exceeded 120s");
      expect(getJob(job.jobId)?.status).toBe("failed");
      const err = listEvents(job.jobId).find((e) => e.type === "error");
      expect(err?.data).toMatchObject({ code: "timeout", logTail: "container exceeded 120s" });
    });

    it("refuses failures from strangers and for the wrong provider", async () => {
      const a = makeClient(KEY_A);
      const c = makeClient(KEY_C);
      await a.register();
      const job = await createJob(); // only A is online, so only A gets tiles
      await a.pollTasks();
      await c.register(); // C joins after assignment and has no tiles on this job
      await expectStatus(c.reportFailure(job.jobId, "crash"), 403, "no_task");
      expect(getJob(job.jobId)?.status).toBe("running");
    });

    it("rejects an unknown reason", async () => {
      const a = makeClient(KEY_A);
      await a.register();
      const job = await createJob();
      await a.pollTasks();
      await expectStatus(a.reportFailure(job.jobId, "gremlins"), 400);
    });
  });

  describe("events stream (SSE)", () => {
    it("replays history and ends when the job is terminal", async () => {
      const a = makeClient(KEY_A);
      await a.register();
      const job = await createJob();
      await a.pollTasks();
      await a.reportFailure(job.jobId, "crash");
      transitionJob(job.jobId, "refunded"); // a failed job is only terminal after its refund

      const res = await routeFetch(`${BASE}/api/jobs/${job.jobId}/events`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/event-stream");
      const text = await res.text(); // returns because the stream closes on a terminal job
      expect(text).toContain("event: status");
      expect(text).toContain('"status":"failed"');
      expect(text).toContain('"status":"refunded"');
      expect(text).toContain("event: error");
      const ids = [...text.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
      expect(ids).toEqual([...ids].sort((x, y) => x - y));
    });

    it("resumes after a given event id", async () => {
      const a = makeClient(KEY_A);
      await a.register();
      const job = await createJob();
      await a.pollTasks();
      await a.reportFailure(job.jobId, "crash");
      transitionJob(job.jobId, "refunded");
      const all = listEvents(job.jobId);
      const after = all[1].id;
      const text = await (await routeFetch(`${BASE}/api/jobs/${job.jobId}/events?after=${after}`)).text();
      const ids = [...text.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
      expect(ids).toEqual(all.filter((e) => e.id > after).map((e) => e.id));
    });

    it("stays open while the job is not terminal and streams new events live", async () => {
      const a = makeClient(KEY_A);
      await a.register();
      const job = await createJob();
      const controller = new AbortController();
      const res = await routeFetch(`${BASE}/api/jobs/${job.jobId}/events`, { signal: controller.signal });
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      let text = "";
      const readUntil = async (needle: string) => {
        while (!text.includes(needle)) {
          const { value, done } = await reader.read();
          if (done) throw new Error(`stream ended before "${needle}"; got: ${text}`);
          text += dec.decode(value);
        }
      };
      await readUntil('"status":"assigned"'); // replayed history
      await a.pollTasks(); // -> running, produced AFTER the stream was opened
      await readUntil('"status":"running"');
      controller.abort();
      await reader.cancel().catch(() => {});
    });

    it("404s for unknown jobs and 400s for bad ids", async () => {
      expect((await routeFetch(`${BASE}/api/jobs/0x${"ab".repeat(32)}/events`)).status).toBe(404);
      expect((await routeFetch(`${BASE}/api/jobs/nope/events`)).status).toBe(400);
    });
  });
});
