"use client";

import { useEffect, useRef, useState } from "react";
import type { InferenceRecord } from "@/lib/types";
import { shortAddr, shortHash } from "@/lib/ui/format";

type Stage = { name: "idle" } | { name: "loading" } | { name: "done"; inference: InferenceRecord } | { name: "unavailable" } | { name: "error"; message: string };

const BADGE: Record<InferenceRecord["verification"], { label: string; cls: string; hint: string }> = {
  "tee-signature": { label: "Verified by 0G TEE", cls: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300", hint: "The provider's signature over the response was checked here against the TEE signer address." },
  "router-checked": { label: "Router-checked only", cls: "bg-amber-500/15 text-amber-700 dark:text-amber-300", hint: "The 0G Router says the TEE check passed. We did not verify the provider's signature ourselves." },
  unverified: { label: "Not verified", cls: "bg-red-500/15 text-red-700 dark:text-red-300", hint: "Neither the Router nor a signature check confirmed this answer. Treat it as unverified." },
};

/**
 * AI review of the finished render, made by a vision model on 0G Private Computer. It runs once per job when the job is final.
 * Without it this panel is empty: the render, the payment and the receipt are unaffected, but nobody gets an independent look at
 * the result with a request id that can be traced on 0G.
 */
export function AiReview({ jobId, final, initial }: { jobId: string; final: boolean; initial: InferenceRecord | null }) {
  const [stage, setStage] = useState<Stage>(initial ? { name: "done", inference: initial } : { name: "idle" });
  const asked = useRef(false);

  async function run() {
    setStage({ name: "loading" });
    try {
      const res = await fetch(`/api/jobs/${jobId}/review`, { method: "POST" });
      const body = await res.json().catch(() => ({}));
      if (res.ok && body.inference) return setStage({ name: "done", inference: body.inference as InferenceRecord });
      if (res.status === 503) return setStage({ name: "unavailable" });
      const retry = res.headers.get("retry-after");
      setStage({ name: "error", message: `${body.message ?? body.error ?? `HTTP ${res.status}`}${retry ? ` (try again in ${retry}s)` : ""}` });
    } catch {
      setStage({ name: "error", message: "Could not reach the server." });
    }
  }

  // ask once, as soon as the job is final and there is no review yet
  useEffect(() => {
    if (final && !initial && !asked.current) {
      asked.current = true;
      void run();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [final, initial]);

  if (!final && stage.name === "idle") return null;

  return (
    <section className="card p-5" aria-label="AI review on 0G">
      <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold">
        AI review <span className="rounded bg-zinc-500/15 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide">0G Private Computer</span>
      </h2>

      {stage.name === "loading" && (
        <p role="status" className="text-sm text-zinc-500">
          Asking a vision model on 0G to look at the finished render…
        </p>
      )}
      {stage.name === "unavailable" && <p className="text-sm text-zinc-500">AI review is not enabled on this server.</p>}
      {stage.name === "error" && (
        <div role="alert" className="space-y-2 text-sm">
          <p className="text-red-600 dark:text-red-400">The AI review failed: {stage.message}</p>
          <button type="button" onClick={run} className="rounded-md border border-zinc-400/40 px-3 py-1 text-xs hover:border-zinc-400/70">
            Try again
          </button>
        </div>
      )}
      {stage.name === "idle" && (
        <button type="button" onClick={run} className="rounded-full bg-accent shadow-[var(--shadow-accent)] px-3 py-1.5 text-sm font-medium text-white hover:brightness-110">
          Run AI review on 0G
        </button>
      )}

      {stage.name === "done" && (
        <div className="space-y-3 text-sm">
          <p>{stage.inference.output.description}</p>
          <p className="flex flex-wrap items-center gap-2">
            <span
              className={`rounded px-2 py-0.5 text-xs font-medium ${
                stage.inference.output.quality === "good" ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300" : stage.inference.output.quality === "unknown" ? "bg-zinc-500/15" : "bg-red-500/15 text-red-700 dark:text-red-300"
              }`}
            >
              looks {stage.inference.output.quality}
            </span>
            <span className={`rounded px-2 py-0.5 text-xs font-medium ${BADGE[stage.inference.verification].cls}`} title={BADGE[stage.inference.verification].hint}>
              {BADGE[stage.inference.verification].label}
            </span>
          </p>
          {stage.inference.output.notes && <p className="text-xs text-zinc-500">{stage.inference.output.notes}</p>}
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
            <dt className="text-zinc-500">0G request id</dt>
            <dd className="break-all font-mono" title={stage.inference.requestId}>
              {stage.inference.requestId}
            </dd>
            <dt className="text-zinc-500">Model</dt>
            <dd className="font-mono">{stage.inference.model}</dd>
            {stage.inference.provider && (
              <>
                <dt className="text-zinc-500">0G provider</dt>
                <dd className="font-mono">{shortAddr(stage.inference.provider)}</dd>
              </>
            )}
            <dt className="text-zinc-500">Signed text hash</dt>
            <dd className="font-mono" title={stage.inference.digest}>
              {shortHash(stage.inference.digest, 16)}
            </dd>
          </dl>
          <p className="text-xs text-zinc-500">{BADGE[stage.inference.verification].hint}</p>
        </div>
      )}
    </section>
  );
}
