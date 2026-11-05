import { createHash } from "node:crypto";
import { verifyTypedData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import {
  classifyFailure,
  computeTilesDigest,
  createRegistrationNonce,
  signProviderClaim,
} from "./worker";

describe("provider claim helpers", () => {
  it("hashes tile indexes and hashes in ascending index order", () => {
    const tiles = [
      { index: 2, tileHash: "22".repeat(32) },
      { index: 1, tileHash: "11".repeat(32) },
    ];
    const preimage = Buffer.concat([
      Buffer.from("0001", "hex"),
      Buffer.from("11".repeat(32), "hex"),
      Buffer.from("0002", "hex"),
      Buffer.from("22".repeat(32), "hex"),
    ]);
    const expected = `0x${createHash("sha256").update(preimage).digest("hex")}`;

    expect(computeTilesDigest(tiles)).toBe(expected);
    expect(computeTilesDigest([...tiles].reverse())).toBe(expected);
  });

  it("rejects empty claims and malformed tile hashes", () => {
    expect(() => computeTilesDigest([])).toThrow("without tiles");
    expect(() =>
      computeTilesDigest([{ index: 0, tileHash: "not-a-hash" }]),
    ).toThrow("Invalid tile hash");
  });

  it("creates a fresh registration nonce accepted by the provider protocol", () => {
    expect(createRegistrationNonce(1_800_000_000_000, "ab12cd34ef56ab78")).toBe(
      "1800000000000-ab12cd34ef56ab78",
    );
  });

  it("maps worker errors to the agreed failure enum", () => {
    expect(classifyFailure(new Error("Task timed out after 10s"))).toBe(
      "timeout",
    );
    expect(classifyFailure(new Error("Input hash mismatch"))).toBe(
      "hash_mismatch",
    );
    expect(classifyFailure(new Error("Process cancelled"), true)).toBe(
      "killed",
    );
    expect(classifyFailure(new Error("Docker daemon unavailable"))).toBe(
      "crash",
    );
  });

  it("signs the documented EIP-712 TileClaim", async () => {
    const account = privateKeyToAccount(`0x${"01".repeat(32)}`);
    const receiptAddress =
      "0x0118652ea87a8616Cb51979F5F121FC598bf3e7E" as const;
    const task = {
      taskId: "task",
      jobId: `0x${"12".repeat(32)}` as const,
      type: "render",
      imageRef: "ghcr.io/mesh/render",
      imageDigest: `sha256:${"ab".repeat(32)}`,
      inputHash: "34".repeat(32),
      tiles: [0],
      timeoutSeconds: 120,
    };
    const tiles = [
      { index: 0, tileHash: "56".repeat(32), bytes: Buffer.from("tile") },
    ];
    const { tilesDigest, signature } = await signProviderClaim(
      task,
      account,
      tiles,
      receiptAddress,
      296,
    );
    const valid = await verifyTypedData({
      address: account.address,
      domain: {
        name: "Mesh",
        version: "1",
        chainId: 296,
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
        jobId: task.jobId,
        imageDigest: `0x${"ab".repeat(32)}`,
        inputHash: `0x${task.inputHash}`,
        provider: account.address,
        tilesDigest,
      },
      signature,
    });
    expect(valid).toBe(true);
  });
});
