// @vitest-environment jsdom

import { act, useEffect } from "react";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WalletProvider, useWallet } from "./wallet-provider";

type WalletApi = ReturnType<typeof useWallet>;

const ADDR = "0x6834228cb6F180C05fA2154a2B2670d92c4FDf59";
const DEPOSIT_TO = "0x00000000000000000000000000000000000000A1";
const TX = `0x${"cd".repeat(32)}`;

interface Stage {
  stage: string;
  ms: number;
}

let onRequest: (() => void) | undefined;
const accountListeners = new Set<(accounts?: string[]) => void>();

function installWallet(request: (args: { method: string }) => Promise<unknown>) {
  if (onRequest) window.removeEventListener("eip6963:requestProvider", onRequest);
  const provider = {
    request,
    on: (event: string, fn: (accounts?: string[]) => void) => {
      if (event === "accountsChanged") accountListeners.add(fn);
    },
    removeListener: (event: string, fn: (accounts?: string[]) => void) => {
      if (event === "accountsChanged") accountListeners.delete(fn);
    },
  };
  onRequest = () => {
    window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: { info: { uuid: "mm", name: "MetaMask", rdns: "io.metamask" }, provider } }));
  };
  window.addEventListener("eip6963:requestProvider", onRequest);
}

describe("connected wallet stages", () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  let root: Root;
  let element: HTMLDivElement;
  const stages: Stage[] = [];
  let started = 0;

  afterEach(() => {
    act(() => root.unmount());
    element.remove();
    if (onRequest) window.removeEventListener("eip6963:requestProvider", onRequest);
    onRequest = undefined;
    accountListeners.clear();
    vi.unstubAllGlobals();
    console.log(`UI_STAGES ${JSON.stringify(stages)}`);
  });

  async function mount(probe: (wallet: WalletApi) => void) {
    started = performance.now();
    stages.length = 0;
    element = document.createElement("div");
    document.body.append(element);
    root = createRoot(element);
    function Probe() {
      const wallet = useWallet();
      useEffect(() => probe(wallet));
      return createElement("span", null, wallet.info?.authenticated ? "in" : "out");
    }
    await act(async () => {
      root.render(createElement(WalletProvider, null, createElement(Probe)));
      await new Promise((r) => setTimeout(r, 30));
    });
  }

  function mark(stage: string) {
    stages.push({ stage, ms: Math.round(performance.now() - started) });
  }

  it("connects and hands off the login signature while a chain switch stays pending", async () => {
    const calls: string[] = [];
    installWallet(async ({ method }) => {
      calls.push(method);
      mark(`wallet:${method}`);
      if (method === "eth_requestAccounts") return [ADDR];
      if (method === "personal_sign") return "0xmocked-login";
      return new Promise(() => {});
    });
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      mark(`http ${init?.method ?? "GET"} ${url}`);
      if (String(url).endsWith("/api/auth/nonce")) return Response.json({ nonce: "abc", message: "Sign in to Mesh" });
      if (String(url).endsWith("/api/auth/verify")) return Response.json({ address: ADDR });
      return Response.json({
        authenticated: false,
        address: null,
        balanceHbar: "0",
        walletBalanceHbar: null,
        balanceTinybars: 0,
        depositAddress: DEPOSIT_TO,
        chainId: 296,
        rpcUrl: "https://testnet.hashio.io/api",
      });
    });

    let connect: WalletApi["connect"] | undefined;
    await mount((wallet) => {
      connect = wallet.connect;
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 350));
    });
    const t = performance.now();
    await act(async () => {
      await connect!();
    });
    const elapsed = performance.now() - t;
    console.log(`CONNECT_ELAPSED_MS ${Math.round(elapsed)} calls=${calls.join(",")}`);
    expect(calls).toEqual(["eth_requestAccounts", "personal_sign"]);
    expect(elapsed).toBeLessThan(1_000);
  });

  it("switches network only when preparing a deposit, then reads status once when the server has the receipt", async () => {
    const calls: string[] = [];
    let depositPosts = 0;
    let switched = false;
    installWallet(async ({ method }) => {
      calls.push(method);
      mark(`wallet:${method}`);
      if (method === "eth_chainId") return switched ? "0x128" : "0x1";
      if (method === "wallet_switchEthereumChain") {
        switched = true;
        return null;
      }
      if (method === "eth_sendTransaction") return TX;
      throw new Error(`unexpected ${method}`);
    });
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      mark(`http ${init?.method ?? "GET"} ${url}`);
      if (String(url).endsWith("/api/wallet/deposit")) {
        depositPosts += 1;
        return Response.json({ creditedHbar: "1", balanceHbar: "1", receiptId: "rcpt_0123456789abcdef", receiptUrl: "/receipts/rcpt_0123456789abcdef" });
      }
      return Response.json({
        authenticated: true,
        address: ADDR,
        balanceHbar: "0",
        walletBalanceHbar: "3",
        balanceTinybars: 0,
        depositAddress: DEPOSIT_TO,
        chainId: 296,
        rpcUrl: "https://testnet.hashio.io/api",
      });
    });

    let deposit: WalletApi["deposit"] | undefined;
    await mount((wallet) => {
      deposit = wallet.deposit;
    });
    await act(async () => {
      await vi.waitFor(() => {
        if (element.textContent !== "in") throw new Error("session not loaded");
      });
    });
    const statuses: string[] = [];
    const t = performance.now();
    let result: Awaited<ReturnType<WalletApi["deposit"]>> | undefined;
    await act(async () => {
      result = await deposit!(1, (s) => statuses.push(s));
    });
    const elapsed = performance.now() - t;
    console.log(`DEPOSIT_PREP_ELAPSED_MS ${Math.round(elapsed)} calls=${calls.join(",")} statuses=${statuses.join(",")}`);
    expect(calls).toEqual(["eth_chainId", "wallet_switchEthereumChain", "eth_chainId", "eth_sendTransaction"]);
    expect(statuses).toEqual(["confirm", "waiting"]);
    expect(depositPosts).toBe(1);
    expect(result?.txHash).toBe(TX);
    expect(elapsed).toBeLessThan(1_000);
  });

  it("does not send a transfer when the wallet stays off chain 296", async () => {
    const calls: string[] = [];
    installWallet(async ({ method }) => {
      calls.push(method);
      if (method === "eth_chainId") return "0x1";
      if (method === "wallet_switchEthereumChain") return null;
      if (method === "eth_sendTransaction") return TX;
      throw new Error(method);
    });
    vi.stubGlobal("fetch", async () => Response.json({
      authenticated: true, address: ADDR, balanceHbar: "0", walletBalanceHbar: "1", balanceTinybars: 0,
      depositAddress: DEPOSIT_TO, chainId: 296, rpcUrl: "https://testnet.hashio.io/api",
    }));
    let deposit: WalletApi["deposit"] | undefined;
    await mount((wallet) => {
      deposit = wallet.deposit;
    });
    await act(async () => {
      await vi.waitFor(() => {
        if (element.textContent !== "in") throw new Error("session not loaded");
      });
    });
    await expect(act(async () => {
      await deposit!(1, () => {});
    })).rejects.toThrow(/still not on chain 296/);
    expect(calls).not.toContain("eth_sendTransaction");
    expect(calls.filter((c) => c === "eth_chainId").length).toBeGreaterThanOrEqual(2);
  });

  it("signs out when the wallet account changes", async () => {
    const calls: string[] = [];
    installWallet(async ({ method }) => {
      calls.push(method);
      throw new Error(method);
    });
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      urls.push(`${init?.method ?? "GET"} ${String(url)}`);
      return Response.json({
        authenticated: true, address: ADDR, balanceHbar: "0", walletBalanceHbar: "1", balanceTinybars: 0,
        depositAddress: DEPOSIT_TO, chainId: 296, rpcUrl: "https://testnet.hashio.io/api",
      });
    });
    await mount(() => {});
    await act(async () => {
      await new Promise((r) => setTimeout(r, 400));
    });
    expect(accountListeners.size).toBeGreaterThan(0);
    await act(async () => {
      for (const fn of accountListeners) fn(["0x1111111111111111111111111111111111111111"]);
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(urls.some((u) => u.includes("/api/auth/logout"))).toBe(true);
    expect(calls).not.toContain("eth_sendTransaction");
  });
});
