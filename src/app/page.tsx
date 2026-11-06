import Link from "next/link";
import type { ReactNode } from "react";
import { HeroVisual } from "@/components/site/hero-visual";

const STEPS = [
  { n: "01", title: "Ask and pay", body: "A person or an AI agent posts a job. The API answers with a price over x402. The client signs a Hedera payment, the facilitator settles it, and only then does the job exist." },
  { n: "02", title: "Split across machines", body: "The job is cut into 64 tiles and dealt to staked providers. Each provider runs a pinned Docker image offline, so the same input always produces the same bytes." },
  { n: "03", title: "Commit to the answer", body: "Every tile is hashed. Each provider signs a claim over its tiles, and the API builds a Merkle root over all of them. The root goes on chain and a challenge window opens." },
  { n: "04", title: "Spot-check at random", body: "The verifier picks a sample of tiles using a seed the providers could not know in advance, and recomputes them. A cheater has to be right about every tile it did not compute." },
  { n: "05", title: "Settle by what was proven", body: "All clear: the contract pays the providers. A mismatch: a fraud proof goes on chain, the provider's stake is slashed, and the requester is refunded in the same transaction." },
  { n: "06", title: "Keep the receipt", body: "Every step is written to a Hedera Consensus Service topic and the receipt endpoint. Anyone can check who ran what, what was paid, and what happened." },
];

const DETECTION = [
  { bad: 6, k8: "57%", k16: "85%", k32: "99%" },
  { bad: 12, k8: "84%", k16: "98%", k32: "99.9%" },
  { bad: 20, k8: "96%", k16: "99.9%", k32: "100%" },
];

const FAQ = [
  { q: "What does Mesh actually compute?", a: "Today it renders a deterministic Mandelbrot image in 64 tiles. It is a stand-in for any job whose output is exactly reproducible: the same image and input always give the same bytes, so a checker can tell a lie from the truth." },
  { q: "Why not just trust the providers?", a: "Because a stranger's machine can return anything. Mesh makes lying a losing bet: a sample of the work is recomputed, a failed check slashes the provider's stake, and the payment only moves after the challenge window." },
  { q: "Is the cheater always caught?", a: "No, and we do not claim that. The chance of catching a provider that corrupts c of 64 tiles with a sample of k is 1 - C(64-c, k) / C(64, k). With 20 bad tiles and 16 sampled it is 99.9%. A provider that corrupts only one tile is usually missed, which is why the stake and the sample size are tuned together." },
  { q: "Who checks the checker?", a: "Today the verifier is a single key the contract trusts. That is a known limit of version one. The recompute is public and reproducible, so anyone can re-run a sampled tile and see whether the verifier was honest." },
  { q: "What does the 0G part do?", a: "After a render is final, a vision model on 0G Private Computer reviews the image. The request ID and the TEE verification status are stored on the receipt and in the audit log. Remove 0G and the review, its request ID and its verification badge disappear." },
  { q: "Is this real money?", a: "It is Hedera testnet. The x402 payment is a real Hedera transaction you can open on HashScan, but the funds are test HBAR, and the escrow contract mirrors that payment with a test token." },
];

function Eyebrow({ children }: { children: ReactNode }) {
  return <p className="text-xs font-semibold uppercase tracking-[0.18em] text-accent">{children}</p>;
}

function Card({ title, children, tag }: { title: string; children: ReactNode; tag?: string }) {
  return (
    <div className="group relative overflow-hidden rounded-2xl border border-line bg-surface p-6 transition hover:border-white/20">
      <div className="pointer-events-none absolute -right-10 -top-10 h-32 w-32 rounded-full bg-accent/0 blur-2xl transition group-hover:bg-accent/10" aria-hidden="true" />
      {tag && <p className="mb-3 text-[11px] font-semibold uppercase tracking-widest text-muted">{tag}</p>}
      <h3 className="text-lg font-semibold tracking-tight">{title}</h3>
      <div className="mt-2 text-sm leading-relaxed text-muted">{children}</div>
    </div>
  );
}

export default function Landing() {
  return (
    <>
      {/* ───────── hero ───────── */}
      <section className="relative overflow-hidden">
        <div className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[620px] bg-[radial-gradient(60%_60%_at_50%_0%,rgba(198,244,50,0.10),transparent_70%)]" aria-hidden="true" />
        <div className="pointer-events-none absolute inset-0 -z-10 opacity-[0.35] [background-image:radial-gradient(rgba(255,255,255,0.09)_1px,transparent_1px)] [background-size:22px_22px] [mask-image:radial-gradient(70%_60%_at_50%_30%,black,transparent)]" aria-hidden="true" />
        <div className="mx-auto grid max-w-6xl items-center gap-16 px-5 pb-28 pt-20 lg:grid-cols-[1.05fr_0.95fr] lg:pt-28">
          <div>
            <p className="inline-flex items-center gap-2 rounded-full border border-line bg-surface/70 px-3 py-1 text-xs text-muted">
              <span className="h-1.5 w-1.5 rounded-full bg-accent" />
              Live on Hedera testnet · x402 · World ID · 0G
            </p>
            <h1 className="mt-6 text-5xl font-semibold leading-[1.02] tracking-[-0.035em] sm:text-6xl lg:text-7xl">
              Spare compute
              <br />
              you can <em className="font-serif text-[1.08em] font-normal italic text-accent">prove.</em>
            </h1>
            <p className="mt-6 max-w-xl text-lg leading-relaxed text-muted">
              Mesh splits a job across machines it does not trust, spot-checks the work, slashes anyone who lies, and keeps the receipt on Hedera. Agents pay for it by
              themselves, and a human approves the big spends.
            </p>
            <div className="mt-9 flex flex-wrap items-center gap-3">
              <Link href="/app" className="rounded-full bg-accent px-6 py-3 text-sm font-semibold text-accent-ink transition hover:brightness-110">
                Run a job
              </Link>
              <Link href="/docs" className="rounded-full border border-line bg-surface/60 px-6 py-3 text-sm font-medium transition hover:border-white/25">
                Read the docs
              </Link>
              <Link href="/#how" className="px-3 py-3 text-sm text-muted transition hover:text-foreground">
                How it works →
              </Link>
            </div>
            <dl className="mt-14 grid max-w-xl grid-cols-2 gap-x-8 gap-y-6 sm:grid-cols-4">
              {[
                ["64", "tiles per job"],
                ["25%", "re-checked at random"],
                ["45 s", "challenge window"],
                ["50/25/25", "slash split"],
              ].map(([v, l]) => (
                <div key={l}>
                  <dt className="text-2xl font-semibold tracking-tight tabular-nums">{v}</dt>
                  <dd className="mt-1 text-xs text-muted">{l}</dd>
                </div>
              ))}
            </dl>
          </div>
          <HeroVisual />
        </div>
      </section>

      {/* ───────── what it is ───────── */}
      <section className="mx-auto max-w-6xl px-5 py-20" aria-labelledby="what">
        <div className="max-w-2xl">
          <Eyebrow>What Mesh is</Eyebrow>
          <h2 id="what" className="mt-3 text-3xl font-semibold leading-tight tracking-tight sm:text-4xl">
            A marketplace where nobody has to be trusted, because lying <em className="font-serif font-normal italic text-accent">costs more</em> than it pays.
          </h2>
          <p className="mt-4 text-muted">
            Renting out a computer to a stranger works only if you can tell a real answer from a fake one. Mesh turns that into three things a chain can enforce.
          </p>
        </div>
        <div className="mt-10 grid gap-4 md:grid-cols-3">
          <Card tag="Pay" title="Machines pay for themselves">
            Jobs are bought over x402: the server quotes a price, the client signs a Hedera payment, and a facilitator settles it. An AI agent can do the whole thing with no
            human click, inside a budget you set.
          </Card>
          <Card tag="Prove" title="The work can be re-checked">
            Renders are deterministic, so a tile has exactly one correct answer. Providers commit to every tile in a Merkle tree, and a seeded sample is recomputed after the
            commitment, when it is too late to change anything.
          </Card>
          <Card tag="Punish" title="A lie loses the stake">
            Providers lock a stake before they work. A fraud proof on chain slashes it, refunds the requester, and pays the verifier. Honest work is paid from escrow once the
            window closes.
          </Card>
        </div>
      </section>

      {/* ───────── how it works ───────── */}
      <section id="how" className="border-y border-line bg-surface/40" aria-labelledby="how-h">
        <div className="mx-auto max-w-6xl px-5 py-24">
          <div className="max-w-2xl">
            <Eyebrow>How it works</Eyebrow>
            <h2 id="how-h" className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">
              From a payment to a receipt, in six steps.
            </h2>
          </div>
          <ol className="mt-12 grid gap-px overflow-hidden rounded-3xl border border-line bg-line md:grid-cols-2 lg:grid-cols-3">
            {STEPS.map((s) => (
              <li key={s.n} className="bg-background p-7 transition hover:bg-surface">
                <span className="font-mono text-xs text-accent">{s.n}</span>
                <h3 className="mt-4 text-lg font-semibold tracking-tight">{s.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted">{s.body}</p>
              </li>
            ))}
          </ol>
          <p className="mt-8 text-sm text-muted">
            Want the detail? <Link href="/docs/how-it-works" className="text-accent underline-offset-4 hover:underline">The verification model</Link> covers the Merkle
            tree, the claim signature and the fraud proof.
          </p>
        </div>
      </section>

      {/* ───────── the proof ───────── */}
      <section id="proof" className="mx-auto max-w-6xl px-5 py-24" aria-labelledby="proof-h">
        <div className="grid gap-12 lg:grid-cols-[1fr_1fr] lg:items-center">
          <div>
            <Eyebrow>The proof</Eyebrow>
            <h2 id="proof-h" className="mt-3 text-3xl font-semibold leading-tight tracking-tight sm:text-4xl">
              Cheat on a few tiles and the odds are <em className="font-serif font-normal italic text-accent">against you.</em>
            </h2>
            <p className="mt-4 text-muted">
              A provider that corrupts <strong className="text-foreground">c</strong> of 64 tiles is caught when the verifier&apos;s sample of{" "}
              <strong className="text-foreground">k</strong> tiles hits at least one of them. The chance is 1 − C(64−c, k) / C(64, k). We ran the production sampler 1,000 times for
              each cell below.
            </p>
            <ul className="mt-6 space-y-3 text-sm text-muted">
              <li className="flex gap-3"><span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />The seed comes from a block that does not exist until the claim is posted, so a provider cannot aim its cheating away from the sample.</li>
              <li className="flex gap-3"><span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />The Merkle leaf includes the provider&apos;s address, so a bad tile is pinned to the one who signed it.</li>
              <li className="flex gap-3"><span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />Honest limit: one bad tile is easy to miss. The stake has to be sized for that.</li>
            </ul>
          </div>
          <div className="overflow-hidden rounded-3xl border border-line bg-surface">
            <div className="border-b border-line px-6 py-4">
              <p className="text-sm font-medium">Chance a cheater is caught</p>
              <p className="text-xs text-muted">64 tiles · measured over 1,000 simulated runs</p>
            </div>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-muted">
                  <th className="px-6 py-3 font-medium">Bad tiles</th>
                  <th className="px-3 py-3 font-medium">k = 8</th>
                  <th className="px-3 py-3 font-medium text-accent">k = 16 (default)</th>
                  <th className="px-3 py-3 font-medium">k = 32</th>
                </tr>
              </thead>
              <tbody>
                {DETECTION.map((r) => (
                  <tr key={r.bad} className="border-t border-line">
                    <td className="px-6 py-4 font-mono">{r.bad}</td>
                    <td className="px-3 py-4 tabular-nums text-muted">{r.k8}</td>
                    <td className="px-3 py-4 font-semibold tabular-nums">{r.k16}</td>
                    <td className="px-3 py-4 tabular-nums text-muted">{r.k32}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="border-t border-line px-6 py-3 text-xs text-muted">Simulates the sampler only. See docs/QA.md in the repo for how it was run.</p>
          </div>
        </div>
      </section>

      {/* ───────── agents ───────── */}
      <section className="border-y border-line bg-surface/40" aria-labelledby="agents-h">
        <div className="mx-auto grid max-w-6xl gap-12 px-5 py-24 lg:grid-cols-2 lg:items-center">
          <div>
            <Eyebrow>For agents</Eyebrow>
            <h2 id="agents-h" className="mt-3 text-3xl font-semibold leading-tight tracking-tight sm:text-4xl">
              An agent buys compute. A human only <em className="font-serif font-normal italic text-accent">approves the big spends.</em>
            </h2>
            <p className="mt-4 text-muted">
              The scripted agent finds the endpoint, pays over x402 and follows the job to the end. It runs inside spending controls: a total budget, a per-job cap, a list of
              presets and payees it may use, and one asset. Above a threshold it stops and asks a person to approve that exact job through World. A denied or expired approval
              creates no job and moves no money.
            </p>
            <Link href="/docs/payments" className="mt-6 inline-block text-sm text-accent underline-offset-4 hover:underline">
              How payments and approvals work →
            </Link>
          </div>
          <pre className="overflow-x-auto rounded-2xl border border-line bg-[#05060a] p-5 font-mono text-[12.5px] leading-7 text-muted shadow-2xl">
            <code>
              <span className="text-foreground/50">$</span> <span className="text-foreground">npm run agent -- small</span>
              {"\n"}agent: 0.0.11333706 → budget 500000, per-job cap 500000
              {"\n"}agent: paying 50000000 of 0.0.0 to 0.0.11327733
              {"\n"}agent: job 0x83c4…b268 created (small); spent 500000
              {"\n"}
              <span className="text-accent">agent: paid on Hedera, transaction 0.0.9185802@1793937163.341350400</span>
              {"\n"}agent: job 0x83c41246… is paid
              {"\n"}
              <span className="text-foreground/40"># real output from the first live run on Hedera testnet</span>
            </code>
          </pre>
        </div>
      </section>

      {/* ───────── two sides ───────── */}
      <section className="mx-auto max-w-6xl px-5 py-24" aria-labelledby="sides-h">
        <div className="max-w-2xl">
          <Eyebrow>Two sides</Eyebrow>
          <h2 id="sides-h" className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">
            Rent compute, or lend it.
          </h2>
        </div>
        <div className="mt-10 grid gap-4 md:grid-cols-2">
          <div className="rounded-3xl border border-line bg-surface p-8">
            <p className="text-xs font-semibold uppercase tracking-widest text-muted">Requesters</p>
            <h3 className="mt-3 text-2xl font-semibold tracking-tight">Pay once, get a checked result.</h3>
            <ul className="mt-5 space-y-2.5 text-sm text-muted">
              <li>• Pick a size: tiny from 0.1 HBAR, small 0.5, full 1.</li>
              <li>• Watch the image assemble tile by tile as providers finish.</li>
              <li>• If a provider cheats you are refunded in the fraud transaction.</li>
              <li>• Every result has a receipt and an AI review from 0G, with its request ID.</li>
            </ul>
            <Link href="/app" className="mt-7 inline-block rounded-full bg-accent px-5 py-2.5 text-sm font-semibold text-accent-ink transition hover:brightness-110">
              Run a job
            </Link>
          </div>
          <div className="rounded-3xl border border-line bg-surface p-8">
            <p className="text-xs font-semibold uppercase tracking-widest text-muted">Providers</p>
            <h3 className="mt-3 text-2xl font-semibold tracking-tight">Lend a machine, one human per profile.</h3>
            <ul className="mt-5 space-y-2.5 text-sm text-muted">
              <li>• Docker is the only requirement. No shared network or matching operating system.</li>
              <li>• Verify with World ID so one person cannot run a hundred fake providers.</li>
              <li>• Stake collateral, run the pinned image offline, sign your claim.</li>
              <li>• Get paid from escrow when the window closes. Cheat and lose the stake.</li>
            </ul>
            <Link href="/provider/verify" className="mt-7 inline-block rounded-full border border-line px-5 py-2.5 text-sm font-medium transition hover:border-white/25">
              Become a provider
            </Link>
          </div>
        </div>
      </section>

      {/* ───────── built on ───────── */}
      <section id="partners" className="border-y border-line bg-surface/40" aria-labelledby="partners-h">
        <div className="mx-auto max-w-6xl px-5 py-24">
          <div className="max-w-2xl">
            <Eyebrow>Built on</Eyebrow>
            <h2 id="partners-h" className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">
              Each partner does a job the product cannot do without.
            </h2>
          </div>
          <div className="mt-10 grid gap-4 md:grid-cols-3">
            <Card tag="Hedera" title="Money, contracts and the audit log">
              <ul className="space-y-1.5">
                <li>• x402 payments settle on Hedera through a facilitator.</li>
                <li>• Stake, escrow and receipt contracts run on Hedera&apos;s EVM.</li>
                <li>• Every event is written to a Consensus Service topic.</li>
              </ul>
            </Card>
            <Card tag="World" title="A human behind the profile and the spend">
              <ul className="space-y-1.5">
                <li>• IDKit proof of a unique human to register a provider.</li>
                <li>• A fresh World approval for a large agent spend, tied to one job.</li>
                <li>• A bad or reused proof creates nothing.</li>
              </ul>
            </Card>
            <Card tag="0G" title="An AI review you can trace">
              <ul className="space-y-1.5">
                <li>• A vision model on 0G Private Computer reviews each finished render.</li>
                <li>• The request ID and verification status go on the receipt.</li>
                <li>• The badge says verified only when the signature checks out.</li>
              </ul>
            </Card>
          </div>
        </div>
      </section>

      {/* ───────── honest limits ───────── */}
      <section className="mx-auto max-w-6xl px-5 py-24" aria-labelledby="limits-h">
        <div className="grid gap-10 lg:grid-cols-[0.8fr_1.2fr]">
          <div>
            <Eyebrow>Honest limits</Eyebrow>
            <h2 id="limits-h" className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">
              What this version does not do.
            </h2>
          </div>
          <ul className="grid gap-3 sm:grid-cols-2">
            {[
              ["One trusted verifier", "A single key decides a fraud claim. Anyone can re-run a sampled tile to audit it."],
              ["Sampling is probabilistic", "A provider that corrupts one tile is usually missed. Detection rises fast with more bad tiles."],
              ["Test funds only", "Everything runs on Hedera testnet. The escrow mirrors the x402 payment with a test token."],
              ["Not audited", "The contracts have tests but no outside audit. Do not put real money in."],
            ].map(([t, b]) => (
              <li key={t} className="rounded-2xl border border-line bg-surface p-5">
                <p className="text-sm font-semibold">{t}</p>
                <p className="mt-1.5 text-sm leading-relaxed text-muted">{b}</p>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* ───────── faq ───────── */}
      <section className="mx-auto max-w-3xl px-5 pb-8" aria-labelledby="faq-h">
        <Eyebrow>Questions</Eyebrow>
        <h2 id="faq-h" className="mt-3 text-3xl font-semibold tracking-tight">
          Things people ask.
        </h2>
        <div className="mt-8 divide-y divide-line rounded-2xl border border-line bg-surface">
          {FAQ.map((f) => (
            <details key={f.q} className="group px-6 py-5">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-6 text-[15px] font-medium">
                {f.q}
                <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full border border-line text-muted transition group-open:rotate-45" aria-hidden="true">+</span>
              </summary>
              <p className="mt-3 text-sm leading-relaxed text-muted">{f.a}</p>
            </details>
          ))}
        </div>
      </section>

      {/* ───────── cta ───────── */}
      <section className="mx-auto max-w-6xl px-5 pt-20">
        <div className="relative overflow-hidden rounded-[2rem] border border-line bg-surface px-8 py-16 text-center sm:px-16">
          <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(50%_80%_at_50%_120%,rgba(198,244,50,0.22),transparent_70%)]" aria-hidden="true" />
          <h2 className="relative mx-auto max-w-2xl text-4xl font-semibold leading-tight tracking-tight sm:text-5xl">
            See a cheat get <em className="font-serif font-normal italic text-accent">caught.</em>
          </h2>
          <p className="relative mx-auto mt-4 max-w-lg text-muted">Run a render, watch the tiles arrive, and read the receipt. It takes under a minute.</p>
          <div className="relative mt-8 flex flex-wrap justify-center gap-3">
            <Link href="/app" className="rounded-full bg-accent px-7 py-3 text-sm font-semibold text-accent-ink transition hover:brightness-110">
              Run a job
            </Link>
            <Link href="/docs" className="rounded-full border border-line px-7 py-3 text-sm font-medium transition hover:border-white/25">
              Read the docs
            </Link>
          </div>
        </div>
      </section>
    </>
  );
}
