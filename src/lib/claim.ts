import { createHash } from "node:crypto";
import type { Hex } from "viem";

/**
 * Provider claim protocol (docs/job-spec.md section 7.2). Shared by the API and by workers so both sides
 * produce byte-identical digests and EIP-712 messages.
 */

export const CLAIM_DOMAIN_NAME = "Mesh";
export const CLAIM_DOMAIN_VERSION = "1";

export const TILE_CLAIM_TYPES = {
  TileClaim: [
    { name: "jobId", type: "bytes32" },
    { name: "imageDigest", type: "bytes32" },
    { name: "inputHash", type: "bytes32" },
    { name: "provider", type: "address" },
    { name: "tilesDigest", type: "bytes32" },
  ],
} as const;

export interface TileHashEntry {
  index: number;
  tileHash: string; // 64 hex, with or without 0x
}

const strip0x = (h: string) => (h.startsWith("0x") ? h.slice(2) : h);
export const with0x = (h: string): Hex => `0x${strip0x(h)}` as Hex;

/** sha256(concat over tiles ascending by index of: uint16_be(index) || tileHash(32 bytes)) as 0x-hex. */
export function computeTilesDigest(tiles: TileHashEntry[]): Hex {
  const sorted = [...tiles].sort((a, b) => a.index - b.index);
  const h = createHash("sha256");
  for (const t of sorted) {
    if (!Number.isInteger(t.index) || t.index < 0 || t.index > 0xffff) throw new Error("tile index out of range");
    const hash = strip0x(t.tileHash);
    if (!/^[0-9a-fA-F]{64}$/.test(hash)) throw new Error("tile hash must be 32 bytes of hex");
    const idx = Buffer.alloc(2);
    idx.writeUInt16BE(t.index);
    h.update(idx);
    h.update(Buffer.from(hash, "hex"));
  }
  return `0x${h.digest("hex")}`;
}

/** "sha256:<64 hex>" image digest -> bytes32 hex. */
export function imageDigestToBytes32(digest: string): Hex {
  const m = /^sha256:([0-9a-fA-F]{64})$/.exec(digest);
  if (!m) throw new Error("image digest must look like sha256:<64 hex>");
  return `0x${m[1].toLowerCase()}`;
}

export interface TileClaimMessage {
  jobId: Hex;
  imageDigest: Hex;
  inputHash: Hex;
  provider: Hex;
  tilesDigest: Hex;
}

/** Full EIP-712 payload for viem's signTypedData / recoverTypedDataAddress. */
export function tileClaimTypedData(message: TileClaimMessage, chainId: number, verifyingContract: Hex) {
  return {
    domain: { name: CLAIM_DOMAIN_NAME, version: CLAIM_DOMAIN_VERSION, chainId, verifyingContract },
    types: TILE_CLAIM_TYPES,
    primaryType: "TileClaim" as const,
    message,
  };
}

/** Message a provider signs with personal_sign to register. Nonce format: "<unix-ms>-<random>". */
export function registerMessage(nonce: string): string {
  return `mesh-register:${nonce}`;
}

export const REGISTER_NONCE_MAX_AGE_MS = 5 * 60 * 1000;

/** Parse "<unix-ms>-<random>"; returns the timestamp or null. */
export function parseRegisterNonce(nonce: string): number | null {
  const m = /^(\d{10,16})-[0-9a-zA-Z]{8,64}$/.exec(nonce);
  return m ? Number(m[1]) : null;
}
