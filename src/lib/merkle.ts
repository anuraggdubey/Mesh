import { createHash } from "node:crypto";
import { hexToBytes, with0x } from "./hash";

/**
 * SHA-256 Merkle tree exactly as defined in docs/job-spec.md section 7.1 and implemented by
 * contracts/src/libraries/MerkleSha256.sol:
 *   leaf(i)    = sha256(0x00 || uint16_be(i) || tileHash || owner(20 bytes))
 *   node(l, r) = sha256(0x01 || l || r)
 * Perfect binary tree: the leaf count must be a power of two.
 */

function sha(...parts: Buffer[]): Buffer {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return h.digest();
}

function bytes32(hex: string): Buffer {
  const b = hexToBytes(hex);
  if (b.length !== 32) throw new Error("expected 32 bytes");
  return b;
}

function addressBytes(addr: string): Buffer {
  const b = hexToBytes(addr);
  if (b.length !== 20) throw new Error("expected 20-byte address");
  return b;
}

export function isPowerOfTwo(n: number): boolean {
  return Number.isInteger(n) && n > 0 && (n & (n - 1)) === 0;
}

/** Number of tree levels above the leaves (= proof length). */
export function treeDepth(leafCount: number): number {
  if (!isPowerOfTwo(leafCount)) throw new Error("leaf count must be a power of two");
  return Math.log2(leafCount);
}

export function leafHash(index: number, tileHash: string, owner: string): string {
  if (!Number.isInteger(index) || index < 0 || index > 0xffff) throw new Error("tile index out of range");
  const idx = Buffer.alloc(2);
  idx.writeUInt16BE(index);
  return with0x(sha(Buffer.from([0x00]), idx, bytes32(tileHash), addressBytes(owner)).toString("hex"));
}

export function nodeHash(left: string, right: string): string {
  return with0x(sha(Buffer.from([0x01]), bytes32(left), bytes32(right)).toString("hex"));
}

export interface TileLeaf {
  index: number;
  tileHash: string;
  owner: string;
}

/** Build all levels. levels[0] = leaves, levels[last] = [root]. Leaves must be ordered 0..n-1. */
export function buildTree(tiles: TileLeaf[]): string[][] {
  treeDepth(tiles.length);
  tiles.forEach((t, i) => {
    if (t.index !== i) throw new Error("tiles must be ordered by index 0..n-1");
  });
  const levels: string[][] = [tiles.map((t) => leafHash(t.index, t.tileHash, t.owner))];
  while (levels[levels.length - 1].length > 1) {
    const prev = levels[levels.length - 1];
    const next: string[] = [];
    for (let i = 0; i < prev.length; i += 2) next.push(nodeHash(prev[i], prev[i + 1]));
    levels.push(next);
  }
  return levels;
}

export function merkleRoot(tiles: TileLeaf[]): string {
  const levels = buildTree(tiles);
  return levels[levels.length - 1][0];
}

/** Sibling hashes from the leaf level upward for tile `index`. */
export function merkleProof(levels: string[][], index: number): string[] {
  const depth = levels.length - 1;
  if (index < 0 || index >= levels[0].length) throw new Error("tile index out of range");
  const proof: string[] = [];
  let idx = index;
  for (let l = 0; l < depth; l++) {
    proof.push(levels[l][idx ^ 1]);
    idx >>= 1;
  }
  return proof;
}

export function computeRoot(leaf: string, index: number, proof: string[]): string {
  let h = leaf;
  for (let i = 0; i < proof.length; i++) {
    h = ((index >> i) & 1) === 0 ? nodeHash(h, proof[i]) : nodeHash(proof[i], h);
  }
  return h;
}

export function verifyTile(
  root: string,
  index: number,
  tileHash: string,
  owner: string,
  proof: string[],
): boolean {
  return computeRoot(leafHash(index, tileHash, owner), index, proof).toLowerCase() === root.toLowerCase();
}
