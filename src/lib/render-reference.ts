/**
 * Reference implementation of the render algorithm in docs/job-spec.md section 4.3 (BigInt fixed-point, Q31.32).
 * It is SLOW (BigInt) and exists to (1) cross-check the Go/Docker job image against docs/golden/render-tiny.json,
 * and (2) let the mock provider produce real Mandelbrot tiles for the `tiny` preset. Do not use it for real jobs.
 */

export interface RenderInput {
  width: number;
  height: number;
  gridCols: number;
  gridRows: number;
  x0: string; // Q31.32 decimal string
  y0: string;
  step: string;
  maxIter: number;
}

const FOUR = 4n << 32n;

/** Arithmetic (floor) shift of the full-precision product, as the spec requires. */
const mul = (a: bigint, b: bigint): bigint => (a * b) >> 32n;

/** One tile as raw bytes: uint16 little-endian iteration counts, row-major. */
export function renderTile(input: RenderInput, tile: number): Uint8Array {
  const { width, height, gridCols, gridRows, maxIter } = input;
  if (maxIter < 0 || maxIter > 65535) throw new RangeError("maxIter must be 0..65535");
  const tileW = width / gridCols;
  const tileH = height / gridRows;
  const row = Math.floor(tile / gridCols);
  const col = tile % gridCols;
  const x0 = BigInt(input.x0);
  const y0 = BigInt(input.y0);
  const step = BigInt(input.step);

  const out = new Uint8Array(tileW * tileH * 2);
  let o = 0;
  for (let j = 0; j < tileH; j += 1) {
    for (let i = 0; i < tileW; i += 1) {
      const px = col * tileW + i;
      const py = row * tileH + j;
      const cx = x0 + BigInt(px) * step;
      const cy = y0 + BigInt(py) * step;
      let zr = 0n;
      let zi = 0n;
      let n = 0;
      while (n < maxIter) {
        const zr2 = mul(zr, zr);
        const zi2 = mul(zi, zi);
        if (zr2 + zi2 > FOUR) break;
        const t2 = zr * zi; // full product, NOT pre-shifted
        zi = (t2 >> 31n) + cy;
        zr = zr2 - zi2 + cx;
        n += 1;
      }
      out[o] = n & 0xff;
      out[o + 1] = (n >> 8) & 0xff;
      o += 2;
    }
  }
  return out;
}
