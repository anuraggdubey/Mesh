import { Suspense } from "react";
import { notFound } from "next/navigation";
import { JobView } from "@/components/job-view";
import { PageShell } from "@/components/site/page-shell";
import { jobIdSchema } from "@/lib/types";

export const metadata = { title: "Job" };

// Reading `params` is request-time data, so it sits inside <Suspense> (Cache Components requirement):
// the shell prerenders instantly and the job view streams in.
export default function JobPage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <PageShell>
      <Suspense fallback={<p className="text-sm text-zinc-500">Loading job…</p>}>
        <JobContent params={params} />
      </Suspense>
    </PageShell>
  );
}

async function JobContent({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!jobIdSchema.safeParse(id).success) notFound();
  return <JobView jobId={id} />;
}
