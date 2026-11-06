import { createHash } from "node:crypto";
import {
  deriveSampleSeed,
  selectSampleIndices,
} from "../workers/verifier/sampler";

const TILE_COUNT = 64;
const RUNS = 1_000;
const JOB_ID = `0x${"00".repeat(32)}`;
const MERKLE_ROOT = `0x${"11".repeat(32)}`;
const SAMPLE_SIZES = [8, 16, 32];
const CORRUPT_TILE_COUNTS = [6, 12, 20];

function expectedDetectionProbability(
  tileCount: number,
  corruptCount: number,
  sampleSize: number,
): number {
  let allClean = 1;
  for (let draw = 0; draw < sampleSize; draw += 1) {
    allClean *= (tileCount - corruptCount - draw) / (tileCount - draw);
  }
  return 1 - allClean;
}

function simulatedBeacon(run: number): `0x${string}` {
  const digest = createHash("sha256")
    .update(`mesh-verifier-detection-v1:${run}`)
    .digest("hex");
  return `0x${digest}`;
}

function runCell(corruptCount: number, sampleSize: number) {
  let detected = 0;
  for (let run = 0; run < RUNS; run += 1) {
    const beacon = simulatedBeacon(run);
    const seed = deriveSampleSeed(JOB_ID, MERKLE_ROOT, beacon);
    const sample = selectSampleIndices(
      seed,
      TILE_COUNT,
      sampleSize / TILE_COUNT,
    );
    if (sample.some((index) => index < corruptCount)) detected += 1;
  }

  const actual = detected / RUNS;
  const expected = expectedDetectionProbability(
    TILE_COUNT,
    corruptCount,
    sampleSize,
  );
  const tolerance = Math.max(
    0.03,
    4 * Math.sqrt((expected * (1 - expected)) / RUNS),
  );
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(
      `Detection rate outside tolerance for c=${corruptCount}, k=${sampleSize}: actual=${actual}, expected=${expected}, tolerance=${tolerance}`,
    );
  }
  return { corruptCount, sampleSize, detected, actual, expected };
}

console.log(`Runs per cell: ${RUNS}; tile count: ${TILE_COUNT}`);
console.log(
  "Corrupt tiles | Sample size | Detected | Observed | Expected (without replacement)",
);
for (const corruptCount of CORRUPT_TILE_COUNTS) {
  for (const sampleSize of SAMPLE_SIZES) {
    const result = runCell(corruptCount, sampleSize);
    console.log(
      `${String(result.corruptCount).padStart(13)} | ${String(result.sampleSize).padStart(11)} | ${String(result.detected).padStart(8)} | ${(result.actual * 100).toFixed(1).padStart(7)}% | ${(result.expected * 100).toFixed(1).padStart(27)}%`,
    );
  }
}
