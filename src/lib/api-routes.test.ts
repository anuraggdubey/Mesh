import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `connection()` only works inside a real Next.js request; the live-server check covers the real behavior.
vi.mock("next/server", () => ({ connection: async () => {} }));

import { GET as healthGet } from "@/app/api/health/route";
import { GET as listGet, POST as createPost } from "@/app/api/jobs/route";
import { GET as jobGet } from "@/app/api/jobs/[id]/route";
import { getJob } from "./jobs";
import { TEST_ESCROW, TEST_REQUESTER, TEST_TOKEN, setupTestEnv } from "./testing";

const post = (body: unknown, headers: Record<string, string> = {}) =>
  createPost(
    new Request("http://localhost/api/jobs", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
const getById = (id: string) =>
  jobGet(new Request(`http://localhost/api/jobs/${id}`), { params: Promise.resolve({ id }) });

describe("API routes", () => {
  let cleanup: () => void;
  beforeEach(() => {
    cleanup = setupTestEnv();
  });
  afterEach(() => cleanup());

  it("GET /api/health", async () => {
    const res = await healthGet();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, version: "0.1.0", chainId: 296 });
  });

  describe("POST /api/jobs without payment", () => {
    it("answers 402 with x402 instructions bound to the new job", async () => {
      const res = await post({ type: "render", preset: "small", requester: TEST_REQUESTER });
      expect(res.status).toBe(402);
      const body = await res.json();
      expect(body.x402Version).toBe(1);
      const accept = body.accepts[0];
      expect(accept).toMatchObject({
        scheme: "exact",
        network: "hedera-testnet",
        maxAmountRequired: "500000",
        payTo: TEST_ESCROW,
        asset: TEST_TOKEN,
        resource: "http://localhost:3000/api/jobs",
      });
      expect(accept.extra.jobId).toMatch(/^0x[0-9a-f]{64}$/);
      expect(accept.extra.nonce).toBe(accept.extra.jobId);
      // the job exists and is waiting for payment
      const job = getJob(accept.extra.jobId);
      expect(job?.status).toBe("created");
      expect(job?.requester).toBe(TEST_REQUESTER);
    });

    it("uses defaults (render, small) when only the requester is given", async () => {
      const res = await post({ requester: TEST_REQUESTER });
      expect(res.status).toBe(402);
      expect((await res.json()).accepts[0].maxAmountRequired).toBe("500000");
    });

    it("prices by preset", async () => {
      const res = await post({ preset: "full", requester: TEST_REQUESTER });
      expect((await res.json()).accepts[0].maxAmountRequired).toBe("1000000");
    });

    it("answers 501 when an X-PAYMENT header arrives (verification not built yet)", async () => {
      const res = await post({ requester: TEST_REQUESTER }, { "x-payment": "abc" });
      expect(res.status).toBe(501);
      expect((await res.json()).error).toBe("x402_not_implemented");
    });

    it("answers 503 if the escrow address is not configured", async () => {
      cleanup();
      cleanup = setupTestEnv({ ESCROW_ADDRESS: "" });
      const res = await post({ requester: TEST_REQUESTER });
      expect(res.status).toBe(503);
      expect((await res.json()).error).toBe("not_configured");
    });
  });

  describe("validation", () => {
    it("400 on an invalid requester address", async () => {
      const res = await post({ requester: "0x123" });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("invalid_body");
      expect(body.issues[0].path).toBe("requester");
    });

    it("400 on a missing requester", async () => {
      expect((await post({ type: "render" })).status).toBe(400);
    });

    it("400 on an unknown preset or type", async () => {
      expect((await post({ preset: "huge", requester: TEST_REQUESTER })).status).toBe(400);
      expect((await post({ type: "bitcoin", requester: TEST_REQUESTER })).status).toBe(400);
    });

    it("400 on malformed JSON", async () => {
      const res = await post("{not json");
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("invalid_json");
    });

    it("413 on an oversized body", async () => {
      const res = await post({ requester: TEST_REQUESTER, worldProof: { pad: "x".repeat(70 * 1024) } });
      expect(res.status).toBe(413);
    });

    it("501 for job types whose workers are not built yet", async () => {
      const res = await post({ type: "matmul", requester: TEST_REQUESTER });
      expect(res.status).toBe(501);
      expect((await res.json()).error).toBe("unsupported_job_type");
    });

    it("does not store a job for a rejected request", async () => {
      await post({ requester: "nope" });
      const list = await (await listGet()).json();
      expect(list.jobs).toHaveLength(0);
    });
  });

  describe("dev payment skip", () => {
    beforeEach(() => {
      cleanup();
      cleanup = setupTestEnv({ MESH_DEV_SKIP_PAYMENT: "true" });
    });

    it("marks the job paid immediately and flags the response", async () => {
      const res = await post({ preset: "tiny", requester: TEST_REQUESTER });
      expect(res.status).toBe(200);
      expect(res.headers.get("X-Mesh-Dev-Payment-Skipped")).toBe("true");
      const job = await res.json();
      expect(job.status).toBe("paid");
      expect(job.tileCount).toBe(4);
    });

    it("still validates the body", async () => {
      expect((await post({ requester: "bad" })).status).toBe(400);
    });
  });

  describe("GET /api/jobs/:id", () => {
    it("returns the stored job", async () => {
      const created = await (await post({ requester: TEST_REQUESTER })).json();
      const id = created.accepts[0].extra.jobId;
      const res = await getById(id);
      expect(res.status).toBe(200);
      const job = await res.json();
      expect(job.jobId).toBe(id);
      expect(job.status).toBe("created");
      expect(job.tiles).toHaveLength(64);
    });

    it("404 for an unknown job", async () => {
      const res = await getById("0x" + "ab".repeat(32));
      expect(res.status).toBe(404);
      expect((await res.json()).error).toBe("job_not_found");
    });

    it("400 for a malformed id (never touches the database)", async () => {
      for (const bad of ["abc", "0x12", "0x" + "AB".repeat(32), "0x" + "zz".repeat(32), "../etc/passwd"]) {
        const res = await getById(bad);
        expect(res.status, bad).toBe(400);
      }
    });
  });

  it("GET /api/jobs lists newest first", async () => {
    await post({ preset: "tiny", requester: TEST_REQUESTER });
    await post({ preset: "small", requester: TEST_REQUESTER });
    const list = await (await listGet()).json();
    expect(list.jobs.map((j: { params: { preset: string } }) => j.params.preset)).toEqual(["small", "tiny"]);
  });
});
