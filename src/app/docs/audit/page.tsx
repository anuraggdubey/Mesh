import type { Metadata } from "next";
import { Callout, DocHeader } from "@/components/docs/doc-header";
import { DocsPager } from "@/components/docs/docs-nav";

export const metadata: Metadata = { title: "Receipts, HCS & 0G review" };

export default function Audit() {
  return (
    <>
      <DocHeader
        eyebrow="Concepts"
        title="Receipts, HCS & 0G review"
        lead="Every job leaves a trail that does not depend on our database: contract state, a public message log, and a traceable AI review."
      />

      <h2 id="receipt">The receipt</h2>
      <p><code>GET /api/receipts/:jobId</code> returns what happened to a job, and reads the receipt straight from the contract:</p>
      <pre>
        <code>{`{
  "jobId": "0x83c4…b268",
  "status": "final",
  "providers": ["0x…", "0x…"],
  "imageDigest": "sha256:…",   "inputHash": "0x…",   "merkleRoot": "0x…",
  "verdict": "ok",
  "payment":  { "transaction": "0.0.9185802@…", "hashscan": "https://hashscan.io/…" },
  "hcs":      { "topicId": "0.0.11333951", "sequences": [1, 2, 3] },
  "inference":{ "requestId": "…", "verification": "tee", "quality": "good" },
  "transactions": { "lock": "0x…", "claim": "0x…", "finalize": "0x…" },
  "onChain":  { "status": "Final", "windowEnd": 1793937300 }
}`}</code>
      </pre>

      <h2 id="hcs">The audit log on Hedera</h2>
      <p>
        Every event that matters is published, in order, to one Hedera Consensus Service topic. Only the API wallet can write to it (the topic has a submit key), and anyone can read it from
        a mirror node. A failed submission is retried, never skipped.
      </p>
      <table>
        <thead>
          <tr><th>Type</th><th>When</th></tr>
        </thead>
        <tbody>
          <tr><td><code>PAID</code></td><td>The x402 payment settled (includes the Hedera transaction).</td></tr>
          <tr><td><code>APPROVAL</code></td><td>A human approved this job.</td></tr>
          <tr><td><code>ASSIGNED</code></td><td>Tiles were dealt to providers.</td></tr>
          <tr><td><code>CLAIM</code></td><td>The Merkle root was committed, with each provider&apos;s signature.</td></tr>
          <tr><td><code>SAMPLE</code></td><td>The verifier&apos;s seed and sampled indices.</td></tr>
          <tr><td><code>VERDICT</code></td><td>ok, or the fraud details.</td></tr>
          <tr><td><code>SLASH</code>, <code>RELEASE</code>, <code>REFUND</code></td><td>What happened to the money.</td></tr>
          <tr><td><code>INFERENCE</code></td><td>A 0G review was made (request ID only, not the text).</td></tr>
        </tbody>
      </table>
      <p>Each message is JSON under 1 KB: <code>{`{"v":1,"t":"PAID","jobId":"0x…","ts":…,"data":{…}}`}</code>. Tile uploads are not logged (there are 64 per job).</p>

      <h2 id="og">The 0G review</h2>
      <p>
        When a render is final, a vision model on <strong>0G Private Computer</strong> looks at the assembled image and returns a short description and a quality rating. The job page shows
        it next to the 0G request ID, the model and the 0G provider.
      </p>
      <table>
        <thead>
          <tr><th>Badge</th><th>Meaning</th></tr>
        </thead>
        <tbody>
          <tr><td>Verified by 0G TEE</td><td>The provider&apos;s signature over the response was checked against the configured TEE signer address.</td></tr>
          <tr><td>Router-checked only</td><td>The 0G Router says the TEE verified it, but we did not check the signature ourselves.</td></tr>
          <tr><td>Not verified</td><td>Neither check passed. A signature from the wrong signer overrides the Router&apos;s claim.</td></tr>
        </tbody>
      </table>
      <Callout title="What breaks without 0G">
        <p>The AI review, its request ID and its verification badge disappear from every receipt. Rendering, payment and verification do not depend on it.</p>
      </Callout>
      <DocsPager href="/docs/audit" />
    </>
  );
}
