import type { Metadata } from "next";
import { DocHeader } from "@/components/docs/doc-header";
import { DocsPager } from "@/components/docs/docs-nav";

export const metadata: Metadata = { title: "API reference" };

const ROWS: { group: string; items: [string, string, string][] }[] = [
  {
    group: "Requesters",
    items: [
      ["POST", "/api/jobs", "Create and pay for a job. 402 with a quote, then 200 with the job after a paid retry. Body: type, preset, requester."],
      ["GET", "/api/jobs", "The 50 most recent jobs, newest first."],
      ["GET", "/api/jobs/:id", "One job, with its tiles."],
      ["GET", "/api/jobs/:id/events", "Server-Sent Events: all past events, then live ones."],
      ["GET", "/api/jobs/:id/tiles/:index", "Raw tile bytes."],
      ["POST", "/api/jobs/:id/review", "Run the 0G review for a final job. Safe to repeat."],
      ["GET", "/api/receipts/:jobId", "The receipt: hashes, transactions, payment, HCS, review and the contract's own record."],
      ["GET", "/api/health", "Liveness: version and chain ID."],
    ],
  },
  {
    group: "Approvals and identity",
    items: [
      ["POST", "/api/approvals", "Ask a human to approve one job (World device grant). Returns a code and link."],
      ["GET", "/api/approvals/:id", "Status: pending, approved, denied, expired or used."],
      ["POST", "/api/world/rp-context", "The signed request the IDKit widget needs."],
    ],
  },
  {
    group: "Providers",
    items: [
      ["POST", "/api/providers/register", "Register with a wallet signature and a World proof. Returns a bearer token."],
      ["POST", "/api/providers/heartbeat", "Stay online."],
      ["GET", "/api/providers/tasks", "Poll for assigned tiles."],
      ["GET", "/api/providers", "Providers that are online and staked."],
      ["POST", "/api/jobs/:id/claim", "Upload tiles and post a signed claim."],
      ["POST", "/api/jobs/:id/failure", "Report a timeout, crash or hash mismatch."],
    ],
  },
  {
    group: "Verifier",
    items: [["POST", "/api/verifier/verdict", "Report ok or fraud. Signed by the verifier key."]],
  },
];

export default function Api() {
  return (
    <>
      <DocHeader
        eyebrow="Reference"
        title="API reference"
        lead="All JSON unless noted. Errors look like { error, message }. The full contract, including every field, is docs/job-spec.md in the repository."
      />
      {ROWS.map((g) => (
        <section key={g.group}>
          <h2 id={g.group.toLowerCase().replace(/\W+/g, "-")}>{g.group}</h2>
          <table>
            <thead>
              <tr><th>Method</th><th>Path</th><th>What it does</th></tr>
            </thead>
            <tbody>
              {g.items.map(([m, p, d]) => (
                <tr key={m + p}>
                  <td><code>{m}</code></td>
                  <td><code>{p}</code></td>
                  <td>{d}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}

      <h2 id="verdict">Verifier verdicts</h2>
      <p>The verifier proves who it is by signing the result into the request:</p>
      <pre>
        <code>{`signature = personal_sign(verifierKey, "mesh-verdict:<jobId>:<result>:<timestamp>")

POST /api/verifier/verdict
{ "jobId", "result": "ok" | "fraud", "timestamp", "signature",
  "sample": { beacon, seed, k, indices },
  "fraud":  { tileIndex, owner, expectedTileHash, claimedTileHash, proof },
  "finalizeTx", "fraudTx" }`}</code>
      </pre>
      <p>
        The timestamp must be within 120 seconds of the server clock, and the result is part of the signed text, so an <code>ok</code> cannot be rewritten into a <code>fraud</code>. The
        same verdict twice changes nothing.
      </p>

      <h2 id="headers">Payment and approval headers</h2>
      <table>
        <thead>
          <tr><th>Header</th><th>Direction</th><th>Meaning</th></tr>
        </thead>
        <tbody>
          <tr><td><code>PAYMENT-REQUIRED</code></td><td>response</td><td>Base64 x402 quote on a 402.</td></tr>
          <tr><td><code>PAYMENT-SIGNATURE</code></td><td>request</td><td>Base64 signed payment on the paid retry.</td></tr>
          <tr><td><code>PAYMENT-RESPONSE</code></td><td>response</td><td>Base64 settlement, including the Hedera transaction ID.</td></tr>
          <tr><td><code>X-Mesh-Approval</code></td><td>request</td><td>The approval ID for a job above the threshold.</td></tr>
        </tbody>
      </table>
      <DocsPager href="/docs/api" />
    </>
  );
}
