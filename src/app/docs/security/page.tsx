import type { Metadata } from "next";
import { Callout, DocHeader } from "@/components/docs/doc-header";
import { DocsPager } from "@/components/docs/docs-nav";

export const metadata: Metadata = { title: "Trust model & limits" };

export default function Security() {
  return (
    <>
      <DocHeader
        eyebrow="Reference"
        title="Trust model & limits"
        lead="What you have to trust, what you do not, and what this version does not do. Written plainly so nobody is surprised."
      />

      <h2 id="not-trusted">What you do not have to trust</h2>
      <ul>
        <li><strong>Providers.</strong> They commit to every tile before the check, and a sample is recomputed. Cheating on many tiles is a near-certain loss.</li>
        <li><strong>The browser.</strong> World proofs and approvals are validated on the server. The World environment is fixed on the server.</li>
        <li><strong>The agent.</strong> Its spending is bounded by controls it cannot raise, and large spends need a human.</li>
        <li><strong>Our database for the outcome.</strong> The receipt is read from the contract, and the audit log is on Hedera.</li>
      </ul>

      <h2 id="trusted">What you do trust</h2>
      <ul>
        <li><strong>The verifier key.</strong> One key decides a fraud claim, and the contract takes its word for the single hash comparison. The recompute is reproducible, so anyone can re-run the sampled tile and audit it, but the chain does not enforce that.</li>
        <li><strong>The API operator.</strong> It controls the treasury account and the chain loop.</li>
        <li><strong>The x402 facilitator.</strong> It verifies and settles the payment.</li>
      </ul>

      <h2 id="limits">Known limits of this version</h2>
      <table>
        <thead>
          <tr><th>Limit</th><th>Detail</th></tr>
        </thead>
        <tbody>
          <tr><td>Sampling is probabilistic</td><td>A provider that corrupts one tile of 64 is missed about 75% of the time at k = 16. Stake and sample size must be tuned together.</td></tr>
          <tr><td>Single verifier</td><td>Not decentralized. A committee or a public challenge flow is the next step.</td></tr>
          <tr><td>Escrow mirrors the payment</td><td>The x402 payment settles to a treasury account. The escrow contract holds a test token that mirrors it. Real token escrow needs a contract redeploy.</td></tr>
          <tr><td>Test network and test funds</td><td>Hedera testnet only.</td></tr>
          <tr><td>No outside audit</td><td>The contracts have 67 tests but have not been audited.</td></tr>
          <tr><td>World proofs are not wallet-bound</td><td>A proof is not cryptographically tied to the wallet. The wallet signature plus a one-time nullifier is the mitigation.</td></tr>
          <tr><td>One job type</td><td>Only the deterministic render exists. Matrix and inference jobs are not built.</td></tr>
        </tbody>
      </table>
      <Callout kind="warn" title="Do not use real money">
        <p>This is a hackathon project. Treat every key in it as a test key and every balance as play money.</p>
      </Callout>
      <DocsPager href="/docs/security" />
    </>
  );
}
