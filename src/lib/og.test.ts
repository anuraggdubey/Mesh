import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { inflateSync } from "node:zlib";
import { OgError, ogConfigured, reviewImage, scrub } from "./og";
import type { OgDeps } from "./og";
import { encodePng, renderTilesToPng } from "./png";
import { resetEnvCache } from "./env";
import { FAKE_OG_KEY, FAKE_OG_SIGNER, startFakeOg } from "./fake-og";
import type { FakeOg } from "./fake-og";
import { setupTestEnv } from "./testing";

const PNG = encodePng(2, 2, new Uint8Array(12).fill(120));
const deps = (over: Partial<OgDeps> = {}): OgDeps => ({ fetch: (...a) => fetch(...a), sleep: async () => {}, ...over });

describe("png", () => {
  it("encodes a valid PNG (signature, IHDR, IDAT pixels)", () => {
    const rgb = new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255, 9, 9, 9]);
    const png = encodePng(2, 2, rgb);
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(png.readUInt32BE(16)).toBe(2);
    expect(png.readUInt32BE(20)).toBe(2);
    const idatLen = png.readUInt32BE(33);
    const raw = inflateSync(png.subarray(41, 41 + idatLen));
    // each scanline is a filter byte (0) followed by its RGB pixels
    expect([...raw]).toEqual([0, 255, 0, 0, 0, 255, 0, 0, 0, 0, 255, 9, 9, 9]);
    expect(() => encodePng(2, 2, new Uint8Array(5))).toThrow();
  });

  it("assembles tiles into a downscaled image and refuses missing or mis-sized tiles", () => {
    const grid = { width: 64, height: 64, gridCols: 2, gridRows: 2, maxIter: 500 };
    const tile = new Uint8Array(32 * 32 * 2).fill(3);
    const png = renderTilesToPng(grid, [tile, tile, tile, tile]);
    expect(png.readUInt32BE(16)).toBe(64); // under the cap: no downscale
    const big = { width: 1024, height: 1024, gridCols: 2, gridRows: 2, maxIter: 500 };
    const bigTile = new Uint8Array(512 * 512 * 2).fill(3);
    const small = renderTilesToPng(big, [bigTile, bigTile, bigTile, bigTile], 256);
    expect(small.readUInt32BE(16)).toBe(256);
    expect(() => renderTilesToPng(grid, [tile, tile, null, tile])).toThrow(/tile 2/);
    expect(() => renderTilesToPng(grid, [tile, tile, new Uint8Array(10), tile])).toThrow(/wrong size/);
  });
});

describe("0G router client", () => {
  let fake: FakeOg;
  let cleanup: () => void;
  beforeAll(async () => {
    fake = await startFakeOg();
  });
  afterAll(() => fake.stop());
  beforeEach(() => {
    cleanup = setupTestEnv();
    Object.assign(process.env, { OG_API_KEY: FAKE_OG_KEY, OG_API_BASE_URL: fake.url, OG_SIGNATURE_BASE_URL: fake.origin, OG_SIGNER_ADDRESS: FAKE_OG_SIGNER, OG_MODEL: "test-vision", OG_TIMEOUT_MS: "1500" });
    resetEnvCache();
    Object.assign(fake, { mode: "ok", tee: true, noRequestId: false, signature: "good", answer: JSON.stringify({ description: "A clean Mandelbrot set.", quality: "good", notes: null }) });
    fake.requests.length = 0;
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("sends the image with verify_tee and the key, and records the request id and a verified signature", async () => {
    const r = await reviewImage(PNG, deps());
    expect(r).toMatchObject({ requestId: "req_0g_123456", model: "test-vision", teeVerified: true, verification: "tee-signature", signatureVerified: true, textBound: true, signer: FAKE_OG_SIGNER });
    expect(r.provider).toMatch(/^0x/);
    expect(r.output).toEqual({ description: "A clean Mandelbrot set.", quality: "good", notes: null });
    expect(r.imageSha256).toMatch(/^[0-9a-f]{64}$/);
    const call = fake.requests.find((q) => q.path === "/v1/chat/completions")!;
    expect(call.auth).toBe(`Bearer ${FAKE_OG_KEY}`);
    expect(call.body).toMatchObject({ model: "test-vision", verify_tee: true });
    expect(JSON.stringify(call.body)).toContain("data:image/png;base64,");
  });

  it("is router-checked only when no signature endpoint is configured, and says so", async () => {
    process.env.OG_SIGNATURE_BASE_URL = "";
    resetEnvCache();
    const r = await reviewImage(PNG, deps());
    expect(r).toMatchObject({ verification: "router-checked", signatureVerified: null, textBound: null });
    expect(fake.requests.some((q) => q.path.startsWith("/v1/proxy/signature"))).toBe(false);
  });

  it("is unverified when the Router says tee_verified false or says nothing, and there is no signature", async () => {
    process.env.OG_SIGNATURE_BASE_URL = "";
    resetEnvCache();
    fake.tee = false;
    expect((await reviewImage(PNG, deps())).verification).toBe("unverified");
    fake.tee = "missing";
    const r = await reviewImage(PNG, deps());
    expect(r).toMatchObject({ verification: "unverified", teeVerified: null });
  });

  it("does not claim a signature check when the signature came from the wrong signer (even if the Router says verified)", async () => {
    fake.signature = "bad-signer";
    const r = await reviewImage(PNG, deps());
    expect(r).toMatchObject({ teeVerified: true, signatureVerified: false, verification: "unverified" });
  });

  it("does not claim a signature check when the signed text is not about this response", async () => {
    fake.signature = "unbound";
    const r = await reviewImage(PNG, deps());
    expect(r).toMatchObject({ signatureVerified: true, textBound: false, verification: "router-checked" });
  });

  it("falls back to router-checked when the signature endpoint fails", async () => {
    fake.signature = "http-error";
    expect((await reviewImage(PNG, deps())).verification).toBe("router-checked");
  });

  it("retries one 429 after Retry-After, then succeeds", async () => {
    fake.mode = "rate-limit-once";
    const sleep = vi.fn(async () => {});
    const r = await reviewImage(PNG, deps({ sleep }));
    expect(r.requestId).toBe("req_0g_123456");
    expect(sleep).toHaveBeenCalledWith(1000);
  });

  it("gives up with rate_limited (and the wait) when 0G keeps answering 429", async () => {
    fake.mode = "rate-limit-always";
    await expect(reviewImage(PNG, deps())).rejects.toMatchObject({ code: "rate_limited", status: 429, retryAfter: 1 });
  });

  it("reports an outage, a non-JSON answer and a missing request id as clear errors", async () => {
    fake.mode = "error";
    await expect(reviewImage(PNG, deps())).rejects.toMatchObject({ code: "unavailable" });
    fake.mode = "html";
    await expect(reviewImage(PNG, deps())).rejects.toMatchObject({ code: "bad_response" });
    fake.mode = "ok";
    fake.noRequestId = true;
    await expect(reviewImage(PNG, deps())).rejects.toThrow(/request id/);
    process.env.OG_API_BASE_URL = "http://127.0.0.1:1/v1";
    resetEnvCache();
    await expect(reviewImage(PNG, deps())).rejects.toMatchObject({ code: "unavailable" });
  });

  it("times out when 0G never answers", async () => {
    fake.mode = "hang";
    process.env.OG_TIMEOUT_MS = "1000";
    resetEnvCache();
    await expect(reviewImage(PNG, deps())).rejects.toMatchObject({ code: "timeout", status: 504 });
  }, 10_000);

  it("is not configured without a key", async () => {
    process.env.OG_API_KEY = "";
    resetEnvCache();
    expect(ogConfigured()).toBe(false);
    await expect(reviewImage(PNG, deps())).rejects.toMatchObject({ code: "not_configured", status: 503 });
  });

  it("copes with a model that does not answer in JSON", async () => {
    fake.answer = "A pretty fractal.";
    const r = await reviewImage(PNG, deps());
    expect(r.output).toMatchObject({ description: "A pretty fractal.", quality: "unknown" });
    fake.answer = '```json\n{"description":"Blurry.","quality":"suspicious","notes":"flat region"}\n```';
    expect((await reviewImage(PNG, deps())).output).toEqual({ description: "Blurry.", quality: "suspicious", notes: "flat region" });
  });

  it("never lets the API key reach a log or an error message", async () => {
    const spies = (["log", "warn", "error", "info", "debug"] as const).map((m) => vi.spyOn(console, m));
    const leaky = deps({
      fetch: async () => {
        throw new Error(`connect failed for Bearer ${FAKE_OG_KEY}`);
      },
    });
    const err = (await reviewImage(PNG, leaky).catch((e) => e)) as OgError;
    expect(err).toBeInstanceOf(OgError);
    expect(err.message).not.toContain(FAKE_OG_KEY);
    expect(scrub(`x ${FAKE_OG_KEY} y`)).toBe("x [redacted] y");
    expect(JSON.stringify(spies.map((s) => s.mock.calls))).not.toContain(FAKE_OG_KEY);
    const ok = await reviewImage(PNG, deps());
    expect(JSON.stringify(ok)).not.toContain(FAKE_OG_KEY);
  });
});
