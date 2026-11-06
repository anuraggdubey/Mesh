import type { Metadata } from "next";
import Link from "next/link";
import { Callout, DocHeader } from "@/components/docs/doc-header";
import { DocsPager } from "@/components/docs/docs-nav";

export const metadata: Metadata = { title: "Wallet, credit & the agent" };

export default function WalletDocs() {
  return (
    <>
      <DocHeader
        eyebrow="Concepts"
        title="Wallet, credit & the agent"
        lead="A person connects a wallet and tells the Mesh agent what they need. A 0G model plans the job, the agent pays for it on Hedera from the person's prepaid credit, and every money event gets a receipt."
      />

      <h2 id="flow">The flow</h2>
      <ol>
        <li><strong>Connect.</strong> Any EVM wallet (MetaMask works). The site adds Hedera testnet if the wallet does not know it, then asks you to sign a plain-text message. That costs nothing and sends no transaction.</li>
        <li><strong>Deposit.</strong> You send test HBAR from your wallet to the agent wallet. The server reads that transfer back from the Hedera JSON-RPC relay and credits you once.</li>
        <li><strong>Ask.</strong> You describe the job in your own words. A 0G model on Private Computer picks the size and gives a reason. The request id and how it was verified are kept.</li>
        <li><strong>Confirm.</strong> You see the plan and the price and confirm. The agent holds that amount of your credit and pays the job over <Link href="/docs/payments">x402</Link>. Above the approval threshold, a human approves that exact job in World first.</li>
        <li><strong>Receipt.</strong> The deposit, the payment and any refund each have a receipt page you can print, save as a PDF, or share.</li>
      </ol>

      <h2 id="signin">Sign-in</h2>
      <p>
        The server gives the wallet a message that names the site, your address, a single-use nonce and an expiry. Your wallet signs it (EIP-191), the server checks the signature with the message <em>it</em>{" "}
        built, spends the nonce, and sets an HttpOnly session cookie (HS256, 24 hours, <code>SameSite=Lax</code>, <code>Secure</code> on https). We never see a key. The cookie is signed with{" "}
        <code>MESH_SESSION_SECRET</code>, or a key derived from <code>API_PRIVATE_KEY</code> if that is not set.
      </p>

      <h2 id="credit">Prepaid credit</h2>
      <ul>
        <li>Credit is kept in tinybars (1 HBAR = 100,000,000). Every change is a ledger row, and a deposit, a hold, a refund and a spend can each happen only once.</li>
        <li>The deposit amount comes from the chain, never from the browser. The transfer must be successful, from the wallet you signed in with, to the agent wallet, on Hedera testnet.</li>
        <li><strong>Units.</strong> On the JSON-RPC side 1 HBAR is 10<sup>18</sup> weibars. The network&apos;s own unit is the tinybar, so tinybars = weibars / 10<sup>10</sup>.</li>
        <li>The balance can never go below zero. Two jobs started at once cannot spend the same credit.</li>
        <li>The minimum deposit is 0.01 HBAR.</li>
      </ul>

      <h2 id="plan">Planning with 0G</h2>
      <p>
        <code>POST /api/agent/plan</code> sends your words to a 0G model with <code>verify_tee</code> on and asks for strict JSON: a size (<code>tiny</code>, <code>small</code> or <code>full</code>) and a short reason. Anything else is
        refused. The plan shows the 0G request id and a badge: <strong>Verified by 0G TEE</strong> only if the provider&apos;s signature really checked out, otherwise <strong>Router-checked only</strong> or <strong>Not verified</strong>.
      </p>
      <p>
        If 0G cannot answer (no credit, a rate limit, an outage, a bad reply) you get a clear error and the option to pick a size yourself. A plan you pick yourself is labelled <em>chosen by you, not 0G</em>. Mesh never
        invents a plan and calls it 0G.
      </p>
      <p>
        The request id is stored with the job and published to the Hedera audit log as a <code>PLAN</code> message (your own words are not published). Without 0G, jobs can still be bought, but they carry no traceable plan.
      </p>

      <h2 id="run">The agent run</h2>
      <p>
        A run is a database row, not a request. <code>POST /api/agent/run</code> uses your plan once, holds the credit, and starts the agent in the background. You follow it with{" "}
        <code>GET /api/agent/runs/:id</code>: <code>queued</code>, <code>needs_approval</code> (with the link to approve), <code>paying</code>, <code>paid</code> or <code>failed</code>. On any failure the hold is returned and a refund
        receipt is issued. A run that never finishes is failed and refunded after 20 minutes.
      </p>

      <h2 id="receipts">Receipts</h2>
      <table>
        <thead>
          <tr><th>Type</th><th>When</th><th>What it shows</th></tr>
        </thead>
        <tbody>
          <tr><td>Deposit</td><td>Credit was added</td><td>Amount, your wallet, the deposit transaction on HashScan</td></tr>
          <tr><td>Job payment</td><td>The agent paid for a job</td><td>Amount, the x402 payment, escrow lock, claim, finalize or fraud, slash and refund transactions, the job, the 0G request id with its badge, the audit-log topic and sequence numbers</td></tr>
          <tr><td>Refund</td><td>A hold was returned</td><td>Amount, the reason, a link to the payment it returns</td></tr>
        </tbody>
      </table>
      <p>
        Each ledger entry has a receipt id (<code>rcpt_…</code>). The receipt page (<code>/receipts/&lt;id&gt;</code>) has a Print / Save as PDF button and a Copy link button. <strong>Who can read one:</strong> the wallet that owns it
        (signed in), or anyone with the share link, which carries a token made from the receipt id and the server secret and opens only that one receipt. Anyone else gets &quot;not found&quot;, so receipt ids cannot be probed.
      </p>

      <Callout kind="warn" title="Honest limits">
        <p>
          The agent wallet is held by the server (its key is in the server&apos;s environment). This is a testnet design: deposits are test HBAR with no value. Do not use it with real funds. Prepaid credit is an accounting
          entry kept by the operator, backed by HBAR in the agent wallet.
        </p>
      </Callout>
      <DocsPager href="/docs/wallet" />
    </>
  );
}
