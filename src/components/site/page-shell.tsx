import type { ReactNode } from "react";

/** Standard container for the working pages (dashboard, job view, provider onboarding). */
export function PageShell({ children, narrow = false }: { children: ReactNode; narrow?: boolean }) {
  return <div className={`mx-auto w-full px-5 py-10 ${narrow ? "max-w-2xl" : "max-w-6xl"}`}>{children}</div>;
}
