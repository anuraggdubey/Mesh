import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/server", () => ({ connection: async () => {} }));

import { POST as depositPost } from "@/app/api/wallet/deposit/route";
import { GET as walletGet } from "@/app/api/wallet/route";
import { CreditError, creditDeposit, getBalance, holdCredit, listLedger, refundHold, tinybarsToHbar } from "./credits";
import { depositAddress, DepositError, MIN_DEPOSIT_TINYBARS, recordDeposit, weibarToTinybar } from "./deposits";
import { resetEnvCache } from "./env";
import { hbarToWeibarHex, startFakeRpc } from "./fake-rpc";
import type { FakeRpc } from "./fake-rpc";
import { resetRateLimits } from "./rate-limit";
import { setupTestEnv } from "./testing";
import { get, other, post, signIn, user } from "./testing-wallet";

const AGENT = "0x00000000000000000000000000000000000000A1";
const tx = (n: number) => "0x" + n.toString(16).padStart(64, "0");

describe("deposit unit conversion", () => {
  it("1 HBAR is 1e18 weibar and 1e8 tinybar, so tinybars = weibars / 1e10", () => {
    expect(weibarToTinybar(10n ** 18n)).toBe(100_000_000);
    expect(weibarToTinybar(5n * 10n ** 17n)).toBe(50_000_000); // 0.5 HBAR
    expect(weibarToTinybar(10n ** 10n)).toBe(1); // one tinybar
    expect(weibarToTinybar(10n ** 10n - 1n)).toBe(0); // less than a tinybar rounds down
    expect(weibarToTinybar(123_456_789_012_345_678_901n)).toBe(12_345_678_901); // 123.456789012... rounds down
  });

  it("formats tinybars as HBAR", () => {
    expect(tinybarsToHbar(100_000_000)).toBe("1");
    expect(tinybarsToHbar(50_000_000)).toBe("0.5");
    expect(tinybarsToHbar(1)).toBe("0.00000001");
    expect(tinybarsToHbar(0)).toBe("0");
    expect(tinybarsToHbar(1_234_500_000)).toBe("12.345");
  });
});

describe("prepaid credit and deposits", () => {
  let rpc: FakeRpc;
  let cleanup: () => void;
  beforeAll(async () => {
    rpc = await startFakeRpc();
  });
  afterAll(() => rpc.stop());
  beforeEach(() => {
    cleanup = setupTestEnv();
    Object.assign(process.env, { MESH_SESSION_SECRET: "a-test-session-secret-0123456789", AGENT_DEPOSIT_ADDRESS: AGENT, HEDERA_RPC_URL: rpc.url });
    resetEnvCache();
    resetRateLimits();
    rpc.txs.clear();
    rpc.mode = "ok";
    rpc.calls = [];
  });
  afterEach(() => cleanup());

  const send = (hash: string, over: Partial<{ from: string; to: string | null; value: string; chainId: string; status: "0x1" | "0x0"; mined: boolean }> = {}) =>
    rpc.txs.set(hash, { from: user.address, to: AGENT, value: hbarToWeibarHex(2), ...over });

  describe("recordDeposit", () => {
    it("credits a confirmed deposit from the signed-in wallet to the agent wallet, in tinybars, and gives a receipt id", async () => {
      send(tx(1), { value: hbarToWeibarHex(2) });
      const r = await recordDeposit(user.address, tx(1));
      expect(r.credited).toBe(200_000_000);
      expect(r.balance).toBe(200_000_000);
      expect(r.receiptId).toMatch(/^rcpt_[0-9a-f]{16}$/);
      expect(getBalance(user.address)).toBe(200_000_000);
      expect(rpc.calls).toContain("eth_getTransactionReceipt");
    });

    it("reads the amount from the chain: a partial HBAR is credited exactly", async () => {
      send(tx(2), { value: hbarToWeibarHex(0.25) });
      expect((await recordDeposit(user.address, tx(2))).credited).toBe(25_000_000);
    });

    it("refuses a transaction that paid someone else", async () => {
      send(tx(3), { to: "0x00000000000000000000000000000000000000B2" });
      await expect(recordDeposit(user.address, tx(3))).rejects.toMatchObject({ code: "wrong_recipient", status: 422 });
      expect(getBalance(user.address)).toBe(0);
    });

    it("refuses a deposit sent from a different wallet than the one signed in (nobody can claim someone else's transfer)", async () => {
      send(tx(4), { from: other.address });
      await expect(recordDeposit(user.address, tx(4))).rejects.toMatchObject({ code: "wrong_sender", status: 403 });
      expect(getBalance(user.address)).toBe(0);
      expect(getBalance(other.address)).toBe(0);
    });

    it("refuses a failed transaction", async () => {
      send(tx(5), { status: "0x0" });
      await expect(recordDeposit(user.address, tx(5))).rejects.toMatchObject({ code: "failed" });
      expect(getBalance(user.address)).toBe(0);
    });

    it("says 'pending' for a transaction that is not mined yet, and credits it once it is", async () => {
      send(tx(6), { mined: false });
      await expect(recordDeposit(user.address, tx(6))).rejects.toMatchObject({ code: "pending", status: 409 });
      rpc.txs.get(tx(6))!.mined = true;
      expect((await recordDeposit(user.address, tx(6))).credited).toBe(200_000_000);
    });

    it("says not_found for a hash the chain has never seen", async () => {
      await expect(recordDeposit(user.address, tx(7))).rejects.toMatchObject({ code: "not_found", status: 404 });
    });

    it("never credits the same transaction twice", async () => {
      send(tx(8));
      await recordDeposit(user.address, tx(8));
      await expect(recordDeposit(user.address, tx(8))).rejects.toMatchObject({ code: "already_credited", status: 409 });
      await expect(recordDeposit(user.address, tx(8).toUpperCase().replace("0X", "0x"))).rejects.toMatchObject({ code: "already_credited" });
      expect(getBalance(user.address)).toBe(200_000_000);
      expect(listLedger(user.address).filter((l) => l.kind === "deposit")).toHaveLength(1);
    });

    it("refuses dust and a transaction from another network", async () => {
      send(tx(9), { value: hbarToWeibarHex(0.001) });
      await expect(recordDeposit(user.address, tx(9))).rejects.toMatchObject({ code: "too_small" });
      expect(MIN_DEPOSIT_TINYBARS).toBe(1_000_000);
      send(tx(10), { chainId: "0x1" });
      await expect(recordDeposit(user.address, tx(10))).rejects.toMatchObject({ code: "wrong_chain" });
    });

    it("reports the relay being down as 503 and changes nothing", async () => {
      send(tx(11));
      rpc.mode = "down";
      await expect(recordDeposit(user.address, tx(11))).rejects.toMatchObject({ code: "rpc_unavailable", status: 503 });
      rpc.mode = "error";
      await expect(recordDeposit(user.address, tx(11))).rejects.toMatchObject({ code: "rpc_unavailable" });
      expect(getBalance(user.address)).toBe(0);
    });

    it("rejects a malformed hash and answers 503 when no deposit address is configured", async () => {
      await expect(recordDeposit(user.address, "0x12")).rejects.toBeInstanceOf(DepositError);
      process.env.AGENT_DEPOSIT_ADDRESS = "";
      process.env.AGENT_PRIVATE_KEY = "";
      resetEnvCache();
      await expect(recordDeposit(user.address, tx(12))).rejects.toMatchObject({ code: "not_configured", status: 503 });
    });

    it("derives the deposit address from the agent key when no override is set", () => {
      process.env.AGENT_DEPOSIT_ADDRESS = "";
      process.env.AGENT_PRIVATE_KEY = "0x" + "11".repeat(32);
      resetEnvCache();
      expect(depositAddress()).toBe("0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A");
    });
  });

  describe("POST /api/wallet/deposit", () => {
    it("needs a session", async () => {
      expect((await depositPost(post("/api/wallet/deposit", { txHash: tx(1) }))).status).toBe(401);
    });

    it("credits through the route and returns the receipt link; the balance shows on GET /api/wallet", async () => {
      send(tx(20), { value: hbarToWeibarHex(1.5) });
      const cookie = await signIn();
      const res = await depositPost(post("/api/wallet/deposit", { txHash: tx(20) }, cookie));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({ credited: true, creditedHbar: "1.5", balanceHbar: "1.5" });
      expect(body.receiptUrl).toBe(`/receipts/${body.receiptId}`);
      expect(body.hashscan).toBe(`https://hashscan.io/testnet/transaction/${tx(20)}`);
      expect((await (await walletGet(get("/api/wallet", cookie))).json()).balanceHbar).toBe("1.5");
    });

    it("rejects a bad body and rate limits repeated checks", async () => {
      const cookie = await signIn();
      expect((await depositPost(post("/api/wallet/deposit", { txHash: "nope" }, cookie))).status).toBe(400);
      let last = 0;
      for (let i = 0; i < 35; i++) last = (await depositPost(post("/api/wallet/deposit", { txHash: tx(99) }, cookie))).status;
      expect(last).toBe(429);
    });
  });

  describe("the balance can never be wrong", () => {
    it("holds and refunds exactly, and refuses to go below zero", () => {
      creditDeposit(user.address, 100, tx(30));
      expect(holdCredit(user.address, 60, "run-a").balance).toBe(40);
      expect(() => holdCredit(user.address, 60, "run-b")).toThrow(CreditError);
      expect(getBalance(user.address)).toBe(40); // the refused hold changed nothing
      expect(refundHold(user.address, 60, "run-a")).toMatch(/^rcpt_/);
      expect(getBalance(user.address)).toBe(100);
    });

    it("refunds a hold only once", () => {
      creditDeposit(user.address, 100, tx(31));
      holdCredit(user.address, 100, "run-c");
      expect(refundHold(user.address, 100, "run-c")).not.toBeNull();
      expect(refundHold(user.address, 100, "run-c")).toBeNull();
      expect(getBalance(user.address)).toBe(100);
    });

    it("holds the same run twice only once", () => {
      creditDeposit(user.address, 100, tx(32));
      holdCredit(user.address, 10, "run-d");
      expect(() => holdCredit(user.address, 10, "run-d")).toThrow(/already recorded/);
      expect(getBalance(user.address)).toBe(90);
    });

    it("many holds at once never take more than the balance", () => {
      creditDeposit(user.address, 100, tx(33));
      let ok = 0;
      for (let i = 0; i < 20; i++) {
        try {
          holdCredit(user.address, 15, `run-${i}`);
          ok += 1;
        } catch (e) {
          expect(e).toBeInstanceOf(CreditError);
        }
      }
      expect(ok).toBe(6); // 6 x 15 = 90 <= 100
      expect(getBalance(user.address)).toBe(10);
    });

    it("rejects zero, negative and fractional amounts", () => {
      expect(() => creditDeposit(user.address, 0, tx(34))).toThrow(CreditError);
      expect(() => creditDeposit(user.address, -5, tx(35))).toThrow(CreditError);
      expect(() => holdCredit(user.address, 1.5, "run-e")).toThrow(CreditError);
    });

    it("every ledger entry has its own receipt id", () => {
      creditDeposit(user.address, 100, tx(36));
      holdCredit(user.address, 40, "run-f");
      refundHold(user.address, 40, "run-f");
      const ids = listLedger(user.address).map((l) => l.receipt_id);
      expect(ids).toHaveLength(3);
      expect(new Set(ids).size).toBe(3);
      for (const id of ids) expect(id).toMatch(/^rcpt_[0-9a-f]{16}$/);
    });
  });
});
