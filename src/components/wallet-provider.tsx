"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { parseEther, toHex } from "viem";
import { pickWallet } from "./wallet-discovery";
import type { Eip1193, PickedWallet } from "./wallet-discovery";

/**
 * Wallet state for the whole site. Any EIP-1193 wallet (MetaMask and friends): connect, switch to Hedera testnet, sign a plain
 * message to sign in (no transaction, no gas), and send a normal HBAR transfer to deposit credit. We never see a key.
 */


export interface WalletInfo {
  authenticated: boolean;
  address: string | null;
  balanceHbar: string;
  /** the wallet's own HBAR on chain (not the prepaid credit); null while it cannot be read */
  walletBalanceHbar: string | null;
  balanceTinybars: number;
  depositAddress: string | null;
  chainId: number;
  rpcUrl: string;
}

export interface DepositResult {
  txHash: string;
  creditedHbar: string;
  balanceHbar: string;
  receiptId: string;
  receiptUrl: string;
}

interface Ctx {
  info: WalletInfo | null;
  busy: "idle" | "connecting" | "signing";
  error: string | null;
  hasWallet: boolean;
  /** bumps whenever money moved, so lists can reload */
  version: number;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  refresh: () => Promise<void>;
  bump: () => void;
  deposit: (amountHbar: number, onStatus: (s: "confirm" | "waiting") => void) => Promise<DepositResult>;
}

const WalletCtx = createContext<Ctx | null>(null);

export function useWallet(): Ctx {
  const c = useContext(WalletCtx);
  if (!c) throw new Error("useWallet must be used inside <WalletProvider>");
  return c;
}

const errMessage = (e: unknown, fallback: string): string => {
  const x = e as { code?: number; message?: string };
  if (x?.code === 4001) return "You cancelled the request in your wallet.";
  return x?.message ? x.message.slice(0, 200) : fallback;
};

async function api<T>(url: string, body?: unknown): Promise<{ ok: boolean; status: number; data: T & { error?: string; message?: string } }> {
  const res = await fetch(url, body === undefined ? undefined : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string; message?: string };
  return { ok: res.ok, status: res.status, data };
}

async function ensureHederaChain(eth: Eip1193, chainId: number, rpcUrl: string): Promise<void> {
  const want = `0x${chainId.toString(16)}`;
  const current = (await eth.request({ method: "eth_chainId" })) as string;
  if (current.toLowerCase() === want) return;
  try {
    await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: want }] });
  } catch (e) {
    const code = (e as { code?: number }).code;
    if (code !== 4902 && code !== -32603) throw e; // 4902: the wallet does not know this chain yet
    await eth.request({
      method: "wallet_addEthereumChain",
      params: [{ chainId: want, chainName: "Hedera Testnet", nativeCurrency: { name: "HBAR", symbol: "HBAR", decimals: 18 }, rpcUrls: [rpcUrl], blockExplorerUrls: ["https://hashscan.io/testnet"] }],
    });
  }
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const [info, setInfo] = useState<WalletInfo | null>(null);
  const [busy, setBusy] = useState<Ctx["busy"]>("idle");
  const [error, setError] = useState<string | null>(null);
  const [hasWallet, setHasWallet] = useState(false);
  const [version, setVersion] = useState(0);
  const [walletName, setWalletName] = useState<string | null>(null);
  const picked = useRef<PickedWallet | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await api<WalletInfo>("/api/wallet");
      if (r.ok) setInfo(r.data);
    } catch {
      // offline: keep what we have
    }
  }, []);

  useEffect(() => {
    // read the wallet and session once after hydration: an effect, so server and client render the same first
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
    void pickWallet().then((w) => {
      picked.current = w;
      setHasWallet(Boolean(w));
      setWalletName(w?.name ?? null);
    });
  }, [refresh]);

  const disconnect = useCallback(async () => {
    await api("/api/auth/logout", {});
    setError(null);
    await refresh();
    setVersion((v) => v + 1);
  }, [refresh]);

  // if the user switches account in the wallet, the old session no longer matches: sign out
  useEffect(() => {
    const eth = picked.current?.provider;
    if (!eth?.on) return;
    const onAccounts = () => void disconnect();
    eth.on("accountsChanged", onAccounts);
    return () => eth.removeListener?.("accountsChanged", onAccounts);
  }, [disconnect, walletName]);

  const connect = useCallback(async () => {
    setError(null);
    try {
      setBusy("connecting");
      const w = picked.current ?? (await pickWallet());
      if (!w) {
        setError("No wallet found in this browser. Install MetaMask (or another EVM wallet), then reload.");
        return;
      }
      picked.current = w;
      setWalletName(w.name);
      const eth = w.provider;
      const accounts = (await eth.request({ method: "eth_requestAccounts" })) as string[];
      const address = accounts[0];
      if (!address) throw new Error("the wallet returned no account");
      const cfg = info ?? (await api<WalletInfo>("/api/wallet")).data;
      await ensureHederaChain(eth, cfg.chainId, cfg.rpcUrl);

      setBusy("signing");
      const n = await api<{ nonce: string; message: string }>("/api/auth/nonce", { address });
      if (!n.ok) throw new Error(n.data.message ?? n.data.error ?? "could not start sign-in");
      const signature = (await eth.request({ method: "personal_sign", params: [n.data.message, address] })) as string;
      const v = await api<{ address: string }>("/api/auth/verify", { address, nonce: n.data.nonce, signature });
      if (!v.ok) throw new Error(v.data.message ?? v.data.error ?? "sign-in failed");
      await refresh();
      setVersion((x) => x + 1);
    } catch (e) {
      setError(errMessage(e, "could not connect the wallet"));
    } finally {
      setBusy("idle");
    }
  }, [info, refresh]);

  const deposit = useCallback<Ctx["deposit"]>(
    async (amountHbar, onStatus) => {
      const eth = (picked.current ?? (await pickWallet()))?.provider;
      if (!eth) throw new Error("No wallet found in this browser.");
      if (!info?.authenticated || !info.address || !info.depositAddress) throw new Error("Connect your wallet first.");
      if (!(amountHbar >= 0.01)) throw new Error("The minimum deposit is 0.01 HBAR.");
      await ensureHederaChain(eth, info.chainId, info.rpcUrl);
      onStatus("confirm");
      // an ordinary value transfer: on the JSON-RPC side 1 HBAR is 1e18, which is what parseEther produces
      const txHash = (await eth.request({ method: "eth_sendTransaction", params: [{ from: info.address, to: info.depositAddress, value: toHex(parseEther(String(amountHbar))) }] })) as string;
      onStatus("waiting");
      for (let i = 0; i < 40; i++) {
        const r = await api<{ creditedHbar: string; balanceHbar: string; receiptId: string; receiptUrl: string }>("/api/wallet/deposit", { txHash });
        if (r.ok) {
          await refresh();
          setVersion((x) => x + 1);
          return { txHash, creditedHbar: r.data.creditedHbar, balanceHbar: r.data.balanceHbar, receiptId: r.data.receiptId, receiptUrl: r.data.receiptUrl };
        }
        if (r.data.error === "already_credited") {
          await refresh();
          throw new Error("That deposit was already credited.");
        }
        if (r.data.error !== "pending" && r.data.error !== "not_found") throw new Error(r.data.message ?? r.data.error ?? "the deposit could not be verified");
        await new Promise((res) => setTimeout(res, 2000));
      }
      throw new Error(`The deposit was sent (${txHash.slice(0, 10)}…) but is not confirmed yet. Reload in a minute: it will be credited.`);
    },
    [info, refresh],
  );

  const value = useMemo<Ctx>(() => ({ info, busy, error, hasWallet, version, connect, disconnect, refresh, bump: () => setVersion((v) => v + 1), deposit }), [info, busy, error, hasWallet, version, connect, disconnect, refresh, deposit]);
  return <WalletCtx.Provider value={value}>{children}</WalletCtx.Provider>;
}
