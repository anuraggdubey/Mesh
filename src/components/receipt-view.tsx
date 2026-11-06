"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { Logo } from "./site/logo";
import { OgBadge } from "./og-badge";
import type { Verification } from "./og-badge";

interface Receipt {
  receiptId: string;
  type: "deposit" | "job_payment" | "refund";
  title: string;
  description: string;
  status: string;
  statusTone: "ok" | "pending" | "bad";
  wallet: string;
  issuedAt: number;
  issuedAtIso: string;
  amountHbar: string;
  direction: "credit" | "debit";
  transactions: { label: string; hash: string; url: string }[];
  job: { jobId: string; status: string; page: string; api: string } | null;
  plan: { source: "og" | "manual"; preset: string; reason: string | null; request: string | null; og: { requestId: string; provider: string | null; model: string | null; teeVerified: boolean | null; verification: Verification } | null } | null;
  hcs: { topicId: string; sequences: number[]; url: string } | null;
  relatedReceiptId: string | null;
  shareToken?: string;
}

const TONE = { ok: "bg-emerald-500/10 text-emerald-700", pending: "bg-amber-500/10 text-amber-700", bad: "bg-red-500/10 text-red-700" } as const;
const TYPE_LABEL = { deposit: "Deposit", job_payment: "Job payment", refund: "Refund" } as const;

type State = { name: "loading" } | { name: "ready"; receipt: Receipt } | { name: "missing" } | { name: "error"; message: string };

/** A payment receipt: clean on screen, printable (the site chrome is hidden when printing), shareable by a link that carries a token. */
export function ReceiptView({ receiptId }: { receiptId: string }) {
  const share = useSearchParams().get("share");
  const [state, setState] = useState<State>({ name: "loading" });
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let stop = false;
    fetch(`/api/receipts/by-id/${receiptId}${share ? `?share=${encodeURIComponent(share)}` : ""}`)
      .then(async (r) => {
        if (r.status === 404) return !stop && setState({ name: "missing" });
        if (!r.ok) return !stop && setState({ name: "error", message: `Could not load the receipt (${r.status}).` });
        const receipt = (await r.json()) as Receipt;
        if (!stop) setState({ name: "ready", receipt });
      })
      .catch(() => !stop && setState({ name: "error", message: "Could not reach the server." }));
    return () => {
      stop = true;
    };
  }, [receiptId, share]);

  if (state.name === "loading") return <p className="text-sm text-muted">Loading receipt…</p>;
  if (state.name === "missing") {
    return (
      <div className="card mx-auto max-w-xl p-8 text-center" role="alert">
        <h1 className="text-xl font-medium">Receipt not found</h1>
        <p className="mt-2 text-sm text-muted">It does not exist, or it belongs to another wallet. Connect the wallet that made it, or open the share link its owner sent you.</p>
        <Link href="/app" className="btn-primary mt-5">
          Go to the dashboard
        </Link>
      </div>
    );
  }
  if (state.name === "error") {
    return (
      <p role="alert" className="text-sm text-red-600">
        {state.message}
      </p>
    );
  }

  const r = state.receipt;
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const token = r.shareToken ?? share ?? null;
  const shareUrl = `${origin}/receipts/${r.receiptId}${token ? `?share=${token}` : ""}`;
  const jsonUrl = `/api/receipts/by-id/${r.receiptId}${token && !r.shareToken ? `?share=${token}` : ""}`;
  const sign = r.direction === "credit" ? "+" : "−";

  async function copy() {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard blocked: the link is in the address bar and in the field below
    }
  }

  return (
    <div className="mx-auto max-w-2xl">
      <article className="card p-8 print:shadow-none print:ring-1 print:ring-black/15" aria-label={`Receipt ${r.receiptId}`}>
        <header className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <Logo tile />
            <div>
              <p className="font-display text-base font-medium leading-tight">Mesh</p>
              <p className="text-xs text-muted">{TYPE_LABEL[r.type]} receipt</p>
            </div>
          </div>
          <span className={`rounded-full px-3 py-1 text-xs font-medium ${TONE[r.statusTone]}`}>{r.status}</span>
        </header>

        <div className="mt-8 border-y border-line py-6">
          <p className="text-sm text-muted">{r.title}</p>
          <p className="mt-1 font-display text-4xl font-normal tracking-tight tabular-nums">
            {sign}
            {r.amountHbar} <span className="text-xl text-muted">HBAR</span>
          </p>
          <p className="mt-3 text-sm leading-relaxed text-muted">{r.description}</p>
        </div>

        <dl className="mt-6 grid grid-cols-[110px_1fr] gap-x-4 gap-y-4 text-sm">
          <dt className="text-muted">Receipt no.</dt>
          <dd className="break-all font-mono text-xs">{r.receiptId}</dd>

          <dt className="text-muted">Date</dt>
          <dd>
            <span className="block">{r.issuedAtIso.replace("T", " ").replace(".000Z", " UTC")}</span>
            <span className="block text-xs text-muted">{new Date(r.issuedAt * 1000).toLocaleString(undefined, { dateStyle: "full", timeStyle: "long" })} (your time)</span>
          </dd>

          <dt className="text-muted">Wallet</dt>
          <dd className="break-all font-mono text-xs">{r.wallet}</dd>

          {r.job && (
            <>
              <dt className="text-muted">Job</dt>
              <dd>
                <Link href={r.job.page} className="break-all font-mono text-xs text-accent underline underline-offset-2">
                  {r.job.jobId}
                </Link>
                <span className="ml-2 text-xs text-muted">({r.job.status})</span>
              </dd>
            </>
          )}

          {r.plan && (
            <>
              <dt className="text-muted">Planned by</dt>
              <dd>
                {r.plan.og ? (
                  <>
                    <span className="inline-flex flex-wrap items-center gap-2">
                      0G {r.plan.og.model ?? "model"} <OgBadge verification={r.plan.og.verification} />
                    </span>
                    <span className="mt-1 block break-all font-mono text-[11px] text-muted">request {r.plan.og.requestId}</span>
                  </>
                ) : (
                  <span className="text-muted">Chosen by you (not 0G)</span>
                )}
                <span className="mt-1 block text-xs text-muted">
                  {r.plan.preset} render{r.plan.reason ? `: ${r.plan.reason}` : ""}
                </span>
                {r.plan.request && <span className="mt-1 block text-xs italic text-muted">&ldquo;{r.plan.request}&rdquo;</span>}
              </dd>
            </>
          )}

          {r.relatedReceiptId && (
            <>
              <dt className="text-muted">Returns</dt>
              <dd>
                <Link href={`/receipts/${r.relatedReceiptId}${token ? `?share=${token}` : ""}`} className="text-accent underline underline-offset-2">
                  the payment this refund returns
                </Link>
              </dd>
            </>
          )}
        </dl>

        {r.transactions.length > 0 && (
          <section className="mt-7" aria-label="Transactions">
            <h2 className="text-sm font-medium">Transactions</h2>
            <ul className="mt-3 space-y-2.5">
              {r.transactions.map((t) => (
                <li key={t.label + t.hash} className="rounded-xl bg-surface-2 px-3 py-2">
                  <p className="text-xs text-muted">{t.label}</p>
                  <a href={t.url} target="_blank" rel="noreferrer" className="break-all font-mono text-xs text-accent underline underline-offset-2">
                    {t.hash}
                  </a>
                </li>
              ))}
            </ul>
          </section>
        )}

        {r.hcs && (
          <section className="mt-6 text-sm" aria-label="Audit log">
            <h2 className="text-sm font-medium">Audit log on Hedera</h2>
            <p className="mt-1 text-xs text-muted">
              {r.hcs.sequences.length} message{r.hcs.sequences.length === 1 ? "" : "s"} (sequence {r.hcs.sequences.join(", ")}) on{" "}
              <a href={r.hcs.url} target="_blank" rel="noreferrer" className="text-accent underline underline-offset-2">
                topic {r.hcs.topicId}
              </a>
            </p>
          </section>
        )}

        <p className="mt-6 text-xs text-muted print:hidden">
          Machine-readable:{" "}
          <a href={jsonUrl} target="_blank" rel="noreferrer" className="text-accent underline underline-offset-2">
            this receipt (JSON)
          </a>
          {r.job && (
            <>
              {" · "}
              <a href={r.job.api} target="_blank" rel="noreferrer" className="text-accent underline underline-offset-2">
                the job&apos;s on-chain receipt (JSON)
              </a>
            </>
          )}
        </p>

        <footer className="mt-8 border-t border-line pt-4 text-[11px] leading-relaxed text-muted">
          This is a Hedera <strong>testnet</strong> receipt. The HBAR involved is test money with no value, and this page is not an invoice or a tax document. Every transaction above can be checked on HashScan.
        </footer>
      </article>

      <div className="no-print mt-5 flex flex-wrap items-center gap-3 print:hidden">
        <button type="button" onClick={() => window.print()} className="btn-primary !h-10 text-sm">
          Print / Save as PDF
        </button>
        <button type="button" onClick={copy} className="btn-secondary !h-10 text-sm">
          {copied ? "Link copied" : "Copy link"}
        </button>
        <Link href="/app" className="text-sm text-muted hover:text-foreground">
          Back to the dashboard
        </Link>
      </div>
      {r.shareToken && <p className="no-print mt-3 text-xs text-muted print:hidden">The copied link includes a private share token: anyone who has it can read this one receipt.</p>}
    </div>
  );
}
