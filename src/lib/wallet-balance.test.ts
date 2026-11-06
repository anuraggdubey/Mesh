import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resetEnvCache } from "./env";
import { hbarToWeibarHex, startFakeRpc } from "./fake-rpc";
import type { FakeRpc } from "./fake-rpc";
import { setupTestEnv } from "./testing";
import { walletHbar } from "./wallet-balance";

const ADDR = "0xa32bcc4D0b5220767Ca13aD68d32eea5a3e1bafB";

describe("the wallet's own HBAR balance", () => {
  let rpc: FakeRpc;
  let cleanup: () => void;
  beforeAll(async () => {
    rpc = await startFakeRpc();
  });
  afterAll(() => rpc.stop());
  beforeEach(() => {
    cleanup = setupTestEnv();
    process.env.HEDERA_RPC_URL = rpc.url;
    resetEnvCache();
    rpc.mode = "ok";
    rpc.balances.clear();
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
});
