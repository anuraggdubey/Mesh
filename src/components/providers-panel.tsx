"use client";

import { useEffect, useState } from "react";
import { shortAddr } from "@/lib/ui/format";

interface ProviderInfo {
  address: string;
  cores: number;
  memoryGb: number;
  os: string;
  arch: string;
  online: boolean;
  load: number | null;
  currentTask: string | null;
  worldVerified: boolean;
}

/** Polls GET /api/providers so you can see who is online before posting a job. */
export function ProvidersPanel() {
  const [providers, setProviders] = useState<ProviderInfo[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let stop = false;
    const load = () =>
      fetch("/api/providers")
        .then((r) => r.json())
        .then((b: { providers: ProviderInfo[] }) => {
          if (!stop) {
            setProviders(b.providers);
            setFailed(false);
          }
        })
        .catch(() => !stop && setFailed(true));
    load();
    const t = setInterval(load, 4000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, []);

  const online = providers?.filter((p) => p.online) ?? [];

  return (
    <section className="rounded-lg border border-zinc-400/30 p-4" aria-label="Providers">
      <h2 className="mb-1 text-sm font-semibold">Providers</h2>
      <p className="mb-3 text-xs text-zinc-500">
        {providers === null ? "Loading…" : `${online.length} online, ${providers.length} registered`}
        {failed && " · connection problem"}
      </p>
      {providers && providers.length === 0 && (
        <p className="text-sm text-zinc-500">
          None yet. Start one with <code className="rounded bg-zinc-400/20 px-1">npm run worker:mock</code>.
        </p>
      )}
      <ul className="space-y-2">
        {providers?.map((p) => (
          <li key={p.address} className="flex items-center gap-2 text-sm">
            <span className={`h-2 w-2 shrink-0 rounded-full ${p.online ? "bg-emerald-500" : "bg-zinc-400"}`} title={p.online ? "online" : "offline"} />
            <span className="font-mono">{shortAddr(p.address)}</span>
            <span className="ml-auto text-xs text-zinc-500">
              {p.cores} cores · {p.os}/{p.arch}
              {p.currentTask ? " · busy" : ""}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
