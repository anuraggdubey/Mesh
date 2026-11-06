/**
 * The hero animation: a job's 64 tiles fill in, a cluster turns out to be tampered with, and the verifier catches it.
 * Pure CSS (one 14 s loop), deterministic, no client JavaScript. The numbers are illustrative.
 */
const BAD = new Set([18, 19, 26, 27, 34]);

function tileColor(i: number): string {
  const r = Math.floor(i / 8);
  const c = i % 8;
  const d = Math.hypot(r - 3.5, c - 3.5) / 5; // 0 at the centre, ~1 at the corners
  const hue = 78 + d * 70; // lime to teal
  const light = 62 - d * 26;
  return `hsl(${hue.toFixed(0)} 88% ${light.toFixed(0)}%)`;
}

export function HeroVisual() {
  return (
    <div className="relative mx-auto w-full max-w-[520px]">
      {/* glow */}
      <div className="pointer-events-none absolute -inset-10 -z-10 rounded-full bg-accent/10 blur-3xl" aria-hidden="true" />

      <div className="rounded-3xl border border-line bg-surface/80 p-4 shadow-[0_30px_80px_-20px_rgba(0,0,0,0.8)] backdrop-blur">
        <div className="mb-3 flex items-center justify-between px-1 text-xs text-muted">
          <span className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-accent shadow-[0_0_10px_var(--accent)]" />
            render · small · 64 tiles
          </span>
          <span className="font-mono">2 providers</span>
        </div>
        <div className="grid grid-cols-8 gap-1.5" role="img" aria-label="A grid of 64 tiles being computed, a few of which turn red when the verifier catches tampering">
          {Array.from({ length: 64 }, (_, i) => {
            const r = Math.floor(i / 8);
            const c = i % 8;
            return (
              <div
                key={i}
                className={`hero-tile aspect-square rounded-[5px] ${BAD.has(i) ? "bad" : ""}`}
                style={{ ["--tile" as string]: tileColor(i), animationDelay: `${((r + c) * 0.16 + (i % 3) * 0.05).toFixed(2)}s` }}
              />
            );
          })}
        </div>
        <div className="relative mt-3 h-1 overflow-hidden rounded-full bg-white/5" aria-hidden="true">
          <div className="glow-sweep absolute inset-y-0 w-1/3 rounded-full bg-gradient-to-r from-transparent via-accent to-transparent" />
        </div>
      </div>

      {/* payment card */}
      <div className="hero-paid absolute -left-4 -top-6 hidden w-[230px] rounded-2xl border border-line bg-surface-2/95 p-3 shadow-2xl backdrop-blur lg:-left-14 lg:block">
        <p className="text-[10px] font-semibold uppercase tracking-widest text-muted">x402 · Hedera</p>
        <p className="mt-1 flex items-baseline gap-1.5">
          <span className="text-xl font-semibold tabular-nums">0.5</span>
          <span className="text-xs text-muted">HBAR paid by an agent</span>
        </p>
        <p className="mt-1 truncate font-mono text-[10px] text-muted">0.0.9185802@1793937163.34…</p>
      </div>

      {/* verdict card */}
      <div className="hero-verdict absolute -bottom-8 -right-3 w-[270px] rounded-2xl border border-danger/40 bg-[#1a0f10]/95 p-3.5 shadow-2xl backdrop-blur lg:-right-12">
        <p className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-widest text-danger">
          <span className="h-1.5 w-1.5 rounded-full bg-danger" />
          Cheat caught
        </p>
        <p className="mt-1.5 text-sm font-medium">Tile 18 does not match the recompute</p>
        <p className="mt-1 font-mono text-[10px] leading-relaxed text-muted">expected a91f…c3 · claimed 77c2…0e</p>
        <p className="mt-2 text-xs text-foreground/80">Provider slashed. Requester refunded. Proof on chain.</p>
      </div>
    </div>
  );
}
