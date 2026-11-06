"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export const DOC_PAGES = [
  { href: "/docs", title: "Introduction", group: "Start" },
  { href: "/docs/how-it-works", title: "How verification works", group: "Concepts" },
  { href: "/docs/payments", title: "x402 payments & agents", group: "Concepts" },
  { href: "/docs/identity", title: "World ID & approvals", group: "Concepts" },
  { href: "/docs/audit", title: "Receipts, HCS & 0G review", group: "Concepts" },
  { href: "/docs/providers", title: "Run a provider", group: "Guides" },
  { href: "/docs/api", title: "API reference", group: "Reference" },
  { href: "/docs/security", title: "Trust model & limits", group: "Reference" },
] as const;

export function DocsNav() {
  const path = usePathname();
  const groups = [...new Set(DOC_PAGES.map((p) => p.group))];
  return (
    <nav aria-label="Documentation" className="space-y-7">
      {groups.map((g) => (
        <div key={g}>
          <p className="mb-2 px-3 text-[11px] font-semibold uppercase tracking-widest text-muted">{g}</p>
          <ul className="space-y-0.5">
            {DOC_PAGES.filter((p) => p.group === g).map((p) => {
              const active = path === p.href;
              return (
                <li key={p.href}>
                  <Link
                    href={p.href}
                    aria-current={active ? "page" : undefined}
                    className={`block rounded-lg px-3 py-1.5 text-sm transition ${active ? "bg-accent/10 font-medium text-accent" : "text-muted hover:bg-surface-2 hover:text-foreground"}`}
                  >
                    {p.title}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

/** Previous / next links under a page, from the order above. */
export function DocsPager({ href }: { href: string }) {
  const i = DOC_PAGES.findIndex((p) => p.href === href);
  const prev = i > 0 ? DOC_PAGES[i - 1] : null;
  const next = i < DOC_PAGES.length - 1 ? DOC_PAGES[i + 1] : null;
  return (
    <div className="mt-16 grid gap-3 border-t border-line pt-8 sm:grid-cols-2">
      {prev ? (
        <Link href={prev.href} className="rounded-2xl border border-line p-4 transition hover:border-accent/40">
          <span className="text-xs text-muted">Previous</span>
          <span className="mt-1 block text-sm font-medium">{prev.title}</span>
        </Link>
      ) : (
        <span />
      )}
      {next && (
        <Link href={next.href} className="rounded-2xl border border-line p-4 text-right transition hover:border-accent/40">
          <span className="text-xs text-muted">Next</span>
          <span className="mt-1 block text-sm font-medium">{next.title}</span>
        </Link>
      )}
    </div>
  );
}
