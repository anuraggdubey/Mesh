import { createHash } from "node:crypto";
import { RENDER_PRESETS, RENDER_X0, RENDER_Y0 } from "./constants";
import type { RenderPreset } from "./constants";

/** SHA-256 of raw bytes (or a UTF-8 string), lowercase hex, no 0x prefix. */
export function sha256Hex(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

export function strip0x(hex: string): string {
  return hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
}

/** Hex (with or without 0x) -> bytes. Throws on odd length or non-hex characters. */
export function hexToBytes(hex: string): Buffer {
  const h = strip0x(hex);
  if (h.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(h)) throw new Error(`invalid hex: ${hex.slice(0, 20)}`);
  return Buffer.from(h, "hex");
}

/** 32-byte hex check helper. */
export function isBytes32(hex: string): boolean {
  return /^(0x)?[0-9a-fA-F]{64}$/.test(hex);
}

export function with0x(hex: string): string {
  return `0x${strip0x(hex)}`;
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
  return sha256Hex(canonicalRenderInput(preset));
}

/**
 * The per-run file handed to a container: the canonical input with `tiles` appended.
 * (Key order is preserved so providers and the verifier produce byte-identical files.)
 */
export function renderRunInput(preset: RenderPreset, tiles: number[]): string {
  const base = JSON.parse(canonicalRenderInput(preset)) as Record<string, unknown>;
  return JSON.stringify({ ...base, tiles });
}
