import { describe, expect, it } from "vitest";
import { merkleLeaf, merkleProof, merkleRoot, sha256, verifyProof } from "@/lib/hash";

const encoder = new TextEncoder();
const owner = `0x${"11".repeat(20)}`;

describe("sha256", () => {
  it("matches the standard empty-string and abc vectors", async () => {
    await expect(sha256(encoder.encode(""))).resolves.toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    await expect(sha256(encoder.encode("abc"))).resolves.toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("domain-separated Merkle helpers", () => {
  it("binds a leaf to its tile index and owner", async () => {
    const tileHash = await sha256(encoder.encode("a"));
    await expect(merkleLeaf(0, tileHash, owner)).resolves.toBe(
      "0xe6bd2008195220de34a919811d17b15d754350b51707a30cdb23121d17919801",
    );
    await expect(merkleLeaf(1, tileHash, owner)).resolves.not.toBe(
      await merkleLeaf(0, tileHash, owner),
    );
  });

  it("builds the specified perfect tree and verifies proofs in both branch directions", async () => {
    const leaves = await Promise.all(["a", "b", "c", "d"].map((value) => sha256(encoder.encode(value))));
    const boundLeaves = await Promise.all(leaves.map((tileHash, index) => merkleLeaf(index, tileHash, owner)));
    const expectedRoot = "0x0660c65d3039b3aba3ec6240d1130d83b678df5238893fcf491a63a3714600eb";

    await expect(merkleRoot(boundLeaves)).resolves.toBe(expectedRoot);

    const rightBranchProof = await merkleProof(boundLeaves, 2);
    expect(rightBranchProof).toEqual([
      "0x420c57c92e6131d216d3e59e11a9f12ccc77e64ffef4821ddec9b8a1cbf61d1f",
      "0xc9de5195cd4f7fe7d6a99105ebb84ceb205139103bfc961560cf4079437dee44",
    ]);
    await expect(verifyProof(boundLeaves[2], 2, rightBranchProof, expectedRoot)).resolves.toBe(true);
    await expect(verifyProof(boundLeaves[0], 0, await merkleProof(boundLeaves, 0), expectedRoot)).resolves.toBe(true);
    await expect(verifyProof(boundLeaves[2], 2, rightBranchProof, `0x${"00".repeat(32)}`)).resolves.toBe(false);
  });

  it("rejects non-perfect trees and out-of-range indexes", async () => {
    const leaf = await sha256(encoder.encode("a"));
    await expect(merkleRoot([])).rejects.toThrow(/power of two/);
    await expect(merkleRoot([leaf, leaf, leaf])).rejects.toThrow(/power of two/);
    await expect(merkleProof([leaf, leaf], 2)).rejects.toThrow(/outside the leaves/);
    await expect(merkleLeaf(65_536, leaf, owner)).rejects.toThrow(/tile index/);
    await expect(verifyProof(leaf, 0, Array(17).fill(leaf), leaf)).rejects.toThrow(/depth/);
  });
});
