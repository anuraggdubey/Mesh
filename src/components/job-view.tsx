"use client";

import Link from "next/link";
import { useEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore } from "react";
import { isTerminal } from "@/lib/state-machine";
import { colorizeTile } from "@/lib/ui/colorize";
import { formatDuration, formatToken, hashscan, shortAddr, shortHash } from "@/lib/ui/format";
import { buildTimeline, initialViewState, ownerTileCounts, reduceJobView, renderGeometry } from "@/lib/ui/job-view";
import type { Job } from "@/lib/types";
import { AiReview } from "./ai-review";
import { FraudPanel } from "./fraud-panel";
import { JobProof } from "./job-proof";
import { StatusBadge } from "./status-badge";
import { StatusTimeline } from "./status-timeline";
import { PROVIDER_COLORS, providerColor, TileImage } from "./tile-image";

const EVENT_NAMES = ["status", "assigned", "tile", "progress", "claim", "chain", "payment", "approval", "sample", "verdict", "settlement", "inference", "error"];
const isTxHash = (v: string) => /^0x[0-9a-fA-F]{64}$/.test(v);

// A once-per-second clock. The server snapshot is a constant (0) so nothing time-dependent is evaluated during
// prerender (Cache Components forbids Date.now() there); the client takes over after hydration.
const subscribeClock = (cb: () => void) => {
  const t = setInterval(cb, 1000);
  return () => clearInterval(t);
};
const clientNow = () => Math.floor(Date.now() / 1000);
const serverNow = () => 0;
function useNow() {
  return useSyncExternalStore(subscribeClock, clientNow, serverNow);
}

export function JobView({ jobId }: { jobId: string }) {
  const [state, dispatch] = useReducer(reduceJobView, initialViewState);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawn = useRef<Set<number>>(new Set());
  const now = useNow();

  const jobLoaded = state.job !== null;
  const terminal = state.status ? isTerminal(state.status) : false;
  const geo = useMemo(() => (state.job ? renderGeometry(state.job) : null), [state.job]);

  // 1. snapshot
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/jobs/${jobId}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(r.status === 404 ? "Job not found" : `Could not load job (${r.status})`);
        return (await r.json()) as Job;
      })
      .then((job) => !cancelled && dispatch({ type: "snapshot", job }))
      .catch((e: Error) => !cancelled && setLoadError(e.message));
    return () => {
      cancelled = true;
    };
  }, [jobId]);

  // 2. live events (the server replays history first; the reducer ignores ids it already applied)
  useEffect(() => {
    if (!jobLoaded || terminal) return;
    const es = new EventSource(`/api/jobs/${jobId}/events`);
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    for (const name of EVENT_NAMES) {
      es.addEventListener(name, (e) => {
        const m = e as MessageEvent<string>;
        try {
          dispatch({ type: "event", id: Number(m.lastEventId), name, data: JSON.parse(m.data) });
        } catch {
          // ignore a malformed event
        }
      });
    }
    return () => {
      es.close();
      setConnected(false);
    };
  }, [jobId, jobLoaded, terminal]);

  // 3. paint each tile onto the canvas as soon as it is uploaded
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!geo || !canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    state.tiles.forEach((t, i) => {
      if (t.status !== "uploaded" || drawn.current.has(i)) return;
      drawn.current.add(i);
      fetch(`/api/jobs/${jobId}/tiles/${i}`)
        .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error("tile fetch failed"))))
        .then((buf) => {
          if (buf.byteLength !== geo.tileW * geo.tileH * 2) throw new Error("unexpected tile size");
          const rgba = colorizeTile(new Uint8Array(buf), geo.maxIter);
          const image = new ImageData(new Uint8ClampedArray(rgba), geo.tileW, geo.tileH);
          ctx.putImageData(image, (i % geo.gridCols) * geo.tileW, Math.floor(i / geo.gridCols) * geo.tileH);
        })
        .catch(() => drawn.current.delete(i)); // retried the next time tiles change
    });
  }, [state.tiles, geo, jobId]);

  if (loadError) {
    return (
      <div role="alert" className="rounded-lg border border-red-500/40 bg-red-500/10 p-4 text-sm">
        <p className="font-medium text-red-700 dark:text-red-300">{loadError}</p>
        <Link href="/" className="mt-2 inline-block underline">
          Back to start
        </Link>
      </div>
    );
  }
  if (!state.job || !geo) return <p className="text-sm text-zinc-500">Loading job…</p>;

  const job = state.job;
  const steps = buildTimeline(state.status, state.statuses);
  const counts = ownerTileCounts(state.tiles);
  const doneBy: Record<string, number> = {};
  for (const t of state.tiles) if (t.owner && t.status === "uploaded") doneBy[t.owner] = (doneBy[t.owner] ?? 0) + 1;
  const pct = state.total ? Math.round((state.done / state.total) * 100) : 0;
  const awaitingPayment = state.status === "created";
  const elapsed = now === 0 ? 0 : Math.max(0, now - job.createdAt);
  const windowLeft = state.windowEnd && now !== 0 ? Math.max(0, state.windowEnd - now) : null;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">Render job</h1>
        <StatusBadge status={state.status ?? job.status} />
        <span className="font-mono text-xs text-zinc-500" title={job.jobId}>
          {job.jobId.slice(0, 10)}…{job.jobId.slice(-6)}
        </span>
        <span className="ml-auto flex items-center gap-2 text-xs text-zinc-500">
          <span className={`h-2 w-2 rounded-full ${connected ? "bg-emerald-500" : terminal ? "bg-zinc-400" : "bg-amber-500"}`} />
          {terminal ? "finished" : connected ? "live" : "connecting…"}
          {!terminal && <span>· {formatDuration(elapsed)}</span>}
        </span>
      </header>

      <StatusTimeline steps={steps} />

      <FraudPanel state={state} />

      {awaitingPayment && (
        <div role="status" className="rounded-lg border border-sky-500/40 bg-sky-500/10 p-4 text-sm">
          <p className="font-medium">Waiting for payment</p>
          <p className="mt-1 text-zinc-600 dark:text-zinc-300">
            This job costs <b>{formatToken(job.price)}</b>. It starts as soon as its x402 payment settles on Hedera. Jobs are paid by an agent or client that can sign a
            Hedera payment (<code>npm run agent</code>), so a job that was never paid expires after a few minutes.
          </p>
        </div>
      )}

      {state.error && (
        <div role="alert" className="rounded-lg border border-red-500/40 bg-red-500/10 p-4 text-sm">
          <p className="font-medium text-red-700 dark:text-red-300">Job problem: {state.error.code}</p>
          {state.error.message && <p className="mt-1">{state.error.message}</p>}
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <section aria-label="Render">
          <TileImage
            canvasRef={canvasRef}
            width={geo.width}
            height={geo.height}
            gridCols={geo.gridCols}
            gridRows={geo.gridRows}
            tiles={state.tiles}
            providers={state.providers}
            flagged={state.fraud ? [state.fraud.tileIndex] : []}
          />
          <div className="mt-3">
            <div className="mb-1 flex justify-between text-xs text-zinc-500">
              <span>
                {state.done} / {state.total} tiles
              </span>
              <span>{pct}%</span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-zinc-400/20" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
              <div className="h-full bg-sky-500 transition-all duration-300" style={{ width: `${pct}%` }} />
            </div>
          </div>
        </section>

        <aside className="space-y-5">
          <section className="rounded-lg border border-zinc-400/30 p-4">
            <h2 className="mb-3 text-sm font-semibold">Providers</h2>
            {state.providers.length === 0 ? (
              <p className="text-sm text-zinc-500">{awaitingPayment ? "Not assigned yet." : "Waiting for an online provider…"}</p>
            ) : (
              <ul className="space-y-2">
                {state.providers.map((p, i) => (
                  <li key={p} className="flex items-center gap-2 text-sm">
                    <span className="h-3 w-3 shrink-0 rounded-sm" style={{ background: PROVIDER_COLORS[i % PROVIDER_COLORS.length] }} />
                    <a href={hashscan.address(p)} target="_blank" rel="noreferrer" className="font-mono underline-offset-2 hover:underline">
                      {shortAddr(p)}
                    </a>
                    <span className="ml-auto text-xs text-zinc-500">
                      {doneBy[p] ?? 0} / {counts[p] ?? 0} tiles
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="rounded-lg border border-zinc-400/30 p-4">
            <h2 className="mb-3 text-sm font-semibold">Verification</h2>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
              <dt className="text-zinc-500">Price</dt>
              <dd>{formatToken(job.price)}</dd>
              <dt className="text-zinc-500">Image</dt>
              <dd className="font-mono text-xs" title={job.imageDigest}>
                {shortHash(job.imageDigest.replace("sha256:", ""), 12)}
              </dd>
              <dt className="text-zinc-500">Input hash</dt>
              <dd className="font-mono text-xs" title={job.inputHash}>
                {shortHash(job.inputHash, 12)}
              </dd>
              <dt className="text-zinc-500">Merkle root</dt>
              <dd className="font-mono text-xs" title={state.merkleRoot ?? undefined}>
                {state.merkleRoot ? shortHash(state.merkleRoot, 16) : "after every provider signs"}
              </dd>
              <dt className="text-zinc-500">Escrow</dt>
              <dd>
                {state.lockTx && isTxHash(state.lockTx) ? (
                  <a href={hashscan.tx(state.lockTx)} target="_blank" rel="noreferrer" className="underline">
                    payment locked
                  </a>
                ) : state.lockTx ? (
                  "payment locked"
                ) : (
                  "-"
                )}
              </dd>
              <dt className="text-zinc-500">On-chain claim</dt>
              <dd>
                {state.claimTx && isTxHash(state.claimTx) ? (
                  <a href={hashscan.tx(state.claimTx)} target="_blank" rel="noreferrer" className="underline">
                    view on HashScan
                  </a>
                ) : state.claimTx ? (
                  "posted on chain"
                ) : state.merkleRoot ? (
                  <span className="text-amber-700 dark:text-amber-300">not posted yet</span>
                ) : (
                  "-"
                )}
              </dd>
              {state.settlement && (
                <>
                  <dt className="text-zinc-500">Settlement</dt>
                  <dd>
                    {state.settlement === "released" ? "providers paid" : state.settlement === "slashed" ? "provider slashed" : "refunded to requester"}
                    {state.finalTx && isTxHash(state.finalTx) && (
                      <>
                        {" · "}
                        <a href={hashscan.tx(state.finalTx)} target="_blank" rel="noreferrer" className="underline">
                          transaction
                        </a>
                      </>
                    )}
                  </dd>
                </>
              )}
              {windowLeft !== null && (
                <>
                  <dt className="text-zinc-500">Challenge window</dt>
                  <dd>{windowLeft > 0 ? `${windowLeft}s left` : "closed"}</dd>
                </>
              )}
            </dl>
          </section>

          <JobProof state={state} />

          <AiReview jobId={job.jobId} final={state.status === "final"} initial={job.inference} />

          <section className="rounded-lg border border-zinc-400/30 p-4">
            <h2 className="mb-3 text-sm font-semibold">Activity</h2>
            {state.log.length === 0 ? (
              <p className="text-sm text-zinc-500">No events yet.</p>
            ) : (
              <ul className="max-h-48 space-y-1 overflow-y-auto font-mono text-xs" aria-live="polite">
                {state.log.map((l) => (
                  <li key={l.id} className={l.kind === "bad" ? "text-red-600 dark:text-red-400" : l.kind === "good" ? "text-emerald-600 dark:text-emerald-400" : "text-zinc-600 dark:text-zinc-300"}>
                    {l.text}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </aside>
      </div>

      <footer className="flex flex-wrap items-center gap-4 text-xs text-zinc-500">
        <span>
          Requester <span className="font-mono">{shortAddr(job.requester)}</span>
        </span>
        <span>
          {geo.width}×{geo.height}, {geo.gridCols}×{geo.gridRows} tiles, {geo.maxIter} iterations
        </span>
        <span className="flex items-center gap-1">
          {state.providers.map((p) => (
            <span key={p} className="h-2 w-2 rounded-full" style={{ background: providerColor(state.providers, p) }} />
          ))}
        </span>
        <Link href="/" className="ml-auto underline">
          New job
        </Link>
      </footer>
    </div>
  );
}
