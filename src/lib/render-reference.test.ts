import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { renderTile } from "./render-reference";
import type { RenderInput } from "./render-reference";
import { RENDER_PRESETS, RENDER_X0, RENDER_Y0 } from "./constants";

const golden = JSON.parse(readFileSync(path.join(process.cwd(), "docs/golden/render-tiny.json"), "utf8"));
const tiny: RenderInput = { ...RENDER_PRESETS.tiny, x0: RENDER_X0, y0: RENDER_Y0 };
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

describe("TypeScript reference renderer vs the Go/Docker image's golden hashes", () => {
  it("reproduces every tile hash of the tiny preset byte for byte", { timeout: 60_000 }, () => {
    for (const [tile, expected] of Object.entries(golden.tileHashes as Record<string, string>)) {
      const bytes = renderTile(tiny, Number(tile));
      expect(bytes.length).toBe(golden.tileBytes);
      expect(sha(bytes), `tile ${tile}`).toBe(expected);
    }
  });

  it("is deterministic and tile-independent", () => {
    const a = renderTile({ ...tiny, maxIter: 40 }, 1);
    const b = renderTile({ ...tiny, maxIter: 40 }, 1);
    expect(sha(a)).toBe(sha(b));
    expect(sha(renderTile({ ...tiny, maxIter: 40 }, 2))).not.toBe(sha(a));
  });

  it("rejects an out-of-range iteration limit", () => {
    expect(() => renderTile({ ...tiny, maxIter: 70000 }, 0)).toThrow(RangeError);
  });
});
