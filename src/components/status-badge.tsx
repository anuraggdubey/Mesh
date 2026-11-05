import type { JobStatus } from "@/lib/constants";

const STYLES: Record<string, string> = {
  created: "bg-zinc-500/15 text-zinc-600 dark:text-zinc-300",
  paid: "bg-sky-500/15 text-sky-700 dark:text-sky-300",
  assigned: "bg-sky-500/15 text-sky-700 dark:text-sky-300",
  running: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  pending: "bg-violet-500/15 text-violet-700 dark:text-violet-300",
  final: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  rejected: "bg-red-500/15 text-red-700 dark:text-red-300",
  slashed: "bg-red-500/15 text-red-700 dark:text-red-300",
  failed: "bg-red-500/15 text-red-700 dark:text-red-300",
  expired: "bg-zinc-500/15 text-zinc-600 dark:text-zinc-300",
  refunded: "bg-zinc-500/15 text-zinc-600 dark:text-zinc-300",
};

const LABELS: Partial<Record<JobStatus, string>> = { pending: "verifying" };

export function StatusBadge({ status }: { status: JobStatus | string }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${STYLES[status] ?? STYLES.created}`}>
      {LABELS[status as JobStatus] ?? status}
    </span>
  );
}
