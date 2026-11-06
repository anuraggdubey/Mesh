"use client";

import { IDKitRequestWidget, proofOfHuman } from "@worldcoin/idkit";
import type { IDKitResult, RpContext } from "@worldcoin/idkit";
import { useState } from "react";

interface RpResponse {
  app_id: `app_${string}`;
  rp_id: string;
  environment: string;
  action: string;
  rp_context: RpContext;
}

type Stage = { name: "idle" } | { name: "loading" } | { name: "unavailable"; message: string } | { name: "open"; rp: RpResponse } | { name: "done"; proof: string } | { name: "failed"; message: string };

/**
 * World ID (IDKit) proof of a unique human for provider registration. The server signs the request, World's app confirms the
 * person, and the result is verified on OUR server when the provider registers. The result is shown here so it can be given to
 * the provider worker (PROVIDER_WORLD_PROOF). A proof works once.
 */
export function WorldVerify() {
  const [stage, setStage] = useState<Stage>({ name: "idle" });
  const [copied, setCopied] = useState(false);

  async function start() {
    setStage({ name: "loading" });
    try {
      const res = await fetch("/api/world/rp-context", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "register-provider" }) });
      const body = await res.json().catch(() => ({}));
      if (res.status === 503) {
        setStage({ name: "unavailable", message: "World ID is not configured on this server yet (it needs the app, RP id and signing key from developer.world.org)." });
        return;
      }
      if (!res.ok) {
        setStage({ name: "failed", message: body.message ?? body.error ?? `HTTP ${res.status}` });
        return;
      }
      setStage({ name: "open", rp: body as RpResponse });
    } catch {
      setStage({ name: "failed", message: "Could not reach the server. Is it running?" });
    }
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard blocked: the text is selectable in the box
    }
  }

  const done = stage.name === "done" ? stage.proof : null;

  return (
    <div className="space-y-5 card p-6">
      {stage.name !== "done" && (
        <>
          <p className="text-sm text-zinc-600 dark:text-zinc-300">
            Mesh allows one provider profile per human. Verify with World ID, then give the result to your provider worker. Each proof works once.
          </p>
          <button
            type="button"
            onClick={start}
            disabled={stage.name === "loading" || stage.name === "open"}
            className="rounded-full bg-accent shadow-[var(--shadow-accent)] px-4 py-2 text-sm font-medium text-white transition hover:brightness-110 disabled:opacity-60"
          >
            {stage.name === "loading" ? "Preparing…" : "Verify with World ID"}
          </button>
        </>
      )}

      {stage.name === "unavailable" && (
        <p role="status" className="text-sm text-amber-700 dark:text-amber-400">
          {stage.message}
        </p>
      )}
      {stage.name === "failed" && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {stage.message}
        </p>
      )}

      {stage.name === "open" && (
        <IDKitRequestWidget
          open
          onOpenChange={(o) => {
            if (!o) setStage({ name: "idle" });
          }}
          app_id={stage.rp.app_id}
          action={stage.rp.action}
          rp_context={stage.rp.rp_context}
          allow_legacy_proofs={false}
          preset={proofOfHuman()}
          environment={stage.rp.environment as "production" | "staging"}
          onSuccess={(result: IDKitResult) => setStage({ name: "done", proof: JSON.stringify(result) })}
          onError={(code) => setStage({ name: "failed", message: `World ID did not complete (${String(code)}).` })}
        />
      )}

      {done && (
        <div className="space-y-3">
          <p role="status" className="text-sm font-medium text-emerald-700">
            Verified. Give this to the provider worker as PROVIDER_WORLD_PROOF, then start it.
          </p>
          <textarea readOnly value={done} rows={6} aria-label="World ID proof" className="w-full rounded-md border border-zinc-400/40 bg-transparent p-2 font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
          <div className="flex gap-3">
            <button type="button" onClick={() => copy(done)} className="rounded-full bg-accent shadow-[var(--shadow-accent)] px-3 py-1.5 text-sm font-medium text-white hover:brightness-110">
              {copied ? "Copied" : "Copy proof"}
            </button>
            <button type="button" onClick={() => setStage({ name: "idle" })} className="rounded-md border border-zinc-400/40 px-3 py-1.5 text-sm hover:border-zinc-400/70">
              Verify again
            </button>
          </div>
          <pre className="overflow-x-auto rounded-md bg-zinc-500/10 p-3 text-xs">{`PROVIDER_WORLD_PROOF='<paste>' npm run worker:provider`}</pre>
        </div>
      )}
    </div>
  );
}
