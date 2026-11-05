import { NewJobForm } from "@/components/new-job-form";
import { ProvidersPanel } from "@/components/providers-panel";
import { RecentJobs } from "@/components/recent-jobs";

export default function Home() {
  return (
    <div className="space-y-8">
      <section>
        <h1 className="text-3xl font-semibold tracking-tight">Run a render on spare machines</h1>
        <p className="mt-2 max-w-2xl text-zinc-600 dark:text-zinc-300">
          Mesh splits your job across providers, checks their work with a seeded spot-check, and slashes anyone who cheats. Pick a size and
          watch the image assemble live.
        </p>
      </section>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
        <NewJobForm />
        <div className="space-y-6">
          <ProvidersPanel />
          <RecentJobs />
        </div>
      </div>
    </div>
  );
}
