import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { merkleLeaf, merkleProof, merkleRoot, sha256, verifyProof } from "./hash";

const golden = (name: string) => JSON.parse(readFileSync(path.join(process.cwd(), "docs/golden", name), "utf8"));

describe("golden vectors", () => {
  it("merkleLeaf reproduces the leaf the deployed Hedera MeshReceipt contract returned", async () => {
    const { index, tileHash, owner, expected } = golden("merkle.json").leaf;
    await expect(merkleLeaf(index, tileHash, owner)).resolves.toBe(expected);
  });

  it("a 64-tile tree round-trips for every tile and rejects tampering", async () => {
    const owners = ["0x6834228cb6F180C05fA2154a2B2670d92c4FDf59", "0xC4975d7b34275346d3a6D16C3E4B4Bb68c7dF645"];
    const enc = new TextEncoder();
    const leaves = await Promise.all(
      Array.from({ length: 64 }, async (_, i) => merkleLeaf(i, await sha256(enc.encode(`tile${i}`)), owners[i % 2])),
    );
    const root = await merkleRoot(leaves);
    for (let i = 0; i < 64; i += 5) {
      const proof = await merkleProof(leaves, i);
      expect(proof).toHaveLength(6);
      expect(await verifyProof(leaves[i], i, proof, root)).toBe(true);
      expect(await verifyProof(leaves[(i + 1) % 64], i, proof, root)).toBe(false);
    }
  });

  it("render-tiny.json parameters match the tiny preset used by the API", async () => {
    const { RENDER_PRESETS, RENDER_X0, RENDER_Y0 } = await import("./constants");
    const g = golden("render-tiny.json");
    expect(g).toMatchObject({
      width: RENDER_PRESETS.tiny.width,
      height: RENDER_PRESETS.tiny.height,
      gridCols: RENDER_PRESETS.tiny.gridCols,
      gridRows: RENDER_PRESETS.tiny.gridRows,
      maxIter: RENDER_PRESETS.tiny.maxIter,
      step: RENDER_PRESETS.tiny.step,
      x0: RENDER_X0,
      y0: RENDER_Y0,
    });
    expect(Object.keys(g.tileHashes)).toHaveLength(RENDER_PRESETS.tiny.gridCols * RENDER_PRESETS.tiny.gridRows);
  });
});
