import Link from "next/link";
import { Logo } from "./logo";

const LINKS = [
  { href: "/#how", label: "How it works" },
  { href: "/#proof", label: "The proof" },
  { href: "/#partners", label: "Built on" },
  { href: "/docs", label: "Docs" },
];

export function SiteNav() {
  return (
    <header className="sticky top-0 z-40 border-b border-line bg-background/70 backdrop-blur-xl">
      <nav className="mx-auto flex h-14 max-w-6xl items-center gap-8 px-5" aria-label="Main">
        <Link href="/" className="flex items-center gap-2 text-[17px] font-semibold tracking-tight">
          <Logo />
          Mesh
        </Link>
        <ul className="hidden items-center gap-1 md:flex">
          {LINKS.map((l) => (
            <li key={l.href}>
              <Link href={l.href} className="rounded-full px-3 py-1.5 text-sm text-muted transition hover:bg-white/5 hover:text-foreground">
                {l.label}
              </Link>
            </li>
          ))}
        </ul>
        <div className="ml-auto flex items-center gap-2">
          <Link href="/provider/verify" className="hidden rounded-full px-3 py-1.5 text-sm text-muted transition hover:text-foreground sm:block">
            Become a provider
          </Link>
          <Link href="/app" className="rounded-full bg-accent px-4 py-1.5 text-sm font-semibold text-accent-ink transition hover:brightness-110">
            Open app
          </Link>
          {/* mobile menu: a plain <details>, no JavaScript */}
          <details className="relative md:hidden">
            <summary className="grid h-9 w-9 cursor-pointer list-none place-items-center rounded-full border border-line" aria-label="Menu">
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
                <path d="M4 8h16M4 16h16" />
              </svg>
            </summary>
            <div className="absolute right-0 mt-2 w-52 rounded-2xl border border-line bg-surface p-2 shadow-2xl">
              {LINKS.map((l) => (
                <Link key={l.href} href={l.href} className="block rounded-xl px-3 py-2 text-sm text-muted hover:bg-white/5 hover:text-foreground">
                  {l.label}
                </Link>
              ))}
              <Link href="/provider/verify" className="block rounded-xl px-3 py-2 text-sm text-muted hover:bg-white/5 hover:text-foreground">
                Become a provider
              </Link>
            </div>
          </details>
        </div>
      </nav>
    </header>
  );
}
