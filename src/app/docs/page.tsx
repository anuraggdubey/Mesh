import type { Metadata } from "next";
import Link from "next/link";
import { Callout, DocHeader } from "@/components/docs/doc-header";
import { DocsPager } from "@/components/docs/docs-nav";

export const metadata: Metadata = { title: "Introduction" };

export default function DocsIntro() {
  return (
    <>
      <DocHeader
        eyebrow="Start"
        title="Introduction"
        lead="Mesh is a marketplace for spare compute where the buyer does not have to trust the seller. Work is split across machines, a random sample is re-checked, and a lie costs more than it earns."
      />

      <h2 id="problem">The problem</h2>
      <p>
        You can rent a stranger&apos;s computer, but you cannot tell whether the answer is real. Checking it usually means doing the work yourself. Mesh uses a cheaper
        check: commit to every result up front, recompute a random sample after the commitment, and put real money behind being honest.
      </p>

      <h2 id="parts">The moving parts</h2>
      <table>
        <thead>
          <tr><th>Part</th><th>What it does</th></tr>
        </thead>
        <tbody>
          <tr><td><strong>API</strong></td><td>Next.js app. Quotes prices over x402, creates jobs, assigns tiles, collects claims, runs the chain loop, writes the audit log.</td></tr>
          <tr><td><strong>Providers</strong></td><td>Staked machines that run a pinned Docker image offline and sign a claim over their tiles.</td></tr>
          <tr><td><strong>Verifier</strong></td><td>Recomputes a seeded sample of tiles. Clear: lets the job finalize. Mismatch: posts a fraud proof.</td></tr>
          <tr><td><strong>Contracts</strong></td><td><code>MeshStake</code> (collateral), <code>MeshEscrow</code> (payment), <code>MeshReceipt</code> (claims, window, fraud proofs, payout).</td></tr>
          <tr><td><strong>Agent</strong></td><td>A script that buys jobs over x402 inside spending controls, with human approval above a threshold.</td></tr>
        </tbody>
      </table>

      <pre>
        <code>{`requester / agent ──x402──▶ API ──tiles──▶ providers (Docker, offline)
                            │                    │ signed claims
                            ▼                    ▼
                        Merkle root ──▶ MeshReceipt (window opens)
                            │                    ▲
                        verifier ── sample ──────┘  ok → finalize → pay providers
                                                    bad → fraud proof → slash + refund
                            └──▶ HCS audit log + receipt endpoint`}</code>
      </pre>

      <h2 id="quickstart">Quick start</h2>
      <p>You need Node.js 20 or newer. Docker is needed only on a provider machine.</p>
      <pre>
        <code>{`git clone https://github.com/anuraggdubey/Mesh.git
cd Mesh
npm install
cp .env.example .env     # then fill in the values (see below)
npm run dev              # http://localhost:3000`}</code>
      </pre>
      <p>The settings you will actually touch:</p>
      <table>
        <thead>
          <tr><th>Setting</th><th>Meaning</th></tr>
        </thead>
        <tbody>
          <tr><td><code>API_PRIVATE_KEY</code></td><td>The API wallet. Receives x402 payments and sends the chain transactions. Needs a little HBAR.</td></tr>
          <tr><td><code>X402_ENABLED</code></td><td><code>true</code> makes <code>POST /api/jobs</code> a real x402 endpoint.</td></tr>
          <tr><td><code>AGENT_PRIVATE_KEY</code></td><td>A separate wallet for the scripted agent. Needs HBAR to pay for jobs.</td></tr>
          <tr><td><code>HCS_TOPIC_ID</code></td><td>The audit topic. Create it once with <code>npm run hcs:create-topic</code>.</td></tr>
          <tr><td><code>NEXT_PUBLIC_WORLD_APP_ID</code>, <code>WORLD_RP_ID</code>, <code>WORLD_SIGNING_KEY</code></td><td>World ID (IDKit) for provider registration.</td></tr>
          <tr><td><code>OG_API_KEY</code>, <code>OG_ENABLED</code></td><td>0G review of finished renders.</td></tr>
        </tbody>
      </table>

      <h2 id="presets">Job sizes</h2>
      <table>
        <thead>
          <tr><th>Preset</th><th>Image</th><th>Tiles</th><th>Price</th><th>Typical time</th></tr>
        </thead>
        <tbody>
          <tr><td><code>tiny</code></td><td>64 × 64</td><td>4</td><td>0.1 HBAR</td><td>a second or two</td></tr>
          <tr><td><code>small</code></td><td>2048 × 2048</td><td>64</td><td>0.5 HBAR</td><td>about 5 s</td></tr>
          <tr><td><code>full</code></td><td>2048 × 2048</td><td>64</td><td>1 HBAR</td><td>about 30 s</td></tr>
        </tbody>
      </table>

      <h2 id="deployed">Deployed contracts (Hedera testnet, chain 296)</h2>
      <table>
        <thead>
          <tr><th>Contract</th><th>Address</th></tr>
        </thead>
        <tbody>
          <tr><td>MeshReceipt</td><td><a href="https://hashscan.io/testnet/contract/0x0118652ea87a8616Cb51979F5F121FC598bf3e7E" target="_blank" rel="noreferrer"><code>0x0118…3e7E</code></a></td></tr>
          <tr><td>MeshStake</td><td><a href="https://hashscan.io/testnet/contract/0x522C2eef0EF65d1f9eA9dfe12b88ba24565245f8" target="_blank" rel="noreferrer"><code>0x522C…45f8</code></a></td></tr>
          <tr><td>MeshEscrow</td><td><a href="https://hashscan.io/testnet/contract/0x16eFE46De1CdA06Be455607A63514319aE130010" target="_blank" rel="noreferrer"><code>0x16eF…0010</code></a></td></tr>
          <tr><td>MockStable (test token)</td><td><a href="https://hashscan.io/testnet/contract/0x9009A5B2070a97aAa81c6EB77A2507273Ba46Ee3" target="_blank" rel="noreferrer"><code>0x9009…6Ee3</code></a></td></tr>
        </tbody>
      </table>

      <Callout title="Where to go next">
        <p>
          Start with <Link href="/docs/how-it-works">how verification works</Link>, then <Link href="/docs/payments">payments and agents</Link>. To lend a machine, read{" "}
          <Link href="/docs/providers">run a provider</Link>.
        </p>
      </Callout>
      <DocsPager href="/docs" />
    </>
  );
}
