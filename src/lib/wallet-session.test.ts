import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/server", () => ({ connection: async () => {} }));

import { POST as logoutPost } from "@/app/api/auth/logout/route";
import { POST as noncePost } from "@/app/api/auth/nonce/route";
import { POST as verifyPost } from "@/app/api/auth/verify/route";
import { GET as walletGet } from "@/app/api/wallet/route";
import { getDb } from "./db";
import { resetEnvCache } from "./env";
import { resetRateLimits } from "./rate-limit";
import { readSession } from "./session";
import { setupTestEnv } from "./testing";
import { cookiePair, get, other, post, signIn, user } from "./testing-wallet";

describe("wallet sign-in", () => {
  let cleanup: () => void;
  beforeEach(() => {
    cleanup = setupTestEnv({ AGENT_DEPOSIT_ADDRESS: "0x00000000000000000000000000000000000000a1" } as never);
    process.env.MESH_SESSION_SECRET = "a-test-session-secret-0123456789";
    resetEnvCache();
    resetRateLimits();
  });
  afterEach(() => cleanup());

  async function nonceFor(address: string) {
    const res = await noncePost(post("/api/auth/nonce", { address }));
    expect(res.status).toBe(200);
    return (await res.json()) as { nonce: string; message: string; expiresAt: number };
  }

  it("signs in with a good signature and sets an HttpOnly, SameSite=Lax session cookie", async () => {
    const n = await nonceFor(user.address);
    expect(n.message).toContain(user.address); // the address is in the text that is signed
    expect(n.message).toContain("localhost:3000"); // so is the domain
    const signature = await user.signMessage({ message: n.message });
    const res = await verifyPost(post("/api/auth/verify", { address: user.address, nonce: n.nonce, signature }));
    expect(res.status).toBe(200);
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/^mesh_session=ey/);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).not.toContain("Secure"); // http://localhost
    expect(await readSession(get("/", cookiePair(res)))).toBe(user.address.toLowerCase());
  });

  it("marks the cookie Secure when the public URL is https", async () => {
    process.env.API_PUBLIC_URL = "https://mesh.example";
    resetEnvCache();
    const n = await nonceFor(user.address);
    const signature = await user.signMessage({ message: n.message });
    const res = await verifyPost(post("/api/auth/verify", { address: user.address, nonce: n.nonce, signature }));
    expect(res.headers.get("set-cookie")).toContain("Secure");
    expect(n.message).toContain("mesh.example");
  });

  it("refuses a signature from a different wallet", async () => {
    const n = await nonceFor(user.address);
    const signature = await other.signMessage({ message: n.message });
    const res = await verifyPost(post("/api/auth/verify", { address: user.address, nonce: n.nonce, signature }));
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("bad_signature");
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("refuses a signature over different text (the server signs what it built, not what the client sends)", async () => {
    const n = await nonceFor(user.address);
    const signature = await user.signMessage({ message: n.message.replace("Signing costs nothing", "Send me all your money") });
    const res = await verifyPost(post("/api/auth/verify", { address: user.address, nonce: n.nonce, signature }));
    expect(res.status).toBe(401);
  });

  it("a nonce works once: replaying a good signature is refused", async () => {
    const n = await nonceFor(user.address);
    const signature = await user.signMessage({ message: n.message });
    expect((await verifyPost(post("/api/auth/verify", { address: user.address, nonce: n.nonce, signature }))).status).toBe(200);
    const again = await verifyPost(post("/api/auth/verify", { address: user.address, nonce: n.nonce, signature }));
    expect(again.status).toBe(401);
    expect((await again.json()).error).toBe("nonce_used");
  });

  it("refuses an expired nonce", async () => {
    const n = await nonceFor(user.address);
    getDb().prepare("UPDATE auth_nonces SET expires_at = ? WHERE nonce = ?").run(Math.floor(Date.now() / 1000) - 5, n.nonce);
    const signature = await user.signMessage({ message: n.message });
    const res = await verifyPost(post("/api/auth/verify", { address: user.address, nonce: n.nonce, signature }));
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("nonce_expired");
  });

  it("refuses a nonce that was issued to another address, or never issued", async () => {
    const n = await nonceFor(user.address);
    const sig = await other.signMessage({ message: n.message });
    expect((await verifyPost(post("/api/auth/verify", { address: other.address, nonce: n.nonce, signature: sig }))).status).toBe(401);
    expect((await verifyPost(post("/api/auth/verify", { address: user.address, nonce: "0".repeat(32), signature: sig }))).status).toBe(401);
  });

  it("validates input: a bad address and a malformed signature are 400", async () => {
    expect((await noncePost(post("/api/auth/nonce", { address: "nope" }))).status).toBe(400);
    const n = await nonceFor(user.address);
    expect((await verifyPost(post("/api/auth/verify", { address: user.address, nonce: n.nonce, signature: "0x12" }))).status).toBe(400);
  });

  it("GET /api/wallet: signed out has no address, signed in shows the address, a zero balance and the deposit address", async () => {
    const out = await (await walletGet(get("/api/wallet"))).json();
    expect(out).toMatchObject({ authenticated: false, address: null, balanceTinybars: 0 });
    const cookie = await signIn();
    const inn = await (await walletGet(get("/api/wallet", cookie))).json();
    expect(inn).toMatchObject({ authenticated: true, address: user.address, balanceTinybars: 0, balanceHbar: "0" });
    expect(inn.depositAddress).toBe("0x00000000000000000000000000000000000000A1");
  });

  it("a forged or tampered cookie is just 'not signed in'", async () => {
    const cookie = await signIn();
    const [name, token] = cookie.split("=");
    const bad = `${name}=${token.slice(0, -4)}AAAA`;
    expect(await readSession(get("/", bad))).toBeNull();
    expect(await readSession(get("/", "mesh_session=not-a-token"))).toBeNull();
    expect((await (await walletGet(get("/api/wallet", bad))).json()).authenticated).toBe(false);
  });

  it("a cookie signed with another secret is rejected", async () => {
    const cookie = await signIn();
    process.env.MESH_SESSION_SECRET = "a-different-secret-0123456789ab";
    resetEnvCache();
    expect(await readSession(get("/", cookie))).toBeNull();
  });

  it("falls back to a key derived from API_PRIVATE_KEY when no session secret is set", async () => {
    process.env.MESH_SESSION_SECRET = "";
    process.env.API_PRIVATE_KEY = "0x" + "44".repeat(32);
    resetEnvCache();
    const cookie = await signIn();
    expect(await readSession(get("/", cookie))).toBe(user.address.toLowerCase());
  });

  it("answers 503 when no secret can be derived", async () => {
    process.env.MESH_SESSION_SECRET = "";
    process.env.API_PRIVATE_KEY = "";
    resetEnvCache();
    const n = await nonceFor(user.address);
    const signature = await user.signMessage({ message: n.message });
    await expect(verifyPost(post("/api/auth/verify", { address: user.address, nonce: n.nonce, signature }))).resolves.toMatchObject({ status: 503 });
  });

  it("logout clears the cookie", async () => {
    const res = await logoutPost();
    expect(res.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it("rate limits nonce requests", async () => {
    let last = 200;
    for (let i = 0; i < 25; i++) last = (await noncePost(post("/api/auth/nonce", { address: user.address }))).status;
    expect(last).toBe(429);
  });
});
