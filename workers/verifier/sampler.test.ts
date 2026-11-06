import { describe, expect, it } from "vitest";
import { deriveSampleSeed, selectSampleIndices } from "./sampler";

const JOB_ID = `0x${"00".repeat(32)}`;
const ROOT = `0x${"11".repeat(32)}`;
const BEACON = `0x${"22".repeat(32)}`;

describe("verifier sample selection", () => {
  it("derives a stable seed from the job, root, and post-claim block hash", () => {
    expect(deriveSampleSeed(JOB_ID, ROOT, BEACON)).toBe(
      "0x8802140bd3340978d5078acecaf17e709d01c5cce827bc3addd0ab897c041e61",
    );
  });

  it("selects a deterministic, sorted sample with the requested size", () => {
    const seed = deriveSampleSeed(JOB_ID, ROOT, BEACON);
    const sample = selectSampleIndices(seed, 64);
    expect(sample).toHaveLength(16);
    expect(sample).toEqual([...sample].sort((a, b) => a - b));
    expect(new Set(sample).size).toBe(16);
    expect(selectSampleIndices(seed, 64)).toEqual(sample);
  });

  it("selects every tile at rate 1 and at least one tile for a positive tiny rate", () => {
    const seed = deriveSampleSeed(JOB_ID, ROOT, BEACON);
    expect(selectSampleIndices(seed, 8, 1)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(selectSampleIndices(seed, 8, 0.01)).toHaveLength(1);
  });

  it("rejects malformed seeds, non-power-of-two counts, and invalid rates", () => {
    expect(() => selectSampleIndices("0x00", 64)).toThrow(/sampleSeed/);
    expect(() =>
      selectSampleIndices(deriveSampleSeed(JOB_ID, ROOT, BEACON), 3),
    ).toThrow(/power of two/);
    expect(() =>
      selectSampleIndices(deriveSampleSeed(JOB_ID, ROOT, BEACON), 8, 0),
    ).toThrow(/sampleRate/);
  });
});
