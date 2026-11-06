"use client";

import { useEffect, useState } from "react";
import type { JobViewState } from "@/lib/ui/job-view";
import { formatPayment, hashscan, shortAddr } from "@/lib/ui/format";

interface PublicConfig {
  hcsTopicId: string | null;
}

/**
 * "Proof and receipt": the evidence trail for a job in one place. Each row links to something a third party can open:
 * the x402 payment on HashScan, the World approval, the verifier's sample and verdict, the Hedera Consensus Service log,
 * and the receipt the contract holds.
 */
export function JobProof({ state }: { state: JobViewState }) {
  const [cfg, setCfg] = useState<PublicConfig | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/config")
      .then((r) => (r.ok ? (r.json() as Promise<PublicConfig>) : null))
      .then((c) => !cancelled && setCfg(c))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const job = state.job;
  if (!job) return null;
  const p = state.payment;
  const sample = state.sample;
  const seqs = state.hcsSequence;

  return (
    <section className="rounded-lg border border-zinc-400/30 p-4" aria-label="Proof and receipt">
      <h2 className="mb-3 text-sm font-semibold">Proof and receipt</h2>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
        <dt className="text-zinc-500">Payment</dt>
        <dd>
          {p && p.transaction ? (
            <>
              {formatPayment(p.amount, p.asset)} over x402
              {p.payer && <span className="text-zinc-500"> from {p.payer}</span>}
              {" · "}
              <a href={hashscan.hederaTx(p.transaction)} target="_blank" rel="noreferrer" className="text-accent underline underline-offset-2">
                HashScan
              </a>
            </>
          ) : (
            <span className="text-zinc-500">{state.status === "created" ? "waiting for payment" : "development payment (no x402)"}</span>
          )}
        </dd>

        <dt className="text-zinc-500">Human approval</dt>
        <dd>{state.approvalId ? <span title={state.approvalId}>approved in World · {state.approvalId.slice(0, 8)}…</span> : <span className="text-zinc-500">not needed (under the threshold)</span>}</dd>

        <dt className="text-zinc-500">Spot-check</dt>
        <dd>
          {sample && sample.k > 0 ? (
            <span title={sample.indices.join(", ")}>
              {sample.k} of {state.total} tiles recomputed
            </span>
          ) : (
            <span className="text-zinc-500">after the claim is posted</span>
          )}
        </dd>

        <dt className="text-zinc-500">Verdict</dt>
        <dd>
          {state.verdict === "ok" ? (
            <span className="text-emerald-400">all sampled tiles match</span>
          ) : state.verdict === "fraud" ? (
            <span className="text-danger">fraud proven</span>
          ) : (
            <span className="text-zinc-500">pending</span>
          )}
        </dd>

        <dt className="text-zinc-500">Audit log</dt>
        <dd>
          {cfg?.hcsTopicId && seqs.length > 0 ? (
            <>
              {seqs.length} message{seqs.length === 1 ? "" : "s"} on Hedera{" · "}
              <a href={hashscan.topic(cfg.hcsTopicId)} target="_blank" rel="noreferrer" className="text-accent underline underline-offset-2" title={`sequence numbers: ${seqs.join(", ")}`}>
                topic {cfg.hcsTopicId}
              </a>
            </>
          ) : cfg?.hcsTopicId ? (
            <span className="text-zinc-500">publishing…</span>
          ) : (
            <span className="text-zinc-500">not configured</span>
          )}
        </dd>

        <dt className="text-zinc-500">Requester</dt>
        <dd className="font-mono text-xs">{shortAddr(job.requester)}</dd>

        <dt className="text-zinc-500">Receipt</dt>
        <dd>
          <a href={`/api/receipts/${job.jobId}`} target="_blank" rel="noreferrer" className="text-accent underline underline-offset-2">
            open as JSON
          </a>
          <span className="text-zinc-500"> · read from the contract</span>
        </dd>
      </dl>
    </section>
  );
}
