import type { Metadata } from "next";
import Link from "next/link";
import { Callout, DocHeader } from "@/components/docs/doc-header";
import { DocsPager } from "@/components/docs/docs-nav";

export const metadata: Metadata = { title: "Run a provider" };

export default function Providers() {
  return (
    <>
      <DocHeader
        eyebrow="Guides"
        title="Run a provider"
        lead="A provider is a machine that runs tiles and signs for them. Docker is the only requirement: no shared network, no matching operating system."
      />

      <h2 id="needs">What you need</h2>
      <ul>
        <li>Docker Desktop, running. Providers run a pinned <code>linux/amd64</code> image, so Apple Silicon works through emulation.</li>
        <li>A wallet with some testnet HBAR for the stake (the minimum is 0.5 HBAR) and for gas.</li>
        <li>A World ID proof of a unique human, when the API enforces World ID.</li>
        <li>The API address your requester uses, as <code>API_PUBLIC_URL</code>.</li>
      </ul>

      <h2 id="steps">Steps</h2>
      <ol>
        <li>
          <strong>Get a World ID proof.</strong> Open <Link href="/provider/verify">/provider/verify</Link>, verify in the World app, and copy the proof it shows.
        </li>
        <li>
          <strong>Configure.</strong> In <code>.env</code> set your wallet key, the proof and the API address:
          <pre>
            <code>{`PROVIDER_PRIVATE_KEY=0x…
PROVIDER_WORLD_PROOF='{"…":"…"}'
API_PUBLIC_URL=https://your-api.example`}</code>
          </pre>
        </li>
        <li>
          <strong>Stake.</strong> Lock your collateral on <code>MeshStake</code>:
          <pre>
            <code>{`npx tsx scripts/stake-provider.ts`}</code>
          </pre>
        </li>
        <li>
          <strong>Start the worker.</strong>
          <pre>
            <code>{`npm run worker:provider`}</code>
          </pre>
          It registers, sends a heartbeat every few seconds, pulls the image by digest, checks the digest and the input hash, runs each assigned tile with no network, and posts a signed
          claim.
        </li>
      </ol>

      <h2 id="rules">What the worker will and will not do</h2>
      <ul>
        <li>It refuses a job if the image digest after pulling does not match, or if the input hash does not match.</li>
        <li>It runs the container with <code>--network none</code>, a read-only filesystem, and CPU, memory and process limits, and kills it on timeout.</li>
        <li>It never decides whether work is good. It only reports.</li>
        <li>Resource use: set <code>PROVIDER_CPUS</code> and <code>PROVIDER_MEMORY</code> to limit what Docker may take.</li>
      </ul>

      <h2 id="cheat">Test the cheat path</h2>
      <p>On a development machine you can make a provider cheat on purpose to watch it get caught:</p>
      <pre>
        <code>{`MESH_TAMPER=true MESH_TAMPER_PERCENT=20 npm run worker:provider`}</code>
      </pre>
      <p>
        The worker corrupts that share of tiles <em>before</em> hashing, so its claim is internally consistent and only the verifier&apos;s recompute can expose it. Never enable this on a
        provider you care about: the stake will be slashed.
      </p>
      <Callout kind="warn" title="Payouts and slashing">
        <p>You are paid from escrow when the challenge window closes without a fraud proof. A fraud proof against you slashes part of your stake: 50% goes to the requester, 25% to the verifier and 25% is retained.</p>
      </Callout>
      <DocsPager href="/docs/providers" />
    </>
  );
}
