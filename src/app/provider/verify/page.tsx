import type { Metadata } from "next";
import { WorldVerify } from "@/components/world-verify";

export const metadata: Metadata = { title: "Verify as a provider · Mesh" };

export default function ProviderVerifyPage() {
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <section>
        <h1 className="text-2xl font-semibold tracking-tight">Become a provider</h1>
        <p className="mt-2 text-zinc-600 dark:text-zinc-300">
          Providers lend spare compute and stake collateral. To stop one person running many fake providers, each provider profile needs a World ID proof of a
          unique human.
        </p>
      </section>
      <WorldVerify />
    </div>
  );
}
