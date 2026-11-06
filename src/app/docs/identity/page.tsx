import type { Metadata } from "next";
import { Callout, DocHeader } from "@/components/docs/doc-header";
import { DocsPager } from "@/components/docs/docs-nav";

export const metadata: Metadata = { title: "World ID & approvals" };

export default function Identity() {
  return (
    <>
      <DocHeader
        eyebrow="Concepts"
        title="World ID & approvals"
        lead="World is used at the two moments where a human matters: when someone registers to sell compute, and when an autonomous agent wants to spend a lot."
      />

      <h2 id="idkit">Registering a provider: IDKit</h2>
      <p>
        <strong>Why:</strong> a provider locks a stake that can be slashed. If one person could register a hundred providers, the stake would mean nothing. Proof of Human is the
        minimum credential that gives strict one-person-one-profile uniqueness.
      </p>
      <ol>
        <li>The provider opens <code>/provider/verify</code>. The page asks <code>POST /api/world/rp-context</code> for a request signed by the server&apos;s signing key.</li>
        <li>The IDKit widget shows a QR code or deep link. The person confirms in the World app.</li>
        <li>The result goes to the provider worker as <code>PROVIDER_WORLD_PROOF</code> and is sent with the registration.</li>
        <li><strong>The server verifies it</strong> with World&apos;s verify endpoint, never trusting the browser. The environment (<code>production</code> or <code>staging</code>) is fixed on the server so a client cannot pick a test one.</li>
        <li>The nullifier (one per person per action) is stored. A second registration with the same nullifier is refused.</li>
      </ol>
      <h3>When it says no</h3>
      <table>
        <thead>
          <tr><th>Case</th><th>Result</th></tr>
        </thead>
        <tbody>
          <tr><td>No proof, wrong action, wrong environment, or invalid proof</td><td><code>401 world_denied</code> with a reason. No provider row, no token, nothing on chain.</td></tr>
          <tr><td>Proof already used</td><td><code>401 nullifier_reused</code>.</td></tr>
          <tr><td>World unreachable</td><td><code>503</code>. An outage is never treated as a pass.</td></tr>
        </tbody>
      </table>

      <h2 id="approvals">Approving a big agent spend</h2>
      <p>
        <strong>Why:</strong> an agent that pays on its own needs a human check for large amounts. Above <code>AGENT_APPROVAL_THRESHOLD</code>, the agent must get a fresh approval from a
        person for that exact job before it is allowed to pay.
      </p>
      <ol>
        <li>The agent calls <code>POST /api/approvals</code> with the job it wants. The server returns a short code and a link to an approval page.</li>
        <li>The person opens the link, sees the job and its price, and proves they are a unique human with World ID, for this one approval.</li>
        <li>The server checks the proof with World (the proof must be for this approval&apos;s own action, and each proof counts once) and marks the approval granted.</li>
        <li>The agent retries <code>POST /api/jobs</code> with <code>X-Mesh-Approval: &lt;id&gt;</code>. The server checks the approval first, before it asks for any money.</li>
      </ol>
      <p>
        An approval is <strong>bound</strong> to one requester, preset and price by a hash, and it is <strong>single use</strong>. The agent cannot reuse it or inflate the amount
        afterwards. If the approval is missing, pending, denied, expired, spent or for a different job, no job is created and nothing is paid.
      </p>
      <Callout kind="warn" title="Which World product answers the approval">
        <p>
          There are two ways to answer an approval. The World IdP device grant (the Agent Pass route, validated ID token) is built and is used automatically when a World IdP client is
          configured. The <code>auth.world.org</code> portal was not open to our accounts, so this deployment answers approvals with a <strong>World ID (IDKit) proof</strong> made for
          each approval instead. Both are tested against local fake World servers, including the denied, cancelled and expired paths. A live scan with real World credentials has not been
          run yet.
        </p>
      </Callout>
      <DocsPager href="/docs/identity" />
    </>
  );
}
