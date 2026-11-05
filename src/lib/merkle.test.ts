import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { buildTree, computeRoot, leafHash, merkleProof, merkleRoot, treeDepth, verifyTile } from "./merkle";
import { canonicalRenderInput, renderInputHash, renderRunInput, sha256Hex } from "./hash";

const P1 = "0x6834228cb6F180C05fA2154a2B2670d92c4FDf59";
const P2 = "0xC4975d7b34275346d3a6D16C3E4B4Bb68c7dF645";

function tiles(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    index: i,
    tileHash: `0x${sha256Hex(`tile${i}`)}`,
    owner: i % 2 === 0 ? P1 : P2,
  }));
}

describe("sha256Hex", () => {
  it("matches known vectors", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("golden vector verified on Hedera testnet", () => {
  it("leafHash reproduces the on-chain MeshReceipt.computeLeaf result", () => {
    const golden = JSON.parse(readFileSync(path.join(process.cwd(), "docs/golden/merkle.json"), "utf8"));
    const { index, tileHash, owner, expected } = golden.leaf;
    expect(leafHash(index, tileHash, owner)).toBe(expected);
  });
});

describe("merkle tree", () => {
  it("depth requires a power of two", () => {
    expect(treeDepth(64)).toBe(6);
    expect(treeDepth(1)).toBe(0);
    expect(() => treeDepth(6)).toThrow();
    expect(() => treeDepth(0)).toThrow();
  });

  it("every leaf of a 64-tile tree verifies, and wrong data fails", () => {
    const t = tiles(64);
    const levels = buildTree(t);
    const root = merkleRoot(t);
    expect(levels).toHaveLength(7);
    for (const leaf of t) {
      const proof = merkleProof(levels, leaf.index);
      expect(proof).toHaveLength(6);
      expect(verifyTile(root, leaf.index, leaf.tileHash, leaf.owner, proof)).toBe(true);
      // wrong tile hash, wrong owner, wrong index all fail
      expect(verifyTile(root, leaf.index, `0x${sha256Hex("other")}`, leaf.owner, proof)).toBe(false);
      expect(verifyTile(root, leaf.index, leaf.tileHash, leaf.owner === P1 ? P2 : P1, proof)).toBe(false);
      expect(verifyTile(root, (leaf.index + 1) % 64, leaf.tileHash, leaf.owner, proof)).toBe(false);
    }
  });

  it("a corrupted sibling breaks the proof", () => {
    const t = tiles(8);
    const levels = buildTree(t);
    const proof = merkleProof(levels, 3);
    proof[0] = `0x${sha256Hex("evil")}`;
    expect(verifyTile(merkleRoot(t), 3, t[3].tileHash, t[3].owner, proof)).toBe(false);
  });

  it("a single-leaf tree has the leaf as root and an empty proof", () => {
    const t = tiles(1);
    const levels = buildTree(t);
    expect(merkleRoot(t)).toBe(leafHash(0, t[0].tileHash, t[0].owner));
    expect(merkleProof(levels, 0)).toEqual([]);
  });

  it("changing one tile changes the root", () => {
    const a = tiles(8);
    const b = tiles(8);
    b[5] = { ...b[5], tileHash: `0x${sha256Hex("tampered")}` };
    expect(merkleRoot(a)).not.toBe(merkleRoot(b));
  });

  it("rejects mis-ordered tiles", () => {
    const t = tiles(4);
    expect(() => buildTree([t[1], t[0], t[2], t[3]])).toThrow();
  });

  it("computeRoot is consistent with verifyTile", () => {
    const t = tiles(16);
    const levels = buildTree(t);
    const leaf = leafHash(9, t[9].tileHash, t[9].owner);
    expect(computeRoot(leaf, 9, merkleProof(levels, 9))).toBe(merkleRoot(t));
  });
});

describe("render input canonicalization", () => {
  it("uses the spec key order without whitespace and without tiles", () => {
    expect(canonicalRenderInput("tiny")).toBe(
      '{"spec":"render-v1","width":64,"height":64,"gridCols":2,"gridRows":2,"x0":"-8589934592","y0":"-6442450944","step":"201326592","maxIter":500}',
    );
  });

  it("run input appends tiles and keeps the base keys first", () => {
    const run = renderRunInput("tiny", [0, 2]);
    expect(run.startsWith(canonicalRenderInput("tiny").slice(0, -1))).toBe(true);
    expect(JSON.parse(run).tiles).toEqual([0, 2]);
  });

  it("inputHash is stable and differs per preset", () => {
    expect(renderInputHash("tiny")).toBe(renderInputHash("tiny"));
    expect(renderInputHash("tiny")).not.toBe(renderInputHash("small"));
    expect(renderInputHash("small")).toMatch(/^[0-9a-f]{64}$/);
  });
});
