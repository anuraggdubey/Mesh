import type { ReactNode } from "react";
import { DocsNav } from "@/components/docs/docs-nav";

export default function DocsLayout({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto grid max-w-6xl gap-10 px-5 py-12 lg:grid-cols-[230px_minmax(0,1fr)]">
      <aside className="lg:sticky lg:top-24 lg:h-[calc(100vh-8rem)] lg:overflow-y-auto">
        <DocsNav />
      </aside>
      <article className="prose-mesh min-w-0 max-w-3xl">{children}</article>
    </div>
  );
}
