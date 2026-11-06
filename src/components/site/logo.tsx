/** The Mesh mark: four linked nodes. `tile` puts it on a rounded accent square. */
export function Logo({ className = "h-6 w-6", tile = false }: { className?: string; tile?: boolean }) {
  if (tile) {
    return (
      <span className="grid h-9 w-9 place-items-center rounded-full bg-accent text-accent-ink shadow-[var(--shadow-accent)]" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5">
          <path d="M5 6l7 4 7-4M5 6v12M19 6v12M5 18l7-4 7 4M12 10v4" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" opacity="0.7" />
          {[
            [5, 6],
            [19, 6],
            [5, 18],
            [19, 18],
            [12, 12],
          ].map(([x, y]) => (
            <circle key={`${x}-${y}`} cx={x} cy={y} r="2" fill="currentColor" />
          ))}
        </svg>
      </span>
    );
  }
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <path d="M5 6l7 4 7-4M5 6v12M19 6v12M5 18l7-4 7 4M12 10v4" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" opacity="0.45" />
      {[
        [5, 6],
        [19, 6],
        [5, 18],
        [19, 18],
        [12, 12],
      ].map(([x, y]) => (
        <circle key={`${x}-${y}`} cx={x} cy={y} r="2" fill="var(--accent)" />
      ))}
    </svg>
  );
}
