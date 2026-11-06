import Link from "next/link";
import { WalletButton } from "../wallet-button";
import { Logo } from "./logo";

const LINKS = [
  { href: "/#problem", label: "The idea" },
  { href: "/#how", label: "How it works" },
  { href: "/#benefits", label: "Benefits" },
  { href: "/#workloads", label: "Workloads" },
  { href: "/docs", label: "Docs" },
  { href: "https://github.com/anuraggdubey/Mesh", label: "GitHub" },
];

export function SiteNav() {
  return (
    <header className="sticky top-0 z-40 border-b border-line/60 bg-background/90 backdrop-blur-xl print:hidden">
      <nav className="mx-auto flex h-14 max-w-6xl items-center gap-6 px-5" aria-label="Main">
        <Link href="/" className="flex items-center gap-2 font-display text-[17px] font-medium tracking-tight">
          <Logo />
          Mesh
        </Link>
        <ul className="ml-auto hidden items-center gap-1 md:flex">
          {LINKS.map((l) => (
            <li key={l.href}>
              <Link
                href={l.href}
                className="rounded-full px-3 py-1.5 text-sm text-muted transition hover:text-foreground"
                {...(l.href.startsWith("http") ? { target: "_blank", rel: "noreferrer" } : {})}
              >
                {l.label}
              </Link>
            </li>
          ))}
        </ul>
        <div className="ml-auto flex items-center gap-2 md:ml-2">
          <WalletButton />
          {/* mobile menu: a plain <details>, no JavaScript */}
          <details className="relative md:hidden">
            <summary className="grid h-9 w-9 cursor-pointer list-none place-items-center rounded-full border border-line bg-surface" aria-label="Menu">
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
                <path d="M4 8h16M4 16h16" />
              </svg>
            </summary>
            <div className="absolute right-0 mt-2 w-52 rounded-2xl bg-surface p-2 shadow-[var(--shadow-border),var(--shadow-elevated)]">
              {LINKS.map((l) => (
                <Link key={l.href} href={l.href} className="block rounded-xl px-3 py-2 text-sm text-muted hover:bg-background hover:text-foreground">
                  {l.label}
                </Link>
              ))}
              <Link href="/provider/verify" className="block rounded-xl px-3 py-2 text-sm text-muted hover:bg-background hover:text-foreground">
                Become a provider
              </Link>
            </div>
          </details>
        </div>
      </nav>
    </header>
  );
}
