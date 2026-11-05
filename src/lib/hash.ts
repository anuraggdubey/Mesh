const HASH_BYTES = 32;
const ADDRESS_BYTES = 20;
const MAX_TREE_DEPTH = 16;
const MAX_TILE_COUNT = 2 ** MAX_TREE_DEPTH;

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function fromHex(value: string, byteLength: number, label: string): Uint8Array {
  const hex = value.startsWith("0x") ? value.slice(2) : value;

  if (hex.length !== byteLength * 2 || !/^[0-9a-f]+$/i.test(hex)) {
    throw new TypeError(`${label} must be ${byteLength} bytes of hexadecimal`);
  }

  const bytes = new Uint8Array(byteLength);
  for (let i = 0; i < byteLength; i += 1) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function withPrefix(hash: string): `0x${string}` {
  return `0x${hash}`;
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;

  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }

  return result;
}

async function sha256Bytes(data: Uint8Array): Promise<Uint8Array> {
  // Copy to an ArrayBuffer so this works with both browser and Node Web Crypto types.
  const input = new Uint8Array(data.byteLength);
  input.set(data);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", input.buffer);
  return new Uint8Array(digest);
}

/** SHA-256 over raw bytes, returned as 64 lowercase hex characters without 0x. */
export async function sha256(data: Uint8Array): Promise<string> {
  if (!(data instanceof Uint8Array)) {
    throw new TypeError("sha256 expects raw bytes as a Uint8Array");
  }
  return toHex(await sha256Bytes(data));
}

/** Build the job-spec leaf: SHA-256(0x00 || uint16_be(index) || tileHash || owner). */
export async function merkleLeaf(
  index: number,
  tileHash: string,
  owner: string,
): Promise<`0x${string}`> {
  if (!Number.isInteger(index) || index < 0 || index >= MAX_TILE_COUNT) {
    throw new RangeError(`tile index must be an integer from 0 to ${MAX_TILE_COUNT - 1}`);
  }

  const indexBytes = new Uint8Array([index >>> 8, index & 0xff]);
  const domain = new Uint8Array([0x00]);
  const ownerBytes = fromHex(owner, ADDRESS_BYTES, "owner address");
  const tileHashBytes = fromHex(tileHash, HASH_BYTES, "tile hash");
  return withPrefix(toHex(await sha256Bytes(concatBytes(domain, indexBytes, tileHashBytes, ownerBytes))));
}

async function hashNode(left: Uint8Array, right: Uint8Array): Promise<Uint8Array> {
  return sha256Bytes(concatBytes(new Uint8Array([0x01]), left, right));
}

function validateLeaves(leaves: readonly string[]): Uint8Array[] {
  if (
    leaves.length === 0 ||
    leaves.length > MAX_TILE_COUNT ||
    (leaves.length & (leaves.length - 1)) !== 0
  ) {
    throw new RangeError(`Merkle leaves must be a power of two between 1 and ${MAX_TILE_COUNT}`);
  }

  return leaves.map((leaf, index) => fromHex(leaf, HASH_BYTES, `leaf ${index}`));
}

/** Build the perfect, domain-separated Merkle root. The result is bytes32 hex with 0x. */
export async function merkleRoot(leaves: readonly string[]): Promise<`0x${string}`> {
  let level = validateLeaves(leaves);

  while (level.length > 1) {
    const next: Uint8Array[] = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(await hashNode(level[i], level[i + 1]));
    }
    level = next;
  }

  return withPrefix(toHex(level[0]));
}

/** Return sibling hashes from the leaf level upward, each as bytes32 hex with 0x. */
export async function merkleProof(
  leaves: readonly string[],
  index: number,
): Promise<`0x${string}`[]> {
  let level = validateLeaves(leaves);
  if (!Number.isInteger(index) || index < 0 || index >= level.length) {
    throw new RangeError("Merkle proof index is outside the leaves");
  }

  const proof: `0x${string}`[] = [];
  let position = index;

  while (level.length > 1) {
    proof.push(withPrefix(toHex(level[position ^ 1])));

    const next: Uint8Array[] = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(await hashNode(level[i], level[i + 1]));
    }
    level = next;
    position = Math.floor(position / 2);
  }

  return proof;
}

/** Verify a leaf proof using the index bits to order sibling nodes. */
export async function verifyProof(
  leaf: string,
  index: number,
  proof: readonly string[],
  root: string,
): Promise<boolean> {
  if (proof.length > MAX_TREE_DEPTH) {
    throw new RangeError(`Merkle proof depth cannot exceed ${MAX_TREE_DEPTH}`);
  }
  if (!Number.isInteger(index) || index < 0 || index >= 2 ** proof.length) {
    throw new RangeError("Merkle proof index is outside the proof depth");
  }

  let current = fromHex(leaf, HASH_BYTES, "leaf");
  const expectedRoot = fromHex(root, HASH_BYTES, "Merkle root");

  for (let level = 0; level < proof.length; level += 1) {
    const sibling = fromHex(proof[level], HASH_BYTES, `proof item ${level}`);
    current = (index & (1 << level)) === 0
      ? await hashNode(current, sibling)
      : await hashNode(sibling, current);
  }

  return toHex(current) === toHex(expectedRoot);
}
