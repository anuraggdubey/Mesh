import type { TimelineStep } from "@/lib/ui/job-view";

const DOT: Record<TimelineStep["state"], string> = {
  done: "bg-emerald-500 border-emerald-500 text-white",
  current: "bg-sky-500 border-sky-500 text-white animate-pulse",
  todo: "bg-transparent border-zinc-400/50 text-zinc-400",
  failed: "bg-red-500 border-red-500 text-white",
};

const LABEL: Record<TimelineStep["state"], string> = {
  done: "text-foreground",
  current: "text-foreground font-semibold",
  todo: "text-zinc-500",
  failed: "text-red-600 dark:text-red-400 font-semibold",
};

export function StatusTimeline({ steps }: { steps: TimelineStep[] }) {
  return (
    <ol className="flex flex-wrap items-center gap-x-2 gap-y-3" aria-label="Job progress">
      {steps.map((s, i) => (
        <li key={s.key} className="flex items-center gap-2" aria-current={s.state === "current" ? "step" : undefined}>
          <span className={`flex h-6 w-6 items-center justify-center rounded-full border text-xs ${DOT[s.state]}`}>
            {s.state === "done" ? "✓" : s.state === "failed" ? "!" : i + 1}
          </span>
          <span className={`text-sm ${LABEL[s.state]}`}>{s.label}</span>
          {i < steps.length - 1 && <span className="mx-1 hidden h-px w-6 bg-zinc-400/40 sm:block" aria-hidden />}
        </li>
      ))}
    </ol>
  );
}
