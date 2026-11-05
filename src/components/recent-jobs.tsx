"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { formatToken, shortHash } from "@/lib/ui/format";
import type { Job } from "@/lib/types";
import { StatusBadge } from "./status-badge";

/** Most recent jobs, refreshed every few seconds. */
export function RecentJobs() {
  const [jobs, setJobs] = useState<Job[] | null>(null);

  useEffect(() => {
    let stop = false;
    const load = () =>
      fetch("/api/jobs")
        .then((r) => r.json())
        .then((b: { jobs: Job[] }) => !stop && setJobs(b.jobs.slice(0, 8)))
        .catch(() => {});
    load();
    const t = setInterval(load, 4000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, []);

  return (
    <section className="rounded-lg border border-zinc-400/30 p-4" aria-label="Recent jobs">
      <h2 className="mb-3 text-sm font-semibold">Recent jobs</h2>
      {jobs === null && <p className="text-sm text-zinc-500">Loading…</p>}
      {jobs?.length === 0 && <p className="text-sm text-zinc-500">No jobs yet.</p>}
      <ul className="space-y-2">
        {jobs?.map((j) => (
          <li key={j.jobId}>
            <Link href={`/jobs/${j.jobId}`} className="flex items-center gap-2 text-sm hover:underline">
              <span className="font-mono text-xs">{shortHash(j.jobId, 8)}</span>
              <span className="text-xs text-zinc-500">{String((j.params as { preset?: string }).preset ?? j.type)}</span>
              <span className="text-xs text-zinc-500">{formatToken(j.price)}</span>
              <span className="ml-auto">
                <StatusBadge status={j.status} />
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
