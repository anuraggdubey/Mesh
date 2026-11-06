"use client";

import type { JobViewState } from "@/lib/ui/job-view";
import { hashscan, shortAddr, shortHash } from "@/lib/ui/format";

const isTxHash = (v: string | null): v is string => !!v && /^0x[0-9a-fA-F]{64}$/.test(v);

function TxLink({ tx, label }: { tx: string | null; label: string }) {
  if (isTxHash(tx)) {
    return (
      <a href={hashscan.tx(tx)} target="_blank" rel="noreferrer" className="text-accent underline underline-offset-2">
        {label}
      </a>
    );
  }
  return <span className="text-muted">{tx ? "done on chain" : "waiting"}</span>;
}

/**
 * The cheat-caught view: what the verifier proved, then the three consequences in order (fraud proof on chain, the provider's
 * stake slashed, the requester refunded). Shown only when the verifier reported fraud or the job is on the fraud path.
 */
export function FraudPanel({ state }: { state: JobViewState }) {
  const status = state.status;
  const onFraudPath = state.verdict === "fraud" || status === "rejected" || status === "slashed";
  if (!onFraudPath) return null;

  const f = state.fraud;
  const slashed = state.settlement === "slashed" || state.settlement === "refunded" || status === "slashed" || status === "refunded";
  const refunded = state.settlement === "refunded" || status === "refunded";

  const steps = [
    { done: true, title: "Fraud proven", body: f ? `Tile ${f.tileIndex} does not match the verifier's recompute.` : "The verifier's recompute does not match a claimed tile.", extra: <TxLink tx={state.fraudTx} label="fraud proof on HashScan" /> },
    { done: slashed, title: "Provider slashed", body: "The cheating provider's stake is taken: 50% to the requester, 25% to the verifier, 25% retained.", extra: null },
    { done: refunded, title: "Requester refunded", body: "The payment held in escrow goes back to the requester in the same transaction.", extra: <TxLink tx={state.refundTx ?? state.fraudTx} label="transaction" /> },
  ];

  return (
    <section aria-label="Cheat caught" className="overflow-hidden rounded-2xl border border-danger/50 bg-[#fff6f5]">
      <div className="flex items-center gap-3 border-b border-danger/30 px-5 py-3">
        <span className="h-2 w-2 rounded-full bg-danger shadow-[0_0_10px_var(--danger)]" />
        <h2 className="text-sm font-semibold uppercase tracking-widest text-danger">Cheat caught</h2>
      </div>
      <div className="grid gap-6 p-5 lg:grid-cols-[1.1fr_1fr]">
        <div>
          {f ? (
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
              <dt className="text-muted">Tile</dt>
              <dd className="font-mono">{f.tileIndex}</dd>
              <dt className="text-muted">Provider</dt>
              <dd>
                <a href={hashscan.address(f.owner)} target="_blank" rel="noreferrer" className="font-mono underline underline-offset-2">
                  {shortAddr(f.owner)}
                </a>
              </dd>
              <dt className="text-muted">Verifier computed</dt>
              <dd className="font-mono text-xs text-emerald-600" title={f.expectedTileHash}>
                {shortHash(f.expectedTileHash, 20)}
              </dd>
              <dt className="text-muted">Provider claimed</dt>
              <dd className="font-mono text-xs text-danger" title={f.claimedTileHash}>
                {shortHash(f.claimedTileHash, 20)}
              </dd>
            </dl>
          ) : (
            <p className="text-sm text-muted">The contract recorded the fraud proof. The tile details were not reported to the API.</p>
          )}
          <p className="mt-4 text-xs leading-relaxed text-muted">
            The provider signed a claim over this tile before the check. The verifier recomputed it from the same pinned image and input, so the mismatch is provable by anyone.
          </p>
        </div>
        <ol className="space-y-3">
          {steps.map((s, i) => (
            <li key={s.title} className="flex gap-3">
              <span className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full text-[11px] font-semibold ${s.done ? "bg-danger text-white" : "border border-line text-muted"}`}>{i + 1}</span>
              <div className="text-sm">
                <p className={s.done ? "font-medium" : "font-medium text-muted"}>{s.title}</p>
                <p className="mt-0.5 text-xs leading-relaxed text-muted">{s.body}</p>
                {s.done && s.extra && <p className="mt-1 text-xs">{s.extra}</p>}
              </div>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
