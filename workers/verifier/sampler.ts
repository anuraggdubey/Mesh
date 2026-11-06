import { createHash } from "node:crypto";

const BYTES32 = /^0x[0-9a-fA-F]{64}$/;

function parseBytes32(value: string, name: string): Buffer {
  if (!BYTES32.test(value))
    throw new TypeError(`${name} must be 0x + 32 bytes of hex`);
  return Buffer.from(value.slice(2), "hex");
}

function sha256(...parts: Uint8Array[]): Buffer {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part);
  return hash.digest();
}

/** Derive the post-claim sampling seed from the mined claim block, as specified in docs/job-spec.md §7.3. */
export function deriveSampleSeed(
  jobId: string,
  merkleRoot: string,
  beacon: string,
): `0x${string}` {
  return `0x${sha256(
    Buffer.from("mesh-sample-v1", "ascii"),
    parseBytes32(jobId, "jobId"),
    parseBytes32(merkleRoot, "merkleRoot"),
    parseBytes32(beacon, "beacon"),
  ).toString("hex")}`;
}

/** Fisher–Yates selection using the SHA-256 counter stream from docs/job-spec.md §7.3. */
export function selectSampleIndices(
  sampleSeed: string,
  tileCount: number,
  sampleRate = 0.25,
): number[] {
  const seed = parseBytes32(sampleSeed, "sampleSeed");
  if (
    !Number.isInteger(tileCount) ||
    tileCount < 1 ||
    tileCount > 4096 ||
    (tileCount & (tileCount - 1)) !== 0
  ) {
    throw new RangeError("tileCount must be a power of two between 1 and 4096");
  }
  if (!Number.isFinite(sampleRate) || sampleRate <= 0 || sampleRate > 1) {
    throw new RangeError("sampleRate must be greater than 0 and at most 1");
  }

  const count = Math.max(1, Math.ceil(tileCount * sampleRate));
  const indices = Array.from({ length: tileCount }, (_, index) => index);
  let counter = 0;
  for (let index = tileCount - 1; index > 0; index -= 1) {
    const counterBytes = Buffer.alloc(4);
    counterBytes.writeUInt32BE(counter);
    counter += 1;
    const randomIndex =
      sha256(seed, counterBytes).readUInt32BE(0) % (index + 1);
    [indices[index], indices[randomIndex]] = [
      indices[randomIndex],
      indices[index],
    ];
  }
  return indices.slice(tileCount - count).sort((a, b) => a - b);
}
