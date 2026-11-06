/** The Mesh mark: four linked nodes. */
export function Logo({ className = "h-6 w-6" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <path d="M5 6l7 4 7-4M5 6v12M19 6v12M5 18l7-4 7 4M12 10v4" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" opacity="0.55" />
      <circle cx="5" cy="6" r="2" fill="var(--accent)" />
      <circle cx="19" cy="6" r="2" fill="var(--accent)" />
      <circle cx="5" cy="18" r="2" fill="var(--accent)" />
      <circle cx="19" cy="18" r="2" fill="var(--accent)" />
      <circle cx="12" cy="12" r="2.4" fill="var(--accent)" />
    </svg>
  );
}
