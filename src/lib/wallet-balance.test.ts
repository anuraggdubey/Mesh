import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resetEnvCache } from "./env";
import { hbarToWeibarHex, startFakeRpc } from "./fake-rpc";
import type { FakeRpc } from "./fake-rpc";
import { setupTestEnv } from "./testing";
import { formatWalletHbar, walletHbar } from "./wallet-balance";

const ADDR = "0xa32bcc4D0b5220767Ca13aD68d32eea5a3e1bafB";

function startMirror() {
  const mirror = { mode: "ok" as "ok" | "missing" | "down" | "hang", tinybars: 0, url: "" };
  const server: Server = createServer((req, res) => {
    if (mirror.mode === "hang") return;
    if (mirror.mode === "down") {
      res.writeHead(503);
      res.end("down");
      return;
    }
    if (mirror.mode === "missing") {
      res.writeHead(404);
      res.end("{}");
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ balance: { balance: mirror.tinybars, timestamp: "1.0", tokens: [{ token_id: "0.0.1", balance: 999 }] } }));
    void req;
  });
  return {
    mirror,
    listen: () =>
      new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", () => {
          mirror.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
          resolve();
        });
      }),
    stop: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

describe("the wallet's own HBAR balance", () => {
  let rpc: FakeRpc;
  let mirror: ReturnType<typeof startMirror>;
  let cleanup: () => void;
  beforeAll(async () => {
    rpc = await startFakeRpc();
    mirror = startMirror();
    await mirror.listen();
  });
  afterAll(async () => {
    await rpc.stop();
    await mirror.stop();
  });
  beforeEach(() => {
    cleanup = setupTestEnv();
    process.env.HEDERA_RPC_URL = rpc.url;
    process.env.MIRROR_NODE_URL = mirror.mirror.url;
    resetEnvCache();
    rpc.mode = "ok";
    rpc.calls = [];
    rpc.balances.clear();
    mirror.mirror.mode = "down";
    mirror.mirror.tinybars = 0;
  });
  afterEach(() => cleanup());

  it("reads the balance from the JSON-RPC and shows it in HBAR", async () => {
    rpc.balances.set(ADDR.toLowerCase(), hbarToWeibarHex(10));
    expect(await walletHbar(ADDR)).toBe("10");
  });

  it("keeps up to four decimals and trims the zeros", async () => {
    rpc.balances.set(ADDR.toLowerCase(), hbarToWeibarHex(1.23456789));
    expect(await walletHbar(ADDR)).toBe("1.2345");
    rpc.balances.set(ADDR.toLowerCase(), hbarToWeibarHex(0.5));
    expect(await walletHbar(ADDR)).toBe("0.5");
  });

  it("reports an empty wallet as 0", async () => {
    expect(await walletHbar(ADDR)).toBe("0");
  });

  it("returns null instead of failing when the RPC is down or errors", async () => {
    rpc.mode = "down";
    expect(await walletHbar(ADDR, 3000)).toBeNull();
    rpc.mode = "error";
    expect(await walletHbar(ADDR, 3000)).toBeNull();
  });

  it("reads the mirror node and does not wait on a hung JSON-RPC relay", async () => {
    mirror.mirror.mode = "ok";
    mirror.mirror.tinybars = 956_834_000; // 9.56834 HBAR, the same unit the public mirror returns
    rpc.mode = "hang";
    const started = performance.now();
    expect(await walletHbar(ADDR, 8_000)).toBe("9.5683");
    expect(performance.now() - started).toBeLessThan(500);
    expect(rpc.calls).not.toContain("eth_getBalance");
  });

  it("shows four decimal places of an HBAR amount and drops tinybar dust from the display", () => {
    expect(formatWalletHbar(954_230_000n)).toBe("9.5423"); // 9.54230000 HBAR
    expect(formatWalletHbar(123_456_789n)).toBe("1.2345"); // truncates, does not round up
    expect(formatWalletHbar(50_000_000n)).toBe("0.5");
    expect(formatWalletHbar(10_000n)).toBe("0.0001");
    expect(formatWalletHbar(1n)).toBe("0"); // one tinybar is below the four-decimal display
    expect(formatWalletHbar(0n)).toBe("0");
  });

  it("asks the relay when the mirror has not indexed the account yet", async () => {
    mirror.mirror.mode = "missing";
    rpc.balances.set(ADDR.toLowerCase(), hbarToWeibarHex(2.5));
    expect(await walletHbar(ADDR)).toBe("2.5");
    expect(rpc.calls).toContain("eth_getBalance");
  });

  it("shows 0 when the mirror has not indexed the account and the relay balance is zero", async () => {
    mirror.mirror.mode = "missing";
    expect(await walletHbar(ADDR)).toBe("0");
    expect(rpc.calls).toContain("eth_getBalance");
  });

  it("aborts a hung mirror and a hung relay inside the caller's budget", async () => {
    mirror.mirror.mode = "hang";
    rpc.mode = "hang";
    const started = performance.now();
    expect(await walletHbar(ADDR, 400)).toBeNull();
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(1_500);
    expect(elapsed).toBeGreaterThanOrEqual(350);
  });
});
