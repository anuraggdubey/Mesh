import type { Metadata } from "next";
import { AgentPanel } from "@/components/agent-panel";
import { ProvidersPanel } from "@/components/providers-panel";
import { ReceiptsList } from "@/components/receipts-list";
import { RecentJobs } from "@/components/recent-jobs";
import { PageShell } from "@/components/site/page-shell";

export const metadata: Metadata = { title: "Run a job" };

export default function AppHome() {
  return (
    <PageShell>
      <section className="mb-8">
        <p className="eyebrow">Dashboard</p>
        <h1 className="mt-2 text-3xl font-medium tracking-tight">Run a render on spare machines</h1>
        <p className="mt-2 max-w-2xl text-muted">
          Connect your wallet, add some test HBAR as credit, and tell the Mesh agent what you need. A 0G model plans the job, the agent pays for it on Hedera, the work is spot-checked,
          and you get a receipt for every step.
        </p>
      </section>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
        <AgentPanel />
        <div className="space-y-6">
          <ReceiptsList />
          <ProvidersPanel />
          <RecentJobs />
        </div>
      </div>
    </PageShell>
  );
}
