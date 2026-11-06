"use client";

import Link from "next/link";
import { useWallet } from "./wallet-provider";
import { shortAddr } from "@/lib/ui/format";

/** The nav button: "Connect wallet" when signed out; the address and prepaid balance (with a menu) when signed in. */
export function WalletButton() {
  const { info, busy, hasWallet, connect, disconnect } = useWallet();

  if (!info?.authenticated || !info.address) {
    return (
      <button type="button" onClick={connect} disabled={busy !== "idle"} className="btn-primary !h-9 !px-5 text-sm disabled:opacity-60" title={hasWallet ? undefined : "Install MetaMask or another EVM wallet to connect"}>
        {busy === "connecting" ? "Connecting…" : busy === "signing" ? "Sign in your wallet…" : "Connect wallet"}
      </button>
    );
  }
  return (
    <details className="relative">
      <summary className="flex h-9 cursor-pointer list-none items-center gap-2 rounded-full border border-line bg-surface pl-3 pr-1 text-sm shadow-[var(--shadow-border)]">
        <span className="font-mono text-xs">{shortAddr(info.address)}</span>
        {info.walletBalanceHbar !== null && <span className="tabular-nums text-xs text-muted" title="HBAR in your wallet">{info.walletBalanceHbar} HBAR</span>}
        <span className="rounded-full bg-accent-muted px-2.5 py-1 text-xs font-medium text-accent tabular-nums" title="Prepaid credit for the Mesh agent">{info.balanceHbar} credit</span>
      </summary>
      <div className="absolute right-0 z-50 mt-2 w-56 rounded-2xl bg-surface p-2 text-sm shadow-[var(--shadow-border),var(--shadow-elevated)]">
        <dl className="space-y-1 px-3 py-2 text-xs">
          <div className="flex justify-between gap-3">
            <dt className="text-muted">In your wallet</dt>
            <dd className="tabular-nums">{info.walletBalanceHbar === null ? "unavailable" : `${info.walletBalanceHbar} HBAR`}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-muted">Prepaid credit</dt>
            <dd className="tabular-nums">{info.balanceHbar} HBAR</dd>
          </div>
        </dl>
        <Link href="/app" className="block rounded-xl px-3 py-2 hover:bg-background">
          Dashboard
        </Link>
        <button type="button" onClick={disconnect} className="block w-full rounded-xl px-3 py-2 text-left text-muted hover:bg-background hover:text-foreground">
          Disconnect
        </button>
      </div>
    </details>
  );
}
