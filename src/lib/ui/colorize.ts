/**
 * Turn render tile bytes (docs/job-spec.md section 4.4: uint16 little-endian iteration counts, row-major)
 * into RGBA pixels for a canvas. Pure and deterministic so it can be unit-tested.
 */

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0;
  let g = 0;
  let b = 0;
  if (hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = l - c / 2;
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

/** Color for an iteration count: inside the set (n >= maxIter) is black; outside shades by log(n). */
export function iterationColor(n: number, maxIter: number): [number, number, number] {
  if (n >= maxIter) return [0, 0, 0];
  const t = Math.log(n + 1) / Math.log(maxIter + 1); // 0..1
  const shade = Math.sqrt(t);
  return hslToRgb(215 + 170 * shade, 0.85, 0.12 + 0.55 * shade);
}

/** RGBA pixels (4 bytes per pixel) for one tile. */
export function colorizeTile(bytes: Uint8Array, maxIter: number): Uint8ClampedArray {
  const pixels = Math.floor(bytes.length / 2);
  const out = new Uint8ClampedArray(pixels * 4);
  for (let i = 0; i < pixels; i += 1) {
    const n = bytes[2 * i] | (bytes[2 * i + 1] << 8);
    const [r, g, b] = iterationColor(n, maxIter);
    out[4 * i] = r;
    out[4 * i + 1] = g;
    out[4 * i + 2] = b;
    out[4 * i + 3] = 255;
  }
  return out;
}
