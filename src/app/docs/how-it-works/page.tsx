import type { Metadata } from "next";
import { Callout, DocHeader } from "@/components/docs/doc-header";
import { DocsPager } from "@/components/docs/docs-nav";

export const metadata: Metadata = { title: "How verification works" };

export default function HowItWorks() {
  return (
    <>
      <DocHeader
        eyebrow="Concepts"
        title="How verification works"
        lead="A tile has exactly one correct answer, every provider commits to its answers before the check, and a random sample decides whether to believe them."
      />

      <h2 id="determinism">1. Deterministic work</h2>
      <p>
        The job is a Mandelbrot render in fixed-point arithmetic (Q31.32, integers only). It runs in a pinned <code>linux/amd64</code> Docker image with no network, a read-only
        filesystem and CPU and memory limits. The same image and input produce the same bytes on any machine, which is what makes a recheck meaningful. The tiny preset was
        compared byte for byte between a macOS arm64 run and the Docker image, and the hashes are in <code>docs/golden</code>.
      </p>

      <h2 id="tiles">2. Tiles and owners</h2>
      <p>
        A job is a grid of 64 tiles. Tile <code>i</code> goes to provider <code>i mod n</code>. Each tile is hashed with SHA-256. The provider uploads the bytes and signs a claim
        over the tiles it owns (an EIP-712 <code>TileClaim</code>), so a bad tile is tied to the key that signed it.
      </p>

      <h2 id="merkle">3. The Merkle commitment</h2>
      <p>When every provider has claimed, the API builds one Merkle tree over all 64 tiles:</p>
      <pre>
        <code>{`leaf(i)  = sha256( 0x00 || uint16_be(i) || tileHash || ownerAddress )
node     = sha256( 0x01 || left || right )          // 64 leaves: a perfect tree
root     = posted on chain in MeshReceipt, which opens the challenge window`}</code>
      </pre>
      <p>
        The owner address is inside the leaf, so a proof about tile 18 also proves who claimed it. After the root is on chain, no tile can change without changing the root.
      </p>

      <h2 id="sample">4. The seeded sample</h2>
      <p>
        The verifier derives its seed from a block hash that does not exist until the claim is posted. It then picks <strong>k = 16</strong> tile indices (25%), re-runs the same
        Docker image on them, and compares the hashes. The algorithm is fixed and documented, so anyone can reproduce which tiles were sampled.
      </p>
      <p>
        A provider that corrupts <code>c</code> of 64 tiles is caught with probability <code>1 − C(64−c, k) / C(64, k)</code>:
      </p>
      <table>
        <thead>
          <tr><th>Bad tiles</th><th>k = 8</th><th>k = 16</th><th>k = 32</th></tr>
        </thead>
        <tbody>
          <tr><td>6</td><td>57%</td><td>85%</td><td>99%</td></tr>
          <tr><td>12</td><td>84%</td><td>98%</td><td>99.9%</td></tr>
          <tr><td>20</td><td>96%</td><td>99.9%</td><td>100%</td></tr>
        </tbody>
      </table>
      <Callout kind="warn" title="Honest limit">
        <p>One corrupted tile is usually missed (16 of 64 sampled is a 25% chance). The system is built so that cheating on a lot of tiles is a near certain loss; it does not promise to catch every single bad tile.</p>
      </Callout>

      <h2 id="fraud">5. The fraud proof</h2>
      <p>On a mismatch the verifier calls <code>postFraud</code> on <code>MeshReceipt</code> with:</p>
      <pre>
        <code>{`{ jobId, tileIndex, owner, expectedTileHash, claimedTileHash, proof[] }`}</code>
      </pre>
      <p>
        The contract recomputes the leaf from the claimed hash and owner, checks the proof against the stored root, checks the two hashes differ, and requires the caller to be the
        verifier. Then, in one transaction, it slashes the owner&apos;s stake, refunds the requester and marks the receipt rejected.
      </p>
      <p>The slashed amount is split 50% to the requester, 25% to the verifier and 25% retained by the receipt contract.</p>

      <h2 id="states">6. Job states</h2>
      <table>
        <thead>
          <tr><th>State</th><th>Meaning</th></tr>
        </thead>
        <tbody>
          <tr><td><code>created → paid</code></td><td>The x402 payment settled; the job exists.</td></tr>
          <tr><td><code>assigned → running</code></td><td>Tiles are dealt to providers, who compute them.</td></tr>
          <tr><td><code>pending</code></td><td>Every claim is in, the root is on chain, the window is open.</td></tr>
          <tr><td><code>final</code></td><td>No fraud proof and the verifier approved; providers were paid from escrow.</td></tr>
          <tr><td><code>rejected → slashed → refunded</code></td><td>A fraud proof landed; the requester was refunded.</td></tr>
          <tr><td><code>failed / expired → refunded</code></td><td>A provider timed out or a chain step kept failing; the payment is returned.</td></tr>
        </tbody>
      </table>
      <DocsPager href="/docs/how-it-works" />
    </>
  );
}
