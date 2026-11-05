import { createHash } from "node:crypto";
import { RENDER_PRESETS, RENDER_X0, RENDER_Y0 } from "./constants";
import type { RenderPreset } from "./constants";

/** SHA-256 of a UTF-8 string, lowercase hex, no 0x prefix (sync, server-side). */
function sha256Utf8(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * Canonical job-level render input (docs/job-spec.md section 4.1): fixed key order, no whitespace,
 * and WITHOUT the per-run `tiles` field. Its SHA-256 is the job's `inputHash`.
 */
export function canonicalRenderInput(preset: RenderPreset): string {
  const p = RENDER_PRESETS[preset];
  return JSON.stringify({
    spec: "render-v1",
    width: p.width,
    height: p.height,
    gridCols: p.gridCols,
    gridRows: p.gridRows,
    x0: RENDER_X0,
    y0: RENDER_Y0,
    step: p.step,
    maxIter: p.maxIter,
  });
}

export function renderInputHash(preset: RenderPreset): string {
  return sha256Utf8(canonicalRenderInput(preset));
}

/**
 * The per-run file handed to a container: the canonical input with `tiles` appended.
 * (Key order is preserved so providers and the verifier produce byte-identical files.)
 */
export function renderRunInput(preset: RenderPreset, tiles: number[]): string {
  const base = JSON.parse(canonicalRenderInput(preset)) as Record<string, unknown>;
  return JSON.stringify({ ...base, tiles });
}
