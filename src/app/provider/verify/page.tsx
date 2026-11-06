import type { Metadata } from "next";
import { PageShell } from "@/components/site/page-shell";
import { WorldVerify } from "@/components/world-verify";

export const metadata: Metadata = { title: "Become a provider" };

export default function ProviderVerifyPage() {
  return (
    <PageShell narrow>
      <div className="space-y-6">
        <section>
          <p className="text-xs font-semibold uppercase tracking-widest text-accent">Providers</p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight">Become a provider</h1>
          <p className="mt-2 text-muted">
            Providers lend spare compute and stake collateral. To stop one person running many fake providers, each provider profile needs a World ID proof of a
            unique human.
          </p>
        </section>
        <WorldVerify />
      </div>
    </PageShell>
  );
}
