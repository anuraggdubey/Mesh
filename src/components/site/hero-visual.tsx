/**
 * The hero animation: a job's 64 tiles fill in, a cluster turns out to be tampered with, and the verifier catches it.
 * Pure CSS (one 14 s loop), deterministic, no client JavaScript. The numbers are illustrative.
 */
const BAD = new Set([18, 19, 26, 27, 34]);

function tileColor(i: number): string {
  const r = Math.floor(i / 8);
  const c = i % 8;
  const d = Math.hypot(r - 3.5, c - 3.5) / 5; // 0 at the centre, ~1 at the corners
  const hue = 222 - d * 18; // blue, a little deeper in the middle
  const light = 70 - (1 - d) * 18;
  return `hsl(${hue.toFixed(0)} 82% ${Math.max(46, light).toFixed(0)}%)`;
}

export function HeroVisual() {
  return (
    <div className="relative mx-auto w-full max-w-[560px]">
      <div className="card p-4 sm:p-5">
        <div className="mb-3 flex items-center justify-between px-1 text-xs text-muted">
          <span className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-accent" />
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
                className={`hero-tile aspect-square rounded-[6px] ${BAD.has(i) ? "bad" : ""}`}
                style={{ ["--tile" as string]: tileColor(i), animationDelay: `${((r + c) * 0.16 + (i % 3) * 0.05).toFixed(2)}s` }}
              />
            );
          })}
        </div>
        <div className="relative mt-3 h-1 overflow-hidden rounded-full bg-line" aria-hidden="true">
          <div className="glow-sweep absolute inset-y-0 w-1/3 rounded-full bg-gradient-to-r from-transparent via-accent to-transparent" />
        </div>
      </div>

      {/* payment card */}
      <div className="hero-paid card absolute -left-3 -top-5 hidden w-[220px] p-3 lg:-left-12 lg:block">
        <p className="text-[10px] font-medium uppercase tracking-widest text-muted">x402 · Hedera</p>
        <p className="mt-1 flex items-baseline gap-1.5">
          <span className="font-display text-xl font-medium tabular-nums">0.5</span>
          <span className="text-xs text-muted">HBAR paid by an agent</span>
        </p>
        <p className="mt-1 truncate font-mono text-[10px] text-muted">0.0.9185802@1793937163.34…</p>
      </div>

      {/* verdict card */}
      <div className="hero-verdict card absolute -bottom-7 -right-2 w-[260px] border border-danger/30 p-3.5 lg:-right-10">
        <p className="flex items-center gap-2 text-[10px] font-medium uppercase tracking-widest text-danger">
          <span className="h-1.5 w-1.5 rounded-full bg-danger" />
          Cheat caught
        </p>
        <p className="mt-1.5 text-sm font-medium">Tile 18 does not match the recompute</p>
        <p className="mt-1 font-mono text-[10px] leading-relaxed text-muted">expected a91f…c3 · claimed 77c2…0e</p>
        <p className="mt-2 text-xs text-muted">Provider slashed. Requester refunded. Proof on chain.</p>
      </div>
    </div>
  );
}
