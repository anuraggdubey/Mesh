"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useWallet } from "./wallet-provider";

interface Row {
  receiptId: string;
  type: "deposit" | "job_payment" | "refund";
  title: string;
  amountHbar: string;
  direction: "credit" | "debit";
  issuedAt: number;
  status: string;
  statusTone: "ok" | "pending" | "bad";
  page: string;
}

const TONE = { ok: "text-emerald-700 bg-emerald-500/10", pending: "text-amber-700 bg-amber-500/10", bad: "text-red-700 bg-red-500/10" } as const;

/** The signed-in wallet's receipts, newest first. Reloads whenever money moves. */
export function ReceiptsList() {
  const { info, version } = useWallet();
  const [rows, setRows] = useState<Row[] | null>(null);
  const signedIn = Boolean(info?.authenticated);

  useEffect(() => {
    if (!signedIn) return;
    let stop = false;
    fetch("/api/wallet/receipts")
      .then((r) => (r.ok ? r.json() : { receipts: [] }))
      .then((b: { receipts: Row[] }) => !stop && setRows(b.receipts))
      .catch(() => !stop && setRows([]));
    return () => {
      stop = true;
    };
  }, [signedIn, version]);

  if (!signedIn) return null;
  return (
    <section className="card p-5" aria-label="Receipts">
      <h2 className="mb-3 text-sm font-medium">Receipts</h2>
      {rows === null ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted">Nothing yet. A receipt appears here for every deposit, job payment and refund.</p>
      ) : (
        <ul className="divide-y divide-line">
          {rows.map((r) => (
            <li key={r.receiptId}>
              <Link href={r.page} className="flex items-center gap-3 py-2.5 text-sm transition hover:opacity-80">
                <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-full text-base ${r.direction === "credit" ? "bg-emerald-500/10 text-emerald-700" : "bg-accent-muted text-accent"}`} aria-hidden="true">
                  {r.direction === "credit" ? "+" : "−"}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{r.title}</span>
                  <span className="block text-xs text-muted">{new Date(r.issuedAt * 1000).toLocaleString()}</span>
                </span>
                <span className="text-right">
                  <span className="block font-mono text-xs tabular-nums">
                    {r.direction === "credit" ? "+" : "−"}
                    {r.amountHbar} HBAR
                  </span>
                  <span className={`mt-0.5 inline-block rounded-full px-2 py-0.5 text-[11px] ${TONE[r.statusTone]}`}>{r.status}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
