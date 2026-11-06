import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { ReceiptView } from "@/components/receipt-view";
import { PageShell } from "@/components/site/page-shell";

export const metadata: Metadata = { title: "Receipt" };

// Reading `params` is request-time data, so it sits inside <Suspense> (Cache Components requirement).
export default function ReceiptPage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <PageShell>
      <Suspense fallback={<p className="text-sm text-muted">Loading receipt…</p>}>
        <ReceiptContent params={params} />
      </Suspense>
    </PageShell>
  );
}

async function ReceiptContent({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^rcpt_[0-9a-f]{16}$/.test(id)) notFound();
  // ReceiptView reads the ?share= token on the client, so it needs its own Suspense boundary
  return (
    <Suspense fallback={<p className="text-sm text-muted">Loading receipt…</p>}>
      <ReceiptView receiptId={id} />
    </Suspense>
  );
}
