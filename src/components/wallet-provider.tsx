"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { parseEther, toHex } from "viem";
import { confirmDeposit, DepositNotConfirmedError, DepositRejectedError, ensureHederaChain, requestWalletAccount, signWalletLogin } from "./wallet-connect";
import type { ConfirmedDeposit } from "./wallet-connect";
import { pickWallet } from "./wallet-discovery";
import type { PickedWallet } from "./wallet-discovery";

/**
 * Wallet state for the whole site. Any EIP-1193 wallet (MetaMask and friends): connect, sign a plain message to sign in
 * (no transaction, no gas, and no network switch), and send a normal HBAR transfer to deposit credit. The network switch
 * happens only for that transfer, because it is what makes the wallet talk to the JSON-RPC relay. We never see a key.
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
  /** Pass `existingTxHash` to ask about a transfer that was already sent, without sending another one. */
  deposit: (amountHbar: number, onStatus: (s: "confirm" | "waiting") => void, existingTxHash?: string) => Promise<DepositResult>;
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
      const address = await requestWalletAccount(w.provider);
      // Login does not switch networks. wallet_switchEthereumChain waits on the JSON-RPC relay inside the wallet.
      setBusy("signing");
      await signWalletLogin(w.provider, address, (url, body) => api(url, body));
      await refresh();
      setVersion((x) => x + 1);
    } catch (e) {
      setError(errMessage(e, "could not connect the wallet"));
    } finally {
      setBusy("idle");
    }
  }, [refresh]);

  const deposit = useCallback<Ctx["deposit"]>(
    async (amountHbar, onStatus, existingTxHash) => {
      if (!info?.authenticated || !info.address) throw new Error("Connect your wallet first.");
      let txHash = existingTxHash;
      if (!txHash) {
        const eth = (picked.current ?? (await pickWallet()))?.provider;
        if (!eth) throw new Error("No wallet found in this browser.");
        if (!info.depositAddress) throw new Error("Connect your wallet first.");
        if (!(amountHbar >= 0.01)) throw new Error("The minimum deposit is 0.01 HBAR.");
        await ensureHederaChain(eth, info.chainId, info.rpcUrl);
        onStatus("confirm");
        // an ordinary value transfer: on the JSON-RPC side 1 HBAR is 1e18, which is what parseEther produces
        txHash = (await eth.request({ method: "eth_sendTransaction", params: [{ from: info.address, to: info.depositAddress, value: toHex(parseEther(String(amountHbar))) }] })) as string;
      }
      onStatus("waiting");
      let confirmed: ConfirmedDeposit;
      try {
        confirmed = await confirmDeposit(txHash, (url, body) => api(url, body));
      } catch (e) {
        // The transfer was already broadcast. Refresh credit in case an earlier check landed, then keep the hash for the caller.
        if (e instanceof DepositNotConfirmedError || e instanceof DepositRejectedError) await refresh();
        throw e;
      }
      await refresh();
      setVersion((x) => x + 1);
      return { txHash, creditedHbar: confirmed.creditedHbar, balanceHbar: confirmed.balanceHbar, receiptId: confirmed.receiptId, receiptUrl: confirmed.receiptUrl };
    },
    [info, refresh],
  );

  const value = useMemo<Ctx>(() => ({ info, busy, error, hasWallet, version, connect, disconnect, refresh, bump: () => setVersion((v) => v + 1), deposit }), [info, busy, error, hasWallet, version, connect, disconnect, refresh, deposit]);
  return <WalletCtx.Provider value={value}>{children}</WalletCtx.Provider>;
}
