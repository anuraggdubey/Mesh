import { deflateSync } from "node:zlib";
import { colorizeTile } from "./ui/colorize";

/** Minimal PNG (8-bit RGB) encoder, no dependencies. */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  Buffer.from(data).copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

export function encodePng(width: number, height: number, rgb: Uint8Array): Buffer {
  if (rgb.length !== width * height * 3) throw new Error("pixel buffer does not match the image size");
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 3 + 1)] = 0; // filter: none
    Buffer.from(rgb.buffer, rgb.byteOffset + y * width * 3, width * 3).copy(raw, y * (width * 3 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: RGB
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array(0))]);
}

export interface TileGrid {
  width: number;
  height: number;
  gridCols: number;
  gridRows: number;
  maxIter: number;
}

/**
 * Assemble tiles (uint16 little-endian iteration counts, docs/job-spec.md 4.4) into a colourised PNG, box-averaged down so the
 * longest side is at most `maxSide`. `tiles[i]` is tile i (row-major). Throws if a tile is missing or the wrong size.
 */
export function renderTilesToPng(grid: TileGrid, tiles: (Uint8Array | null)[], maxSide = 256): Buffer {
  const { width, height, gridCols, gridRows, maxIter } = grid;
  const tw = width / gridCols;
  const th = height / gridRows;
  const f = Math.max(1, Math.floor(Math.max(width, height) / maxSide));
  const ow = Math.floor(width / f);
  const oh = Math.floor(height / f);
  const sum = new Uint32Array(ow * oh * 3);
  const count = new Uint32Array(ow * oh);

  for (let i = 0; i < gridCols * gridRows; i += 1) {
    const bytes = tiles[i];
    if (!bytes || bytes.length !== tw * th * 2) throw new Error(`tile ${i} is missing or the wrong size`);
    const rgba = colorizeTile(bytes, maxIter);
    const ox = (i % gridCols) * tw;
    const oy = Math.floor(i / gridCols) * th;
    for (let y = 0; y < th; y += 1) {
      const dy = Math.floor((oy + y) / f);
      if (dy >= oh) continue;
      for (let x = 0; x < tw; x += 1) {
        const dx = Math.floor((ox + x) / f);
        if (dx >= ow) continue;
        const p = (y * tw + x) * 4;
        const q = dy * ow + dx;
        sum[q * 3] += rgba[p];
        sum[q * 3 + 1] += rgba[p + 1];
        sum[q * 3 + 2] += rgba[p + 2];
        count[q] += 1;
      }
    }
  }
  const rgb = new Uint8Array(ow * oh * 3);
  for (let q = 0; q < ow * oh; q += 1) {
    const n = count[q] || 1;
    rgb[q * 3] = Math.round(sum[q * 3] / n);
    rgb[q * 3 + 1] = Math.round(sum[q * 3 + 1] / n);
    rgb[q * 3 + 2] = Math.round(sum[q * 3 + 2] / n);
  }
  return encodePng(ow, oh, rgb);
}
