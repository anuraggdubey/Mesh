import { describe, expect, it } from "vitest";
import { canonicalRenderInput, renderInputHash, renderRunInput } from "./render-input";

describe("render input canonicalization", () => {
  it("uses the spec key order without whitespace and without tiles", () => {
    expect(canonicalRenderInput("tiny")).toBe(
      '{"spec":"render-v1","width":64,"height":64,"gridCols":2,"gridRows":2,"x0":"-8589934592","y0":"-6442450944","step":"201326592","maxIter":500}',
    );
  });

  it("matches the presets in docs/job-spec.md (small/full are 2048x2048)", () => {
    expect(JSON.parse(canonicalRenderInput("small"))).toMatchObject({ width: 2048, maxIter: 6000, step: "6291456" });
    expect(JSON.parse(canonicalRenderInput("full"))).toMatchObject({ width: 2048, maxIter: 48000, step: "6291456" });
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
