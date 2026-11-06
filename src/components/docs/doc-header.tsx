import type { ReactNode } from "react";

export function DocHeader({ eyebrow, title, lead }: { eyebrow: string; title: string; lead: ReactNode }) {
  return (
    <header className="mb-10 border-b border-line pb-8">
      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-accent">{eyebrow}</p>
      <h1 className="mt-3 text-4xl font-semibold tracking-tight">{title}</h1>
      <p className="mt-4 text-lg leading-relaxed text-muted">{lead}</p>
    </header>
  );
}

export function Callout({ kind = "note", title, children }: { kind?: "note" | "warn"; title: string; children: ReactNode }) {
  const tone = kind === "warn" ? "border-danger/40 bg-danger/5" : "border-accent/30 bg-accent/5";
  return (
    <aside className={`my-6 rounded-2xl border p-5 ${tone}`}>
      <p className={`text-sm font-semibold ${kind === "warn" ? "text-danger" : "text-accent"}`}>{title}</p>
      <div className="mt-1 text-sm leading-relaxed text-foreground/80 [&_p]:my-1">{children}</div>
    </aside>
  );
}
