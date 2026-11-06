import { describe, expect, it } from "vitest";
import { Agent } from "./agent";
import { DEPOSIT_CONFIRM_BUDGET_MS, DepositNotConfirmedError, DepositRejectedError, confirmDeposit, signWalletLogin } from "@/components/wallet-connect";
import type { Eip1193 } from "@/components/wallet-discovery";

const ADDR = "0x6834228cb6F180C05fA2154a2B2670d92c4FDf59";
const TX = `0x${"ab".repeat(32)}`;

interface Stage {
  stage: string;
  ms: number;
}

function clock() {
  const stages: Stage[] = [];
  const started = performance.now();
  return {
    stages,
    mark(stage: string) {
      stages.push({ stage, ms: Math.round(performance.now() - started) });
    },
  };
}

describe("wallet and payment stage timing", () => {
  it("signs in without waiting on a chain switch that never settles", async () => {
    const c = clock();
    const calls: string[] = [];
    const eth: Eip1193 = {
      request: async ({ method }) => {
        calls.push(method);
        c.mark(method);
        if (method === "personal_sign") return "0xmocked";
        return new Promise(() => {}); // eth_chainId / wallet_switchEthereumChain would hang the wallet on the relay
      },
    };
    const started = performance.now();
    await signWalletLogin(eth, ADDR, async (url) => {
      c.mark(url);
      if (url.endsWith("/nonce")) return { ok: true, data: { nonce: "n", message: "Sign in to Mesh" } };
      return { ok: true, data: { address: ADDR } };
    });
    const elapsed = performance.now() - started;
    console.log(`SIGN_IN_STAGES ${JSON.stringify(c.stages)} elapsed_ms=${Math.round(elapsed)}`);
    expect(calls).toEqual(["personal_sign"]);
    expect(elapsed).toBeLessThan(200);
  });

  it("stops asking about an unconfirmed deposit at the app budget, not after 40 rounds", async () => {
    let t = 0;
    const calls: number[] = [];
    const started = performance.now();
    await expect(
      confirmDeposit(
        TX,
        async () => {
          calls.push(t);
          return { ok: false, data: { error: "pending", message: "not yet" } };
        },
        { budgetMs: DEPOSIT_CONFIRM_BUDGET_MS, intervalMs: 2_000, now: () => t, sleep: async (ms) => { t += ms; } },
      ),
    ).rejects.toBeInstanceOf(DepositNotConfirmedError);
    const elapsed = performance.now() - started;
    const oldLoopMs = 40 * 2_000;
    console.log(`DEPOSIT_STATUS calls=${calls.length} simulated_ms=${t} old_loop_ms=${oldLoopMs} wall_ms=${Math.round(elapsed)}`);
    expect(t).toBe(DEPOSIT_CONFIRM_BUDGET_MS);
    expect(calls.length).toBe(6);
    expect(t).toBeLessThan(oldLoopMs / 4);
    expect(elapsed).toBeLessThan(200);
  });

  it("stops on a rejected deposit and keeps the same hash", async () => {
    let calls = 0;
    const error = await confirmDeposit(TX, async () => {
      calls += 1;
      return { ok: false, data: { error: "wrong_sender", message: "that transaction was sent from a different wallet" } };
    }, { budgetMs: 12_000, now: () => 0, sleep: async () => { throw new Error("retried a rejected deposit"); } }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DepositRejectedError);
    expect((error as DepositRejectedError).txHash).toBe(TX);
    expect(calls).toBe(1);
  });

  it("retries a dead relay, then the same hash can be credited once", async () => {
    let t = 0;
    let calls = 0;
    const first = await confirmDeposit(TX, async () => {
      calls += 1;
      return { ok: false, data: { error: "rpc_unavailable", message: "relay down" } };
    }, { budgetMs: 4_000, intervalMs: 2_000, now: () => t, sleep: async (ms) => { t += ms; } }).catch((e: unknown) => e);
    expect(first).toBeInstanceOf(DepositNotConfirmedError);
    expect((first as DepositNotConfirmedError).txHash).toBe(TX);
    expect(calls).toBe(2);
    let t2 = 0;
    const credited = await confirmDeposit(TX, async () => {
      calls += 1;
      if (calls === 3) return { ok: false, data: { error: "pending" } };
      return { ok: true, data: { creditedHbar: "1", balanceHbar: "1", receiptId: "rcpt_0123456789abcdef", receiptUrl: "/receipts/rcpt_0123456789abcdef" } };
    }, { now: () => t2, sleep: async (ms) => { t2 += ms; } });
    expect(credited.creditedHbar).toBe("1");
    const again = await confirmDeposit(TX, async () => ({ ok: false, data: { error: "already_credited", message: "that deposit was already credited" } })).catch((e: unknown) => e);
    expect(again).toBeInstanceOf(DepositRejectedError);
    expect((again as DepositRejectedError).message).toMatch(/not counted again/);
    expect((again as DepositRejectedError).txHash).toBe(TX);
  });

  it("a rejected login signature does not ask the wallet to switch chains", async () => {
    const calls: string[] = [];
    const eth: Eip1193 = {
      request: async ({ method }) => {
        calls.push(method);
        if (method === "personal_sign") return "0xmocked";
        return new Promise(() => {});
      },
    };
    await expect(signWalletLogin(eth, ADDR, async (url) => {
      if (url.endsWith("/nonce")) return { ok: true, data: { nonce: "n", message: "Sign in to Mesh" } };
      return { ok: false, data: { error: "bad_signature", message: "signature rejected" } };
    })).rejects.toThrow(/signature rejected/);
    expect(calls).toEqual(["personal_sign"]);
  });

  it("prepares one x402 payment and posts it once, with no sleep and no second signature", async () => {
    const c = clock();
    let pays = 0;
    let sleeps = 0;
    const quote = {
      x402Version: 2,
      resource: { url: "http://mesh.test/api/jobs", description: "t", mimeType: "application/json" },
      accepts: [{ scheme: "exact", network: "hedera:testnet", amount: "10000000", asset: "0.0.0", payTo: "0.0.1234", maxTimeoutSeconds: 120, extra: { feePayer: "0.0.1" } }],
    };
    const agent = new Agent(
      { apiUrl: "http://mesh.test", requester: ADDR, budget: 100_000n, perJobCap: 100_000n, allowedPresets: ["tiny"], asset: "0.0.0", approvalTimeoutMs: 60_000 },
      {
        fetch: async (_url, init) => {
          const headers = new Headers(init?.headers);
          const signed = headers.get("payment-signature");
          c.mark(signed ? "post-paid" : "post-quote");
          if (!signed) return Response.json(quote, { status: 402 });
          return Response.json({ jobId: "job_test", payment: { transaction: "0.0.1@1.2", amount: "10000000", asset: "0.0.0" } });
        },
        pay: async () => {
          pays += 1;
          c.mark("pay-handoff");
          return "not-a-real-payment";
        },
        sleep: async (ms) => {
          sleeps += 1;
          c.mark(`sleep-${ms}`);
        },
        log: () => {},
        onApprovalNeeded: () => {},
      },
    );
    const started = performance.now();
    const result = await agent.runJob("tiny");
    const elapsed = performance.now() - started;
    console.log(`PAYMENT_PREP_STAGES ${JSON.stringify(c.stages)} elapsed_ms=${Math.round(elapsed)}`);
    expect(result).toMatchObject({ jobId: "job_test", paymentTx: "0.0.1@1.2" });
    expect(pays).toBe(1);
    expect(sleeps).toBe(0);
    expect(c.stages.map((s) => s.stage)).toEqual(["post-quote", "pay-handoff", "post-paid"]);
    expect(elapsed).toBeLessThan(200);
  });

  it("does not ask the payer again when the paid retry is still a 402", async () => {
    let pays = 0;
    let posts = 0;
    const quote = {
      x402Version: 2,
      resource: { url: "http://mesh.test/api/jobs", description: "t", mimeType: "application/json" },
      accepts: [{ scheme: "exact", network: "hedera:testnet", amount: "10000000", asset: "0.0.0", payTo: "0.0.1234", maxTimeoutSeconds: 120, extra: { feePayer: "0.0.1" } }],
    };
    const agent = new Agent(
      { apiUrl: "http://mesh.test", requester: ADDR, budget: 100_000n, perJobCap: 100_000n, allowedPresets: ["tiny"], asset: "0.0.0", approvalTimeoutMs: 60_000 },
      {
        fetch: async () => {
          posts += 1;
          return Response.json(quote, { status: 402 });
        },
        pay: async () => {
          pays += 1;
          return "not-a-real-payment";
        },
        sleep: async () => { throw new Error("slept on a rejected payment"); },
        log: () => {},
        onApprovalNeeded: () => {},
      },
    );
    await expect(agent.runJob("tiny")).rejects.toMatchObject({ code: "payment_rejected" });
    expect(posts).toBe(2);
    expect(pays).toBe(1);
  });
});
