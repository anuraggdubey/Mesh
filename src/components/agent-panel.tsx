"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { hashscan } from "@/lib/ui/format";
import { OgBadge } from "./og-badge";
import type { Verification } from "./og-badge";
import { DepositNotConfirmedError, DepositRejectedError } from "./wallet-connect";
import { useWallet } from "./wallet-provider";

interface PlanOut {
  planId: string;
  source: "og" | "manual";
  preset: "tiny" | "small" | "full";
  price: string;
  priceHbar: string;
  reason: string | null;
  expiresAt: number;
  og: { requestId: string; provider: string | null; model: string | null; teeVerified: boolean | null; verification: Verification; signer: string | null } | null;
}

interface RunOut {
  runId: string;
  status: "queued" | "needs_approval" | "paying" | "paid" | "failed";
  preset: string;
  approvalUrl: string | null;
  userCode: string | null;
  jobId: string | null;
  paymentTx: string | null;
  receiptId: string | null;
  error: string | null;
}

const EXAMPLES = ["A quick test render to see how Mesh works", "A detailed render for a presentation slide", "The heaviest render you can do"];
const SIZES: { preset: "tiny" | "small" | "full"; label: string; note: string; price: string }[] = [
  { preset: "tiny", label: "Tiny", note: "4 tiles, a quick check", price: "0.1" },
  { preset: "small", label: "Small", note: "64 tiles, about 5 seconds", price: "0.5" },
  { preset: "full", label: "Full", note: "64 tiles, about 30 seconds", price: "1" },
];

async function post<T>(url: string, body: unknown): Promise<{ ok: boolean; status: number; data: T & { error?: string; message?: string; manual?: { presets: string[] } } }> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { ok: res.ok, status: res.status, data: (await res.json().catch(() => ({}))) as never };
}

/** The consumer flow: connect a wallet, deposit HBAR, ask the Mesh agent (planned by 0G), confirm, and watch the agent pay. */
export function AgentPanel() {
  const router = useRouter();
  const { info, busy, error: walletError, hasWallet, connect, deposit, refresh, bump } = useWallet();

  // deposit
  const [amount, setAmount] = useState("1");
  const [pendingTx, setPendingTx] = useState<string | null>(null);
  const [dep, setDep] = useState<{ stage: "idle" | "confirm" | "waiting" | "done" | "error"; message?: string; result?: { creditedHbar: string; receiptUrl: string; txHash: string } }>({ stage: "idle" });

  // plan
  const [prompt, setPrompt] = useState("");
  const [planning, setPlanning] = useState(false);
  const [plan, setPlan] = useState<PlanOut | null>(null);
  const [planError, setPlanError] = useState<{ message: string; manual: boolean } | null>(null);

  // run
  const [run, setRun] = useState<RunOut | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const redirected = useRef(false);

  const balance = info?.balanceTinybars ?? 0;
  const priceTinybars = plan ? Math.round(Number(plan.priceHbar) * 1e8) : 0;
  const enough = balance >= priceTinybars;

  // follow a run until it ends
  useEffect(() => {
    if (!run || run.status === "paid" || run.status === "failed") return;
    const id = setInterval(async () => {
      const r = await fetch(`/api/agent/runs/${run.runId}`).then((x) => x.json()).catch(() => null);
      if (r?.run) {
        setRun(r.run);
        if (r.run.status === "paid" || r.run.status === "failed") {
          void refresh();
          bump();
        }
      }
    }, 1500);
    return () => clearInterval(id);
  }, [run, refresh, bump]);

  // when the job exists, take the user to it
  useEffect(() => {
    if (run?.status === "paid" && run.jobId && !redirected.current) {
      redirected.current = true;
      const t = setTimeout(() => router.push(`/jobs/${run.jobId}`), 4000);
      return () => clearTimeout(t);
    }
  }, [run, router]);

  async function doDeposit() {
    setDep({ stage: pendingTx ? "waiting" : "confirm" });
    try {
      // A hash we already sent is only checked again. Deposit does not broadcast a second transfer.
      const r = await deposit(Number(amount), (s) => setDep({ stage: s }), pendingTx ?? undefined);
      setPendingTx(null);
      setDep({ stage: "done", result: { creditedHbar: r.creditedHbar, receiptUrl: r.receiptUrl, txHash: r.txHash } });
    } catch (e) {
      if (e instanceof DepositNotConfirmedError || e instanceof DepositRejectedError) {
        setPendingTx(e.txHash);
        setDep({ stage: "error", message: e.message });
        return;
      }
      setDep({ stage: "error", message: e instanceof Error ? e.message : "the deposit failed" });
    }
  }

  async function doPlan(body: { prompt: string } | { preset: string }) {
    setPlanError(null);
    setRun(null);
    setRunError(null);
    redirected.current = false;
    setPlanning(true);
    try {
      const r = await post<{ plan: PlanOut }>("/api/agent/plan", body);
      if (r.ok) setPlan(r.data.plan);
      else {
        setPlan(null);
        setPlanError({ message: r.data.message ?? r.data.error ?? "could not plan the job", manual: Boolean(r.data.manual) });
      }
    } finally {
      setPlanning(false);
    }
  }

  async function doRun() {
    if (!plan) return;
    setStarting(true);
    setRunError(null);
    try {
      const r = await post<{ run: RunOut }>("/api/agent/run", { planId: plan.planId });
      if (r.ok) setRun(r.data.run);
      else setRunError(r.data.message ?? r.data.error ?? "could not start the run");
    } finally {
      setStarting(false);
    }
  }

  // ───────── signed out ─────────
  if (!info?.authenticated) {
    return (
      <section className="card p-8 text-center" aria-label="Connect your wallet">
        <span className="icon-tile mx-auto" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5">
            <path d="M3 7a2 2 0 0 1 2-2h13v4" />
            <path d="M3 7v10a2 2 0 0 0 2 2h14a1 1 0 0 0 1-1v-3" />
            <path d="M17 12h4v4h-4a2 2 0 0 1 0-4z" />
          </svg>
        </span>
        <h2 className="mt-4 text-xl font-medium tracking-tight">Connect your wallet to start</h2>
        <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-muted">
          Connect an EVM wallet (MetaMask works), add a little test HBAR as credit, and tell the Mesh agent what you need. The agent plans the job with 0G, pays for it on Hedera, and
          gives you a receipt for every step. Signing in is free: it sends no transaction.
        </p>
        <button type="button" onClick={connect} disabled={busy !== "idle"} className="btn-primary mt-6 disabled:opacity-60">
          {busy === "connecting" ? "Connecting…" : busy === "signing" ? "Sign in your wallet…" : "Connect wallet"}
        </button>
        {!hasWallet && <p className="mt-3 text-xs text-muted">No wallet was found in this browser. Install MetaMask, then reload this page.</p>}
        {walletError && (
          <p role="alert" className="mt-3 text-sm text-red-600">
            {walletError}
          </p>
        )}
      </section>
    );
  }

  const running = run && run.status !== "paid" && run.status !== "failed";

  return (
    <div className="space-y-6">
      {/* ───────── balance and deposit ───────── */}
      <section className="card p-6" aria-label="Prepaid credit">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="eyebrow">Prepaid credit</p>
            <p className="mt-2 font-display text-4xl font-normal tracking-tight tabular-nums">
              {info.balanceHbar} <span className="text-lg text-muted">HBAR</span>
            </p>
            <p className="mt-1 text-xs text-muted">The agent pays your jobs from this. Test HBAR on Hedera testnet.</p>
            {info.address && info.depositAddress && info.address.toLowerCase() === info.depositAddress.toLowerCase() && (
              <p role="alert" className="mt-2 max-w-sm rounded-xl bg-danger/10 px-3 py-2 text-xs text-danger">
                This account is the Mesh agent wallet itself, so it cannot deposit to itself. Switch to a different account in MetaMask and connect again.
              </p>
            )}
            <p className="mt-1 text-xs text-muted">
              In your wallet:{" "}
              <span className="tabular-nums text-foreground">{info.walletBalanceHbar === null ? "unavailable right now" : `${info.walletBalanceHbar} HBAR`}</span>
            </p>
          </div>
          <div className="w-full sm:w-auto">
            <label htmlFor="amount" className="mb-1 block text-xs font-medium text-muted">
              Deposit (HBAR)
            </label>
            <div className="flex gap-2">
              <input
                id="amount"
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className="w-24 rounded-full border border-line bg-background px-4 py-2 text-sm outline-none focus:border-accent"
                aria-describedby="deposit-status"
              />
              <button type="button" onClick={doDeposit} disabled={dep.stage === "confirm" || dep.stage === "waiting"} className="btn-primary !h-10 text-sm disabled:opacity-60">
                {dep.stage === "confirm" ? "Confirm in wallet…" : dep.stage === "waiting" ? "Checking…" : pendingTx ? "Check again" : "Deposit"}
              </button>
            </div>
            <div className="mt-2 flex gap-1.5">
              {["0.5", "1", "2"].map((v) => (
                <button key={v} type="button" onClick={() => setAmount(v)} className="rounded-full border border-line px-3 py-1 text-xs text-muted hover:text-foreground">
                  {v}
                </button>
              ))}
            </div>
          </div>
        </div>
        <div id="deposit-status" aria-live="polite" className="mt-3 text-sm">
          {dep.stage === "waiting" && <p className="text-muted">Checking this transfer. Mesh has not credited it yet, and Hedera may still be confirming it.</p>}
          {dep.stage === "done" && dep.result && (
            <p className="text-emerald-700">
              Credited {dep.result.creditedHbar} HBAR.{" "}
              <Link href={dep.result.receiptUrl} className="underline underline-offset-2">
                View receipt
              </Link>
              {" · "}
              <a href={hashscan.tx(dep.result.txHash)} target="_blank" rel="noreferrer" className="underline underline-offset-2">
                HashScan
              </a>
            </p>
          )}
          {dep.stage === "error" && (
            <p role="alert" className="text-red-600">
              {dep.message}{" "}
              {pendingTx && (
                <button type="button" className="underline underline-offset-2" onClick={() => { setPendingTx(null); setDep({ stage: "idle" }); }}>
                  Start a new deposit
                </button>
              )}
            </p>
          )}
        </div>
      </section>

      {/* ───────── ask the agent ───────── */}
      <section className="card p-6" aria-label="Ask the Mesh agent">
        <p className="eyebrow">The Mesh agent</p>
        <h2 className="mt-2 text-xl font-medium tracking-tight">What do you need rendered?</h2>
        <p className="mt-1 text-sm text-muted">Describe it in your own words. A 0G model picks the size, and the agent pays for it on your behalf.</p>
        <label htmlFor="prompt" className="sr-only">
          Your request
        </label>
        <textarea
          id="prompt"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={3}
          maxLength={600}
          placeholder="e.g. A detailed render for my presentation slide"
          className="mt-4 w-full rounded-2xl border border-line bg-background px-4 py-3 text-sm outline-none focus:border-accent"
        />
        <div className="mt-2 flex flex-wrap gap-2">
          {EXAMPLES.map((ex) => (
            <button key={ex} type="button" onClick={() => setPrompt(ex)} className="rounded-full border border-line px-3 py-1 text-xs text-muted hover:text-foreground">
              {ex}
            </button>
          ))}
        </div>
        <button type="button" onClick={() => doPlan({ prompt })} disabled={planning || prompt.trim().length < 3 || Boolean(running)} className="btn-primary mt-4 disabled:opacity-60">
          {planning ? "Asking 0G…" : "Plan with 0G"}
        </button>

        {planError && (
          <div role="alert" className="mt-4 rounded-2xl border border-danger/30 bg-danger/5 p-4 text-sm">
            <p className="font-medium text-danger">The 0G plan did not work</p>
            <p className="mt-1 text-muted">{planError.message}</p>
            {planError.manual && <p className="mt-2 text-xs text-muted">Nothing was charged. Pick a size yourself below.</p>}
          </div>
        )}

        <details className="mt-5" open={Boolean(planError)}>
          <summary className="cursor-pointer text-sm text-muted hover:text-foreground">Advanced: pick a size yourself (no 0G)</summary>
          <div className="mt-3 grid gap-2 sm:grid-cols-3">
            {SIZES.map((s) => (
              <button key={s.preset} type="button" onClick={() => doPlan({ preset: s.preset })} disabled={planning || Boolean(running)} className="rounded-2xl border border-line p-3 text-left text-sm transition hover:border-accent/50 disabled:opacity-60">
                <span className="block font-medium">{s.label}</span>
                <span className="block text-xs text-muted">{s.note}</span>
                <span className="mt-1 block text-xs">{s.price} HBAR</span>
              </button>
            ))}
          </div>
        </details>
      </section>

      {/* ───────── the plan ───────── */}
      {plan && !run && (
        <section className="card p-6" aria-label="The plan">
          <div className="flex flex-wrap items-center gap-2">
            <p className="eyebrow">The plan</p>
            {plan.source === "og" && plan.og ? <OgBadge verification={plan.og.verification} /> : <span className="rounded-full bg-surface-2 px-2.5 py-0.5 text-xs text-muted">Chosen by you, not 0G</span>}
          </div>
          <p className="mt-3 text-2xl font-medium tracking-tight">
            {plan.preset[0].toUpperCase() + plan.preset.slice(1)} render <span className="text-muted">· {plan.priceHbar} HBAR</span>
          </p>
          {plan.reason && <p className="mt-2 text-sm leading-relaxed text-muted">{plan.reason}</p>}
          {plan.og && (
            <p className="mt-3 break-all font-mono text-[11px] text-muted" title="The 0G request id: it is also stored on the job and in the receipt">
              0G request {plan.og.requestId}
              {plan.og.model ? ` · ${plan.og.model}` : ""}
            </p>
          )}
          {!enough && (
            <p role="status" className="mt-3 text-sm text-amber-700">
              Your credit ({info.balanceHbar} HBAR) does not cover this. Deposit at least {plan.priceHbar} HBAR above.
            </p>
          )}
          <div className="mt-5 flex flex-wrap items-center gap-3">
            <button type="button" onClick={doRun} disabled={starting || !enough} className="btn-primary disabled:opacity-60">
              {starting ? "Starting…" : `Confirm and pay ${plan.priceHbar} HBAR`}
            </button>
            <button type="button" onClick={() => setPlan(null)} className="btn-secondary">
              Cancel
            </button>
          </div>
          {runError && (
            <p role="alert" className="mt-3 text-sm text-red-600">
              {runError}
            </p>
          )}
        </section>
      )}

      {/* ───────── the run ───────── */}
      {run && (
        <section className="card p-6" aria-label="Run progress" aria-live="polite">
          <p className="eyebrow">The agent is working</p>
          <ol className="mt-4 space-y-3 text-sm">
            <Step done label="Planned" detail={plan ? `${plan.preset} render, ${plan.priceHbar} HBAR` : undefined} />
            <Step
              done={run.status !== "needs_approval" && run.status !== "queued"}
              active={run.status === "needs_approval"}
              label="Approval"
              detail={run.status === "needs_approval" ? "A human approval is needed for this amount." : "Not needed, or already approved."}
            >
              {run.status === "needs_approval" && run.approvalUrl && (
                <div className="mt-2 rounded-2xl bg-accent-muted p-3">
                  <p className="text-xs text-muted">
                    Open World and approve this exact job{run.userCode ? ` (code ${run.userCode})` : ""}. The agent continues as soon as you do.
                  </p>
                  <a href={run.approvalUrl} target="_blank" rel="noreferrer" className="btn-primary mt-2 !h-9 text-sm">
                    Open approval
                  </a>
                </div>
              )}
            </Step>
            <Step done={run.status === "paid"} active={run.status === "paying"} label="The agent pays on Hedera" detail={run.paymentTx ? run.paymentTx : undefined}>
              {run.paymentTx && (
                <a href={hashscan.hederaTx(run.paymentTx)} target="_blank" rel="noreferrer" className="text-xs text-accent underline underline-offset-2">
                  View the payment on HashScan
                </a>
              )}
            </Step>
            <Step done={Boolean(run.jobId)} label="Job created">
              {run.jobId && (
                <Link href={`/jobs/${run.jobId}`} className="text-xs text-accent underline underline-offset-2">
                  Open the job (opening it for you…)
                </Link>
              )}
            </Step>
          </ol>
          {run.status === "failed" && (
            <div role="alert" className="mt-4 rounded-2xl border border-danger/30 bg-danger/5 p-4 text-sm">
              <p className="font-medium text-danger">This run did not complete</p>
              <p className="mt-1 text-muted">{run.error ?? "Something went wrong."} Your credit was returned.</p>
            </div>
          )}
          {run.receiptId && run.status !== "queued" && (
            <p className="mt-4 text-sm">
              <Link href={`/receipts/${run.receiptId}`} className="text-accent underline underline-offset-2">
                View receipt
              </Link>
            </p>
          )}
          {(run.status === "paid" || run.status === "failed") && (
            <button
              type="button"
              onClick={() => {
                setRun(null);
                setPlan(null);
                setPrompt("");
              }}
              className="btn-secondary mt-4 !h-9 text-sm"
            >
              Start another
            </button>
          )}
        </section>
      )}
    </div>
  );
}

function Step({ done, active, label, detail, children }: { done?: boolean; active?: boolean; label: string; detail?: string; children?: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full text-[11px] ${done ? "bg-emerald-500 text-white" : active ? "animate-pulse bg-accent text-white" : "border border-line text-muted"}`} aria-hidden="true">
        {done ? "✓" : ""}
      </span>
      <div className="min-w-0">
        <p className={done || active ? "font-medium" : "text-muted"}>{label}</p>
        {detail && <p className="break-all text-xs text-muted">{detail}</p>}
        {children}
      </div>
    </li>
  );
}
