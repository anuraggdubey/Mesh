import { Suspense } from "react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ApproveSpend } from "@/components/approve-spend";
import { PageShell } from "@/components/site/page-shell";

export const metadata: Metadata = { title: "Approve an agent spend" };

// Reading `params` is request-time data, so it sits inside <Suspense> (Cache Components requirement).
export default function ApprovePage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <PageShell narrow>
      <section className="mb-6">
        <p className="text-xs font-semibold uppercase tracking-widest text-accent">Human approval</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">Approve an agent spend</h1>
        <p className="mt-2 text-muted">A large spend by an AI agent needs a person to confirm it with World ID. Nothing happens unless you approve.</p>
      </section>
      <Suspense fallback={<p className="text-sm text-muted">Loading…</p>}>
        <ApproveContent params={params} />
      </Suspense>
    </PageShell>
  );
}

async function ApproveContent({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  return <ApproveSpend approvalId={id} />;
}
