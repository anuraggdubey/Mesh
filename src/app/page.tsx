import Link from "next/link";
import type { ReactNode } from "react";
import { HeroVisual } from "@/components/site/hero-visual";
import {
  IconArrowRight,
  IconBot,
  IconDice,
  IconImage,
  IconLayers,
  IconLock,
  IconReceipt,
  IconScale,
  IconSearch,
  IconShield,
  IconSparkles,
  IconSplit,
  IconUserCheck,
  IconWallet,
} from "@/components/site/icons";

const IDEA = [
  { icon: <IconLock />, stat: "64", statLabel: "tiles per job", title: "Commit to every answer", body: "Every provider signs a claim over its tiles, and the API puts one Merkle root of all of them on chain. After that, no tile can change." },
  { icon: <IconDice />, stat: "25%", statLabel: "re-checked at random", title: "Check a sample, not everything", body: "A seed from a block that does not exist yet picks the tiles to recompute. A cheater has to be right about every tile it did not compute." },
  { icon: <IconScale />, stat: "50/25/25", statLabel: "slash split", title: "A lie loses the stake", body: "A fraud proof slashes the provider: half goes to the requester, a quarter to the verifier, a quarter is retained." },
  { icon: <IconShield />, stat: "45 s", statLabel: "challenge window", title: "Money moves after the proof", body: "The payment sits in escrow while the window is open. Honest work is paid out when it closes; a proven lie is refunded." },
];

const STEPS = [
  { icon: <IconWallet />, title: "Ask and pay", body: "A person or an agent posts a job. The API quotes a price over x402 and the client pays on Hedera." },
  { icon: <IconSplit />, title: "Split", body: "The job is cut into 64 tiles and dealt to staked providers who run a pinned Docker image offline." },
  { icon: <IconLock />, title: "Commit", body: "Providers sign their claims. The Merkle root goes on chain and the challenge window opens." },
  { icon: <IconSearch />, title: "Check", body: "The verifier recomputes a seeded sample and compares every hash." },
  { icon: <IconScale />, title: "Settle", body: "All clear: providers are paid. A mismatch: stake slashed, requester refunded." },
  { icon: <IconReceipt />, title: "Receipt", body: "Every step is on a Hedera audit log and in a receipt anyone can open." },
];

const STATS = [
  { value: "99.9%", label: "cheater caught (20 bad tiles, 16 sampled)" },
  { value: "4.1 s", label: "small render, measured" },
  { value: "28.9 s", label: "full render, measured" },
  { value: "67", label: "contract tests passing" },
];

const BENEFITS = [
  { icon: <IconWallet />, title: "Pay per job over x402", body: "No subscriptions. A job is bought with one signed Hedera payment and starts only after it settles." },
  { icon: <IconBot />, title: "Agents that stay in budget", body: "Budgets, per-job caps and allowlists bound what an agent can spend. Large spends need a human to approve that exact job." },
  { icon: <IconShield />, title: "Results you can check", body: "Deterministic work means a tile has exactly one right answer, so a sample recompute can expose a lie." },
  { icon: <IconUserCheck />, title: "One human, one provider", body: "A World ID proof of a unique human is needed to register, so one person cannot run a hundred fake providers." },
  { icon: <IconReceipt />, title: "A public receipt", body: "Hashes, payment, verdict and transactions are in the receipt the contract holds, plus a Hedera audit log." },
  { icon: <IconSparkles />, title: "A traceable AI review", body: "A vision model on 0G reviews each finished render. Its request ID and verification status go on the receipt." },
];

const WORKLOADS = [
  { icon: <IconImage />, name: "Tiny", tag: null, meta: "4 tiles · 0.1 HBAR", body: "A 64 × 64 render in a second or two. The quickest way to see the whole flow end to end." },
  { icon: <IconLayers />, name: "Small", tag: "Popular", meta: "64 tiles · 0.5 HBAR", body: "A 2048 × 2048 Mandelbrot in about five seconds across two providers. The default for demos." },
  { icon: <IconLayers />, name: "Full", tag: null, meta: "64 tiles · 1 HBAR", body: "The same image at 8× the depth, about thirty seconds of real compute. Heavy enough to feel it." },
];

const PARTNERS = [
  { name: "Hedera", body: "x402 payments settle on Hedera, the stake, escrow and receipt contracts run on its EVM, and every event is written to a Consensus Service topic." },
  { name: "World", body: "IDKit proves a provider is a unique human, and a World proof approves large agent spends, tied to one job." },
  { name: "0G", body: "A vision model on 0G Private Computer reviews each finished render, with its request ID and verification status on the receipt." },
];

const LIMITS = [
  ["One trusted verifier", "A single key decides a fraud claim. Anyone can re-run a sampled tile to audit it."],
  ["Sampling is probabilistic", "A provider that corrupts one tile is usually missed. Detection rises fast with more bad tiles."],
  ["Test funds only", "Everything runs on Hedera testnet, and the escrow mirrors the x402 payment with a test token."],
  ["Not audited", "The contracts have tests but no outside audit. Do not put real money in."],
];

const FAQ = [
  { q: "What does Mesh actually compute?", a: "Today it renders a deterministic Mandelbrot image in 64 tiles. It is a stand-in for any job whose output is exactly reproducible: the same image and input always give the same bytes, so a checker can tell a lie from the truth." },
  { q: "Why not just trust the providers?", a: "Because a stranger's machine can return anything. Mesh makes lying a losing bet: a sample of the work is recomputed, a failed check slashes the provider's stake, and the payment only moves after the challenge window." },
  { q: "Is the cheater always caught?", a: "No, and we do not claim that. The chance of catching a provider that corrupts c of 64 tiles with a sample of k is 1 - C(64-c, k) / C(64, k). With 20 bad tiles and 16 sampled it is 99.9%. A provider that corrupts only one tile is usually missed, which is why the stake and the sample size are tuned together." },
  { q: "Who checks the checker?", a: "Today the verifier is a single key the contract trusts. That is a known limit of version one. The recompute is public and reproducible, so anyone can re-run a sampled tile and see whether the verifier was honest." },
  { q: "What does the 0G part do?", a: "After a render is final, a vision model on 0G Private Computer reviews the image. The request ID and the TEE verification status are stored on the receipt and in the audit log. Remove 0G and the review, its request ID and its verification badge disappear." },
  { q: "Is this real money?", a: "It is Hedera testnet. The x402 payment is a real Hedera transaction you can open on HashScan, but the funds are test HBAR, and the escrow contract mirrors that payment with a test token." },
];

function SectionHead({ eyebrow, title, children }: { eyebrow: string; title: ReactNode; children?: ReactNode }) {
  return (
    <div className="mx-auto max-w-2xl text-center">
      <p className="eyebrow">{eyebrow}</p>
      <h2 className="mt-3 text-3xl font-medium leading-tight tracking-tight sm:text-4xl">{title}</h2>
      {children && <p className="mt-4 text-base leading-relaxed text-muted sm:text-lg">{children}</p>}
    </div>
  );
}

export default function Landing() {
  return (
    <>
      {/* ───────── hero ───────── */}
      <section className="px-5 pb-20 pt-16 md:pb-28 md:pt-24">
        <div className="mx-auto max-w-3xl text-center">
          <p className="eyebrow">Verifiable compute, on Hedera</p>
          <h1 className="mt-5 text-5xl font-medium leading-[1.05] tracking-[-0.03em] sm:text-6xl">
            Spare compute
            <br />
            you can prove.
          </h1>
          <p className="mx-auto mt-6 max-w-xl text-lg leading-relaxed text-muted">
            Connect a wallet, tell the Mesh agent what you need, and it plans the job with 0G and pays for it on Hedera. Mesh checks a random sample of the work, slashes anyone who lies, and gives you a receipt for every step.
          </p>
          <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
            <Link href="/app" className="btn-primary">
              Connect wallet and run a job
            </Link>
            <Link href="/provider/verify" className="btn-secondary">
              Become a provider
            </Link>
          </div>
        </div>
        <div className="mt-16 md:mt-20">
          <HeroVisual />
        </div>
      </section>

      {/* ───────── the idea ───────── */}
      <section id="problem" className="mx-auto max-w-6xl px-5 py-20 md:py-28" aria-labelledby="problem-h">
        <SectionHead eyebrow="The idea" title={<span id="problem-h">Lying should cost more than it pays</span>}>
          Renting a stranger&apos;s computer only works if you can tell a real answer from a fake one. Four rules make that something a chain can enforce.
        </SectionHead>
        <div className="mt-14 grid gap-5 md:grid-cols-2">
          {IDEA.map((c) => (
            <div key={c.title} className="card p-7">
              <div className="flex items-start justify-between">
                <span className="icon-tile">{c.icon}</span>
                <div className="text-right">
                  <p className="font-display text-2xl font-normal tabular-nums">{c.stat}</p>
                  <p className="text-xs text-muted">{c.statLabel}</p>
                </div>
              </div>
              <h3 className="mt-6 text-lg font-medium tracking-tight">{c.title}</h3>
              <p className="mt-2 text-[15px] leading-relaxed text-muted">{c.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ───────── how it works ───────── */}
      <section id="how" className="bg-surface-2/60 py-20 md:py-28" aria-labelledby="how-h">
        <div className="mx-auto max-w-6xl px-5">
          <SectionHead eyebrow="How it works" title={<span id="how-h">From a payment to a receipt in six steps</span>}>
            Mesh handles the matching, the checking and the settling, so you only see a result you can trust.
          </SectionHead>
          <ol className="mt-14 grid gap-x-4 gap-y-10 sm:grid-cols-2 lg:grid-cols-6">
            {STEPS.map((s, i) => (
              <li key={s.title} className="relative text-center">
                <span className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-surface text-accent shadow-[var(--shadow-border),var(--shadow-soft)]">{s.icon}</span>
                {i < STEPS.length - 1 && (
                  <span className="absolute left-[calc(50%+2.25rem)] top-5 hidden text-accent/40 lg:block" aria-hidden="true">
                    <IconArrowRight className="h-4 w-4" />
                  </span>
                )}
                <h3 className="mt-4 text-[15px] font-medium">{s.title}</h3>
                <p className="mx-auto mt-1.5 max-w-[190px] text-sm leading-relaxed text-muted">{s.body}</p>
              </li>
            ))}
          </ol>
          <p className="mt-12 text-center text-sm text-muted">
            Want the detail?{" "}
            <Link href="/docs/how-it-works" className="text-accent underline underline-offset-4">
              The verification model
            </Link>{" "}
            covers the Merkle tree, the claim signature and the fraud proof.
          </p>
        </div>
      </section>

      {/* ───────── numbers ───────── */}
      <section className="mx-auto max-w-6xl px-5 py-14 md:py-20" aria-label="Numbers">
        <dl className="grid grid-cols-2 gap-8 text-center md:grid-cols-4">
          {STATS.map((s) => (
            <div key={s.label}>
              <dt className="font-display text-4xl font-normal tracking-tight tabular-nums">{s.value}</dt>
              <dd className="mx-auto mt-2 max-w-[180px] text-sm text-muted">{s.label}</dd>
            </div>
          ))}
        </dl>
      </section>

      {/* ───────── benefits ───────── */}
      <section id="benefits" className="mx-auto max-w-6xl px-5 py-20 md:py-28" aria-labelledby="benefits-h">
        <SectionHead eyebrow="Benefits" title={<span id="benefits-h">Built for requesters, providers and agents</span>}>
          Whether you are running a job, lending a machine or letting an agent do the buying, the rules are the same and the proof is public.
        </SectionHead>
        <div className="mt-14 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {BENEFITS.map((b) => (
            <div key={b.title} className="card p-6">
              <span className="icon-tile">{b.icon}</span>
              <h3 className="mt-5 text-base font-medium tracking-tight">{b.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted">{b.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ───────── workloads ───────── */}
      <section id="workloads" className="mx-auto max-w-6xl px-5 pb-20 md:pb-28" aria-labelledby="workloads-h">
        <SectionHead eyebrow="Supported workloads" title={<span id="workloads-h">Deterministic renders, three sizes</span>}>
          One job type today: a Mandelbrot render with an exactly reproducible result. Matrix and inference jobs are not built yet.
        </SectionHead>
        <div className="mt-14 grid gap-5 md:grid-cols-3">
          {WORKLOADS.map((w) => (
            <div key={w.name} className="card p-6">
              <div className="flex items-center justify-between">
                <span className="icon-tile">{w.icon}</span>
                {w.tag && <span className="rounded-full bg-accent-muted px-2.5 py-0.5 text-xs font-medium text-accent">{w.tag}</span>}
              </div>
              <h3 className="mt-5 text-lg font-medium tracking-tight">{w.name}</h3>
              <p className="mt-1 font-mono text-xs text-muted">{w.meta}</p>
              <p className="mt-3 text-sm leading-relaxed text-muted">{w.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ───────── built on ───────── */}
      <section id="partners" className="bg-surface-2/60 py-20 md:py-28" aria-labelledby="partners-h">
        <div className="mx-auto max-w-6xl px-5">
          <SectionHead eyebrow="Built on" title={<span id="partners-h">Each partner does a job the product needs</span>} />
          <div className="mt-14 grid gap-5 md:grid-cols-3">
            {PARTNERS.map((p) => (
              <div key={p.name} className="card p-7">
                <h3 className="font-display text-xl font-medium tracking-tight">{p.name}</h3>
                <p className="mt-3 text-sm leading-relaxed text-muted">{p.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ───────── honest limits ───────── */}
      <section id="limits" className="mx-auto max-w-6xl px-5 py-20 md:py-28" aria-labelledby="limits-h">
        <SectionHead eyebrow="Honest limits" title={<span id="limits-h">What this version does not do</span>} />
        <ul className="mt-14 grid gap-5 sm:grid-cols-2">
          {LIMITS.map(([t, b]) => (
            <li key={t} className="card p-6">
              <p className="font-display text-base font-medium">{t}</p>
              <p className="mt-2 text-sm leading-relaxed text-muted">{b}</p>
            </li>
          ))}
        </ul>
      </section>

      {/* ───────── faq ───────── */}
      <section className="bg-surface-2/60 py-20 md:py-28" aria-labelledby="faq-h">
        <div className="mx-auto max-w-3xl px-5">
          <SectionHead eyebrow="FAQ" title={<span id="faq-h">Common questions</span>}>
            Everything you need to know before you start.
          </SectionHead>
          <div className="card mt-12 divide-y divide-line">
            {FAQ.map((f) => (
              <details key={f.q} className="group px-6 py-5">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-6 text-[15px] font-medium">
                  {f.q}
                  <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-accent-muted text-accent transition group-open:rotate-45" aria-hidden="true">
                    +
                  </span>
                </summary>
                <p className="mt-3 text-sm leading-relaxed text-muted">{f.a}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      {/* ───────── cta ───────── */}
      <section className="px-5 pb-8 pt-24 text-center md:pt-32" aria-labelledby="cta-h">
        <h2 id="cta-h" className="mx-auto max-w-xl text-4xl font-medium leading-tight tracking-tight sm:text-5xl">
          Ready to see a cheat get caught?
        </h2>
        <p className="mx-auto mt-4 max-w-lg text-lg text-muted">Run a render, watch the tiles arrive, and read the receipt. It takes under a minute.</p>
        <div className="mt-9 flex flex-wrap justify-center gap-3">
          <Link href="/provider/verify" className="btn-primary">
            Become a provider
          </Link>
          <Link href="/app" className="btn-secondary">
            Connect wallet and run a job
          </Link>
        </div>
      </section>
    </>
  );
}
