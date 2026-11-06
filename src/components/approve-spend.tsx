"use client";

import { IDKitRequestWidget, proofOfHuman } from "@worldcoin/idkit";
import type { IDKitResult, RpContext } from "@worldcoin/idkit";
import { useCallback, useEffect, useState } from "react";
import { formatToken } from "@/lib/ui/format";

interface ApprovalView {
  approvalId: string;
  method: "device" | "idkit";
  status: "pending" | "approved" | "denied" | "expired" | "used";
  params: { requester: string; preset: string; price: string };
  userCode: string;
  expiresAt: number;
  reason: string | null;
}

interface RpResponse {
  app_id: `app_${string}`;
  environment: string;
  action: string;
  rp_context: RpContext;
}

type Phase =
  | { name: "loading" }
  | { name: "missing" }
  | { name: "ready"; view: ApprovalView }
  | { name: "preparing"; view: ApprovalView }
  | { name: "widget"; view: ApprovalView; rp: RpResponse }
  | { name: "checking"; view: ApprovalView }
  | { name: "unavailable"; view: ApprovalView; message: string }
  | { name: "failed"; view: ApprovalView; message: string };

const FINAL: Record<string, { title: string; body: string; tone: "ok" | "bad" }> = {
  approved: { title: "Approved", body: "The agent can now pay for this one job. You can close this page.", tone: "ok" },
  denied: { title: "Not approved", body: "The agent was refused. No job was created and nothing was paid.", tone: "bad" },
  expired: { title: "Expired", body: "This approval ran out of time. No job was created and nothing was paid.", tone: "bad" },
  used: { title: "Already used", body: "This approval was already spent on its job.", tone: "bad" },
};

/**
 * The human side of an agent spend approval. An agent above its spending threshold asks for this; a person proves they are a unique
 * human with World ID, for this one job only. The proof is checked on the server. Cancelling or closing the page approves nothing.
 */
export function ApproveSpend({ approvalId }: { approvalId: string }) {
  const [phase, setPhase] = useState<Phase>({ name: "loading" });

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/approvals/${approvalId}`, { cache: "no-store" });
      if (res.status === 404 || res.status === 400) return setPhase({ name: "missing" });
      const view = (await res.json()) as ApprovalView;
      setPhase({ name: "ready", view });
    } catch {
      setPhase({ name: "missing" });
    }
  }, [approvalId]);

  useEffect(() => {
    let alive = true;
    fetch(`/api/approvals/${approvalId}`, { cache: "no-store" })
      .then(async (res) => (res.status === 404 || res.status === 400 ? null : ((await res.json()) as ApprovalView)))
      .catch(() => null)
      .then((view) => {
        if (alive) setPhase(view ? { name: "ready", view } : { name: "missing" });
      });
    return () => {
      alive = false;
    };
  }, [approvalId]);

  async function start(view: ApprovalView) {
    setPhase({ name: "preparing", view });
    try {
      const res = await fetch("/api/world/rp-context", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "approve-spend", approvalId }) });
      const body = await res.json().catch(() => ({}));
      if (res.status === 503) return setPhase({ name: "unavailable", view, message: "World ID is not configured on this server." });
      if (!res.ok) {
        await load(); // expired, cancelled or already answered: show the real state
        return;
      }
      setPhase({ name: "widget", view, rp: body as RpResponse });
    } catch {
      setPhase({ name: "failed", view, message: "Could not reach the server." });
    }
  }

  async function submit(view: ApprovalView, result: IDKitResult) {
    setPhase({ name: "checking", view });
    try {
      const res = await fetch(`/api/approvals/${approvalId}/idkit`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ result }) });
      if (res.ok) return void (await load());
      const body = await res.json().catch(() => ({}));
      if (res.status === 503) return setPhase({ name: "unavailable", view, message: "World could not be reached to check the proof. Nothing was approved. Try again." });
      if (res.status === 401) return setPhase({ name: "failed", view, message: `World did not accept the proof${body.reason ? ` (${body.reason})` : ""}. Nothing was approved.` });
      await load();
    } catch {
      setPhase({ name: "failed", view, message: "Could not reach the server. Nothing was approved." });
    }
  }

  async function cancel() {
    try {
      await fetch(`/api/approvals/${approvalId}/cancel`, { method: "POST" });
    } finally {
      await load();
    }
  }

  const view = "view" in phase ? phase.view : null;

  if (phase.name === "loading") return <p className="text-sm text-muted">Loading approval…</p>;
  if (phase.name === "missing") {
    return (
      <div className="rounded-2xl border border-line bg-surface p-6">
        <p className="font-medium">Approval not found</p>
        <p className="mt-1 text-sm text-muted">The link may be wrong, or this server no longer has it.</p>
      </div>
    );
  }
  if (!view) return null;

  const final = FINAL[view.status];
  if (final) {
    return (
      <div className={`rounded-2xl border p-6 ${final.tone === "ok" ? "border-accent/40 bg-accent/5" : "border-danger/40 bg-danger/5"}`} role="status">
        <p className={`text-lg font-semibold ${final.tone === "ok" ? "text-accent" : "text-danger"}`}>{final.title}</p>
        <p className="mt-1 text-sm text-foreground/80">{final.body}</p>
        {view.reason && view.status !== "approved" && <p className="mt-2 text-xs text-muted">{view.reason}</p>}
      </div>
    );
  }
  if (view.method !== "idkit") {
    return (
      <div className="rounded-2xl border border-line bg-surface p-6">
        <p className="font-medium">Approve in the World app</p>
        <p className="mt-1 text-sm text-muted">
          This approval goes through World&apos;s device flow. Open the link the agent printed and enter code <span className="font-mono text-foreground">{view.userCode}</span>.
        </p>
      </div>
    );
  }

  const busy = phase.name === "preparing" || phase.name === "checking";
  return (
    <div className="space-y-5">
      <div className="rounded-2xl border border-line bg-surface p-6">
        <p className="text-xs font-semibold uppercase tracking-widest text-muted">An agent wants to spend</p>
        <p className="mt-2 text-3xl font-semibold tabular-nums">{formatToken(view.params.price)}</p>
        <dl className="mt-5 grid gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-muted">Job</dt>
            <dd className="mt-0.5 font-medium">render · {view.params.preset}</dd>
          </div>
          <div>
            <dt className="text-muted">Requester wallet</dt>
            <dd className="mt-0.5 break-all font-mono text-xs">{view.params.requester}</dd>
          </div>
        </dl>
        <p className="mt-5 text-xs leading-relaxed text-muted">
          Your approval is for this one job only and works once. Approve only if you started this agent. Code <span className="font-mono text-foreground">{view.userCode}</span>.
        </p>
      </div>

      {(phase.name === "failed" || phase.name === "unavailable") && (
        <p role="alert" className={`text-sm ${phase.name === "failed" ? "text-danger" : "text-amber-400"}`}>
          {phase.message}
        </p>
      )}

      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          onClick={() => start(view)}
          disabled={busy}
          className="rounded-full bg-accent px-6 py-2.5 text-sm font-semibold text-accent-ink transition hover:brightness-110 disabled:opacity-60"
        >
          {phase.name === "preparing" ? "Preparing…" : phase.name === "checking" ? "Checking the proof…" : "Approve with World ID"}
        </button>
        <button type="button" onClick={cancel} disabled={busy} className="rounded-full border border-line px-6 py-2.5 text-sm font-medium transition hover:border-white/25 disabled:opacity-60">
          Cancel
        </button>
      </div>

      {phase.name === "widget" && (
        <IDKitRequestWidget
          open
          onOpenChange={(o) => {
            if (!o) setPhase({ name: "ready", view });
          }}
          app_id={phase.rp.app_id}
          action={phase.rp.action}
          rp_context={phase.rp.rp_context}
          allow_legacy_proofs={false}
          preset={proofOfHuman()}
          environment={phase.rp.environment as "production" | "staging"}
          onSuccess={(result: IDKitResult) => submit(view, result)}
          onError={(code) => setPhase({ name: "failed", view, message: `World ID did not complete (${String(code)}). Nothing was approved.` })}
        />
      )}
    </div>
  );
}
