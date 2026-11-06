import type { Metadata } from "next";
import { NewJobForm } from "@/components/new-job-form";
import { PageShell } from "@/components/site/page-shell";
import { ProvidersPanel } from "@/components/providers-panel";
import { RecentJobs } from "@/components/recent-jobs";

export const metadata: Metadata = { title: "Run a job" };

export default function AppHome() {
  return (
    <PageShell>
      <section className="mb-8">
        <p className="text-xs font-semibold uppercase tracking-widest text-accent">Dashboard</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">Run a render on spare machines</h1>
        <p className="mt-2 max-w-2xl text-muted">
          Mesh splits your job across providers, checks their work with a seeded spot-check, and slashes anyone who cheats. Pick a size and watch the image
          assemble live.
        </p>
      </section>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
        <NewJobForm />
        <div className="space-y-6">
          <ProvidersPanel />
          <RecentJobs />
        </div>
      </div>
    </PageShell>
  );
}
