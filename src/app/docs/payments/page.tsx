import type { Metadata } from "next";
import Link from "next/link";
import { Callout, DocHeader } from "@/components/docs/doc-header";
import { DocsPager } from "@/components/docs/docs-nav";

export const metadata: Metadata = { title: "x402 payments & agents" };

export default function Payments() {
  return (
    <>
      <DocHeader
        eyebrow="Concepts"
        title="x402 payments & agents"
        lead="Jobs are bought over HTTP. The server asks for money, the client signs a Hedera payment, and a facilitator settles it. Nothing is created until the payment has settled."
      />

      <h2 id="flow">The flow</h2>
      <ol>
        <li>The client sends <code>POST /api/jobs</code> with the job body and no payment.</li>
        <li>The server replies <strong>402</strong> with a <code>PAYMENT-REQUIRED</code> header (the same JSON is in the body).</li>
        <li>The client signs a Hedera transfer for that amount and retries with a <code>PAYMENT-SIGNATURE</code> header.</li>
        <li>The server checks the payment matches the quote, asks the facilitator to <code>verify</code> it, reserves it so it cannot be used twice, then asks the facilitator to <code>settle</code> it on Hedera.</li>
        <li>Only then is the job created. The response carries a <code>PAYMENT-RESPONSE</code> header with the Hedera transaction ID.</li>
      </ol>
      <pre>
        <code>{`{
  "x402Version": 2,
  "resource": { "url": "https://<api>/api/jobs", "description": "Mesh render job (small)" },
  "accepts": [{
    "scheme": "exact",
    "network": "hedera:testnet",
    "amount": "50000000",          // tinybars = 0.5 HBAR
    "asset": "0.0.0",              // HBAR; an HTS token id also works
    "payTo": "0.0.11327733",       // the treasury account
    "maxTimeoutSeconds": 120,
    "extra": { "feePayer": "0.0.9185802" }   // the facilitator pays the network fee
  }]
}`}</code>
      </pre>

      <h2 id="facts">Things worth knowing</h2>
      <ul>
        <li><strong>The facilitator pays the fee.</strong> The paying agent needs HBAR for the price only.</li>
        <li><strong>Replay protection is ours.</strong> A Hedera <code>cryptoTransfer</code> has no per-request nonce, so the server stores a hash of every signed payment and accepts each once.</li>
        <li><strong>Pricing.</strong> Prices are in test-token units (0.1 = 100000). HBAR is priced at 1 HBAR per unit, so tinybars = price × 100. An HTS token such as testnet USDC is 1:1.</li>
        <li><strong>The account needs a public key on Hedera.</strong> A wallet funded by a plain address transfer has none until it signs one Hedera transaction. The facilitator looks that key up, so run <code>npm run agent:activate</code> once for a new agent wallet.</li>
        <li><strong>Escrow mirrors the payment.</strong> The payment lands in the treasury account (an x402 payee must be a Hedera account, not an EVM contract), and the escrow contract mirrors it with a test token. The payment on HashScan is real; the escrow balance is not the same coins.</li>
      </ul>

      <h2 id="agent">The scripted agent</h2>
      <pre>
        <code>{`npm run agent -- small          # buy one small render and follow it to the end`}</code>
      </pre>
      <p>The agent signs nothing its controls have not accepted:</p>
      <table>
        <thead>
          <tr><th>Control</th><th>Setting</th><th>What it stops</th></tr>
        </thead>
        <tbody>
          <tr><td>Total budget</td><td><code>AGENT_BUDGET</code></td><td>Spending more than the run was given.</td></tr>
          <tr><td>Per-job cap</td><td><code>AGENT_JOB_CAP</code></td><td>One expensive job, even if the server&apos;s price table changes.</td></tr>
          <tr><td>Preset allowlist</td><td><code>AGENT_PRESETS</code></td><td>Buying a size it was not meant to.</td></tr>
          <tr><td>Payee allowlist</td><td><code>AGENT_ALLOWED_PAY_TO</code></td><td>Paying an account that is not the expected treasury.</td></tr>
          <tr><td>One asset</td><td><code>X402_ASSET</code></td><td>Paying in a token it does not use.</td></tr>
          <tr><td>Price check</td><td>built in</td><td>A quote above what the job should cost.</td></tr>
          <tr><td>Human approval</td><td><code>AGENT_APPROVAL_THRESHOLD</code></td><td>A large spend with nobody watching. See <Link href="/docs/identity">World ID &amp; approvals</Link>.</td></tr>
        </tbody>
      </table>

      <h2 id="errors">Error responses</h2>
      <table>
        <thead>
          <tr><th>Case</th><th>Response</th></tr>
        </thead>
        <tbody>
          <tr><td>No payment</td><td><code>402</code> with a fresh quote</td></tr>
          <tr><td>Payment does not match the quote, or the facilitator rejects it</td><td><code>402</code> with the reason</td></tr>
          <tr><td>Same payment used twice</td><td><code>409 payment_replayed</code></td></tr>
          <tr><td>Facilitator unreachable</td><td><code>503 facilitator_unavailable</code></td></tr>
          <tr><td>Approval needed, missing or denied</td><td><code>403 approval_required</code> / <code>approval_denied</code></td></tr>
          <tr><td>Paid, but the job could not be stored</td><td><code>500 job_creation_failed_after_payment</code> with the transaction ID, for a manual refund</td></tr>
        </tbody>
      </table>
      <Callout title="Proof it works">
        <p>
          The first live run settled a 0.5 HBAR payment on Hedera testnet:{" "}
          <a href="https://hashscan.io/testnet/transaction/0.0.9185802-1793937163-341350400" target="_blank" rel="noreferrer">
            0.0.9185802@1793937163.341350400
          </a>
          .
        </p>
      </Callout>
      <DocsPager href="/docs/payments" />
    </>
  );
}
