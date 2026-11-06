"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { isAddress } from "viem";
import { RENDER_PRESETS, RENDER_PRICE } from "@/lib/constants";
import type { RenderPreset } from "@/lib/constants";
import { formatToken } from "@/lib/ui/format";

const PRESET_INFO: Record<RenderPreset, { label: string; note: string }> = {
  tiny: { label: "Tiny", note: "4 tiles, a quick check" },
  small: { label: "Small", note: "64 tiles, about 5 seconds on a fast provider" },
  full: { label: "Full", note: "64 tiles, the heavy demo (about 30 seconds)" },
};

const STORAGE_KEY = "mesh.requester";

export function NewJobForm() {
  const router = useRouter();
  const [preset, setPreset] = useState<RenderPreset>("small");
  const requesterRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // restore the last wallet address straight into the input (a DOM update, not React state)
  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved && requesterRef.current && !requesterRef.current.value) requesterRef.current.value = saved;
    } catch {
      // storage blocked: ignore
    }
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const requester = (requesterRef.current?.value ?? "").trim();
    if (!isAddress(requester)) {
      setError("Enter a valid wallet address (0x followed by 40 hex characters).");
      return;
    }
    setBusy(true);
    try {
      localStorage.setItem(STORAGE_KEY, requester);
    } catch {
      // ignore
    }
    try {
      const res = await fetch("/api/jobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "render", preset, requester }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.status === 200 && body.jobId) {
        router.push(`/jobs/${body.jobId}`);
        return;
      }
      if (res.status === 402 && body.accepts?.[0]) {
        // jobs are paid over x402 by a client that can sign a Hedera payment; the page itself has no wallet
        const a = body.accepts[0];
        setError(`This job is paid over x402 (${a.amount} of asset ${a.asset} on ${a.network}). Run it with the Mesh agent: npm run agent -- ${preset}`);
        return;
      }
      const detail = body.issues?.[0]?.message ?? body.message ?? body.error ?? `HTTP ${res.status}`;
      setError(`Could not create the job: ${detail}`);
    } catch {
      setError("Could not reach the server. Is it running?");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-5 card p-6" noValidate>
      <fieldset>
        <legend className="mb-2 text-sm font-semibold">Render size</legend>
        <div className="grid gap-2 sm:grid-cols-3">
          {(Object.keys(RENDER_PRESETS) as RenderPreset[]).map((p) => (
            <label
              key={p}
              className={`cursor-pointer rounded-md border p-3 text-sm transition ${
                preset === p ? "border-accent bg-accent-muted" : "border-zinc-400/30 hover:border-zinc-400/60"
              }`}
            >
              <input type="radio" name="preset" value={p} checked={preset === p} onChange={() => setPreset(p)} className="sr-only" />
              <span className="block font-medium">{PRESET_INFO[p].label}</span>
              <span className="block text-xs text-zinc-500">{PRESET_INFO[p].note}</span>
              <span className="mt-1 block text-xs">{formatToken(RENDER_PRICE[p])}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <div>
        <label htmlFor="requester" className="mb-1 block text-sm font-semibold">
          Your wallet address
        </label>
        <input
          id="requester"
          ref={requesterRef}
          defaultValue=""
          onChange={() => error && setError(null)}
          placeholder="0x…"
          spellCheck={false}
          autoComplete="off"
          aria-invalid={error !== null && error.startsWith("Enter a valid")}
          aria-describedby={error ? "form-error" : undefined}
          className="w-full rounded-md border border-zinc-400/40 bg-transparent px-3 py-2 font-mono text-sm outline-none focus:border-sky-500"
        />
        <p className="mt-1 text-xs text-zinc-500">The wallet that pays for the job and gets refunded if a provider cheats.</p>
      </div>

      {error && (
        <p id="form-error" role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={busy}
        className="rounded-full bg-accent shadow-[var(--shadow-accent)] px-4 py-2 text-sm font-medium text-white transition hover:brightness-110 disabled:opacity-60"
      >
        {busy ? "Creating…" : "Run job"}
      </button>
    </form>
  );
}
