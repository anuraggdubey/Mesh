import Link from "next/link";
import { Logo } from "./logo";

const COLS = [
  {
    title: "Product",
    links: [
      { href: "/app", label: "Run a job" },
      { href: "/provider/verify", label: "Become a provider" },
      { href: "/#how", label: "How it works" },
      { href: "/#benefits", label: "Benefits" },
    ],
  },
  {
    title: "Docs",
    links: [
      { href: "/docs", label: "Introduction" },
      { href: "/docs/how-it-works", label: "Verification" },
      { href: "/docs/payments", label: "x402 payments" },
      { href: "/docs/identity", label: "World ID" },
      { href: "/docs/api", label: "API reference" },
    ],
  },
  {
    title: "On chain",
    links: [
      { href: "https://hashscan.io/testnet/contract/0x0118652ea87a8616Cb51979F5F121FC598bf3e7E", label: "MeshReceipt" },
      { href: "https://hashscan.io/testnet/contract/0x522C2eef0EF65d1f9eA9dfe12b88ba24565245f8", label: "MeshStake" },
      { href: "https://hashscan.io/testnet/contract/0x16eFE46De1CdA06Be455607A63514319aE130010", label: "MeshEscrow" },
      { href: "https://hashscan.io/testnet/topic/0.0.11333951", label: "Audit log (HCS)" },
    ],
  },
  {
    title: "Project",
    links: [
      { href: "https://github.com/anuraggdubey/Mesh", label: "GitHub" },
      { href: "/docs/security", label: "Trust model & limits" },
      { href: "/docs/providers", label: "Run a provider" },
    ],
  },
];

export function SiteFooter() {
  return (
    <footer className="mt-24 border-t border-line print:hidden">
      <div className="mx-auto grid max-w-6xl gap-10 px-5 py-14 md:grid-cols-[1.5fr_repeat(4,1fr)]">
        <div>
          <Link href="/" className="flex items-center gap-3">
            <Logo tile />
            <span>
              <span className="block font-display text-base font-medium leading-tight">Mesh</span>
              <span className="block text-xs text-muted">Verifiable spare compute</span>
            </span>
          </Link>
          <p className="mt-4 max-w-xs text-sm leading-relaxed text-muted">
            Split a job across machines, spot-check the work, slash a lie, and keep the receipt on Hedera.
          </p>
        </div>
        {COLS.map((c) => (
          <div key={c.title}>
            <h3 className="font-display text-sm font-medium">{c.title}</h3>
            <ul className="mt-4 space-y-2.5">
              {c.links.map((l) => (
                <li key={l.label}>
                  <Link href={l.href} className="text-sm text-muted transition hover:text-foreground" {...(l.href.startsWith("http") ? { target: "_blank", rel: "noreferrer" } : {})}>
                    {l.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <div className="border-t border-line">
        <div className="mx-auto flex max-w-6xl flex-col gap-2 px-5 py-6 text-xs text-muted sm:flex-row sm:items-center sm:justify-between">
          <p>Built for ETHGlobal Mumbai 2026 on Hedera testnet. A hackathon project: not audited, test funds only.</p>
          <p>x402 · World ID · 0G · Hedera</p>
        </div>
      </div>
    </footer>
  );
}
