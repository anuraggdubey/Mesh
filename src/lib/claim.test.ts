import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { computeTilesDigest, imageDigestToBytes32, parseRegisterNonce, registerMessage, tileClaimTypedData } from "./claim";
import { getDb, transaction } from "./db";
import { buildJob, getJob, insertJob, transitionJob } from "./jobs";
import { TEST_REQUESTER, useTempEnv } from "./testing";

const h = (s: string) => createHash("sha256").update(s).digest("hex");

describe("claim helpers", () => {
  it("tilesDigest is order-independent, covers index and hash, and is sha256 of index||hash", () => {
    const a = { index: 3, tileHash: h("a") };
    const b = { index: 1, tileHash: h("b") };
    expect(computeTilesDigest([a, b])).toBe(computeTilesDigest([b, a]));
    expect(computeTilesDigest([a, b])).not.toBe(computeTilesDigest([a, { ...b, index: 2 }]));
    expect(computeTilesDigest([a, b])).not.toBe(computeTilesDigest([a, { ...b, tileHash: h("c") }]));

    const manual = createHash("sha256")
      .update(Buffer.from([0, 1]))
      .update(Buffer.from(h("b"), "hex"))
      .update(Buffer.from([0, 3]))
      .update(Buffer.from(h("a"), "hex"))
      .digest("hex");
    expect(computeTilesDigest([a, b])).toBe(`0x${manual}`);
    expect(computeTilesDigest([{ index: 1, tileHash: `0x${h("b")}` }])).toBe(computeTilesDigest([{ index: 1, tileHash: h("b") }]));
  });

  it("rejects malformed tile hashes and indexes", () => {
    expect(() => computeTilesDigest([{ index: 0, tileHash: "abc" }])).toThrow();
    expect(() => computeTilesDigest([{ index: -1, tileHash: h("a") }])).toThrow();
    expect(() => computeTilesDigest([{ index: 70000, tileHash: h("a") }])).toThrow();
  });

  it("converts image digests to bytes32 and rejects bad ones", () => {
    expect(imageDigestToBytes32(`sha256:${"AB".repeat(32)}`)).toBe(`0x${"ab".repeat(32)}`);
    expect(() => imageDigestToBytes32("sha256:short")).toThrow();
    expect(() => imageDigestToBytes32("md5:" + "a".repeat(32))).toThrow();
  });

  it("builds the EIP-712 payload from docs/job-spec.md section 7.2", () => {
    const td = tileClaimTypedData(
      {
        jobId: `0x${"11".repeat(32)}`,
        imageDigest: `0x${"22".repeat(32)}`,
        inputHash: `0x${"33".repeat(32)}`,
        provider: "0x6834228cb6F180C05fA2154a2B2670d92c4FDf59",
        tilesDigest: `0x${"44".repeat(32)}`,
      },
      296,
      "0x0118652ea87a8616Cb51979F5F121FC598bf3e7E",
    );
    expect(td.domain).toEqual({ name: "Mesh", version: "1", chainId: 296, verifyingContract: "0x0118652ea87a8616Cb51979F5F121FC598bf3e7E" });
    expect(td.primaryType).toBe("TileClaim");
    expect(td.types.TileClaim.map((f) => `${f.type} ${f.name}`)).toEqual([
      "bytes32 jobId",
      "bytes32 imageDigest",
      "bytes32 inputHash",
      "address provider",
      "bytes32 tilesDigest",
    ]);
  });

  it("parses register nonces", () => {
    expect(parseRegisterNonce("1793904743000-abcdefgh1234")).toBe(1793904743000);
    expect(parseRegisterNonce("abc")).toBeNull();
    expect(parseRegisterNonce("1793904743000-short")).toBeNull();
    expect(registerMessage("n")).toBe("mesh-register:n");
  });
});

describe("re-entrant transactions", () => {
  let cleanup: () => void;
  beforeEach(() => {
    cleanup = useTempEnv();
  });
  afterEach(() => cleanup());

  it("a failure in a nested call rolls back the whole outer transaction", () => {
    const job = insertJob(buildJob({ type: "render", preset: "tiny", requester: TEST_REQUESTER }));
    expect(() =>
      transaction(() => {
        transitionJob(job.jobId, "paid"); // nested transaction joins the outer one
        transitionJob(job.jobId, "final"); // invalid -> throws
      }),
    ).toThrow();
    expect(getJob(job.jobId)?.status).toBe("created"); // the first transition was rolled back too
    const events = getDb().prepare("SELECT COUNT(*) AS n FROM job_events WHERE job_id = ?").get(job.jobId) as { n: number };
    expect(events.n).toBe(1); // only the original `created` event
  });

  it("commits normally when nothing throws, and works again afterwards", () => {
    const job = insertJob(buildJob({ type: "render", preset: "tiny", requester: TEST_REQUESTER }));
    transaction(() => {
      transitionJob(job.jobId, "paid");
    });
    expect(getJob(job.jobId)?.status).toBe("paid");
    expect(() => transaction(() => transitionJob(job.jobId, "nope" as never))).toThrow();
    transitionJob(job.jobId, "assigned"); // the transaction depth counter was reset after the failure
    expect(getJob(job.jobId)?.status).toBe("assigned");
  });
});
