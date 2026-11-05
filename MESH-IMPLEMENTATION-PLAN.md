# Mesh — Implementation Plan
**ETHGlobal Mumbai 2026 · Misbah Ansari & Anurag**

This document is the single source of truth for what we are building, why the blockchain is in it, how the two machines work, how the chain integrates, and who does what. Read it end to end before writing code. If something in chat disagrees with this file, update this file first, then the code.

- **Event:** ETHGlobal Mumbai 2026, Jio World Convention Centre, BKC
- **Hacking starts:** 9:00 PM IST, Thursday 5 November 2026
- **Submissions due:** 9:00 AM IST, Saturday 7 November 2026 — no late submissions
- **Submit as:** Finalist + Partner Prizes
- **Official prizes:** https://ethglobal.com/events/mumbai/prizes
- **Official rules:** https://ethglobal.com/rules
- **Repo:** create the git repository only after 9:00 PM IST on Thursday. Commit often. A single giant commit can get us disqualified. Write down every place AI tools helped.

---

## 1. What Mesh is

Mesh is a **verifiable compute marketplace**.

People (or agents) who need processing power post a **job**. People who have spare capacity on their laptops run a **provider agent** and execute that job. That much exists in Web2 (a freelance board, a queue, a payment app).

What makes Mesh a blockchain product, and what we will demo, is this:

> After a job runs, anyone can verify — without trusting Mesh’s server — that **this exact code** ran on **this exact input**, produced **this exact output**, was attested (when 0G is available), and that the provider who ran it had **stake on the line**. A fake or tampered run is **rejected and slashed**. An honest run produces an **on-chain compute receipt** other apps can look up later.

Payment exists, but it is not the headline. The headline is **proof + slashable stake + a public receipt**.

Reference UI / product story we already sketched: [meshcompute.vercel.app](https://meshcompute.vercel.app/). That site describes affordable spare-capacity compute (AI jobs, builds, image/video, scripts) and providers earning by sharing machines. We are building the **ETHGlobal version** of that idea: same marketplace, with verifiable execution instead of “trust us, then we pay you.”

We are **not** building:

- A Stripe/Razorpay clone that happens to use tokens
- “User A sends tokens to user B after the work” as the only chain feature
- A Bluetooth transaction mesh (different idea)
- A full global cloud (isolation on untrusted machines at worldwide scale) in 36 hours

We **are** building a real v1 of a product we can keep shipping after Mumbai.

---

## 2. Why a blockchain (and why this is not “just Web2 escrow”)

Web2 can already do: “I’ll pay 200 now, and 200 more when the job is done.” Stripe, UPI, cash, or a company holding funds in India or the US can do that. Judges will shrug if that is our only integration.

The chain is required for things a company-in-the-middle cannot honestly offer:

| Need | Why Web2 is not enough | What we put on chain |
| --- | --- | --- |
| Prove what ran | You must trust Mesh’s servers and the provider’s word | Attestation + input/output/job image hashes on a **compute receipt** |
| Trust strangers with no company as bank | Escrow platforms hold the money and can freeze, censor, or disappear | Provider **stake** locked in a contract; **slash** if the proof is bad; **refund** if the job fails |
| Machines / agents buy compute | Agents cannot open Stripe or UPI accounts | **x402 on Hedera**: pay inside the HTTP request, no checkout account |
| One human ≠ fifty fake nodes | Email sign-ups are cheap to fake | **World ID** (unique human) for providers and requesters, verified on our server |
| Other apps can reuse the result | A private database is not composable | Public **receipt** any contract or dApp can verify; output stored in a content-addressed way (**Arkiv** if we have time) |
| Global, permissionless | “Works in the US or India because our company operates there” | Anyone with a wallet and a machine can request or provide, same rules everywhere |

**Lead demo sentence:** two laptops; an honest job that produces a verifiable receipt; a fake/tampered job that fails verification and gets slashed; a receipt anyone can look up on Hedera.

---

## 3. Partner tracks we enter (max 3 partners)

All of one partner’s tracks count as a single pick. Confirm the live text on the prizes page before submitting.

1. **Hedera — “AI Agents That Pay: x402 on Hedera”** ($6,500 pool: $3,000 / $2,000 / $1,500)  
   Payment rail for jobs (especially agent/machine payers). Hedera is EVM-compatible; escrow, stake, slash, and receipts are ordinary Solidity.

2. **0G — “Build with 0G Private Computer”** ($5,000)  
   Isolated / attested execution so “the other laptop actually ran our code” is not a trust-me story. If 0G tooling blocks us on night one, we ship Docker isolation first, keep an attestation slot in the UI, and plug 0G in as soon as it works. Do not let 0G block the live loop.

3. **World — IDKit** (2 teams × $1,250), and **World ID Agent Pass** ($5,000) if the requester can be an agent  
   Unique humans (and a full verify → approved action plus a denied path, checked on the server — World says a login screen alone does not count).

**Optional if time (do not burn a pick unless the work is real):**

- **ENS — Best Use of ENSv2** ($7,000): machine names such as `pcb.mesh.eth`
- **Arkiv — Build from scratch / mirror**: store job outputs as content-addressed artifacts so our API is not the only copy

When submitting, also opt into **Finalist + Partner Prizes**. Judges score technicality, originality, practicality, usability, and WOW.

---

## 4. Roles: two machines (PC A and PC B)

We test and demo on **two different operating systems**.

| Name | Owner | OS | Role in the demo |
| --- | --- | --- | --- |
| **PC A** | Misbah | One of Windows or Mac | **Requester**: posts the job, pays, sees the receipt |
| **PC B** | Anurag | The other OS | **Provider**: runs the Mesh agent, executes the job in a container |

Swap once during testing (Misbah’s laptop becomes provider, Anurag’s becomes requester) so we prove it is not OS-specific.

Both machines need:

- Git, Node.js 20+, Docker Desktop **running**
- A Hedera testnet wallet funded with test tokens
- The Mesh provider agent installed
- World ID completed once (unique human)
- Same network: venue Wi‑Fi first, phone hotspot as backup

If Docker is painful on one machine, the fallback job type is a Node or Python script that runs on **both** OS runtimes (resize an image, hash a file, run a tiny inference). No Windows-only or Mac-only demo jobs.

---

## 5. How compute actually works (PC A ↔ matcher ↔ PC B)

```
PC A (Requester)                    Mesh API / Matcher                 PC B (Provider)
     |                                      |                                 |
     | 1. World ID verify (server-side)     |                                 |
     | 2. POST /jobs  {image, input, pay}   |                                 |
     | 3. HTTP 402 Payment Required  -------|                                 |
     | 4. Pay via x402 on Hedera            |                                 |
     | 5. Escrow locks stake-aware payment  |                                 |
     |                                      | 6. Job queued                   |
     |                                      | 7. PC B agent polls / assigned  |
     |                                      |------------------------------>  |
     |                                      | 8. Pull job image (hash X)      |
     |                                      | 9. Run in Docker (and 0G TEE    |
     |                                      |    when available)              |
     |                                      | 10. Output hash Z, attestation  |
     |                                      |<-----------------------------   |
     |                                      | 11. Verify attestation + hashes |
     | 12. Compute receipt posted on-chain  |                                 |
     | 13. Escrow releases to provider      |                                 |
     |     OR refund + slash on failure     |                                 |
     | 14. PC A displays result + receipt   |                                 |
```

### 5.1 Job

A job is a JSON object, stored by the API and referenced on-chain by `jobId`:

- `jobId`
- `requester` (address + World ID nullifier hash, server-checked)
- `provider` (filled when assigned)
- `imageRef` + `imageHash` (what code to run — container digest)
- `inputRef` + `inputHash` (what data to run it on)
- `outputRef` + `outputHash` (filled when done)
- `maxPrice` / `price`
- `timeoutSeconds`
- `status`: `created | paid | assigned | running | succeeded | failed | slashed | refunded | expired`
- `attestation` (0G / TEE payload or `null`)
- `receiptTx` (Hedera transaction id of the compute receipt)

### 5.2 Execution on PC B

1. Agent receives job, verifies `imageHash` after pulling the image (digest must match; if not, refuse and fail the job).
2. Writes input to a workspace directory; computes `inputHash`; refuses if it does not match the job.
3. Runs `docker run --rm --network none ...` (no outbound network unless the job type needs it; default is none).
4. Resource caps: CPU and memory limits so a bad job cannot freeze PC B.
5. On success: write output, compute `outputHash`, collect attestation if 0G ran the job, POST result to the API.
6. On failure: exit code, logs (truncated), reason `timeout | crash | hash_mismatch | attestation_missing | killed`.
7. Agent never signs a “success” without hashes. The **API + contract** decide success, not the provider’s word.

### 5.3 Isolation levels (ship in this order)

1. **Must have:** Docker isolation + image/input/output hashes.
2. **Should have:** 0G Private Computer attestation of the executed image and output.
3. **Nice:** encrypted input in transit (TLS is enough for the hack; full provider-blind encryption is post-Mumbai).

Judges should hear us say honestly: Docker stops accidental messes and gives us hashes; 0G attestation is what makes “don’t trust the other laptop” real. If 0G is missing, we still show hash binding and slash on mismatch, and we label attestation as in progress — we do not fake an attestation. Faking a proof can get us disqualified.

---

## 6. On-chain design (Hedera testnet)

Hedera because it is EVM-compatible and because x402 is an explicit Mumbai track. Use testnet only.

### 6.1 Contracts (Solidity)

**`MeshReceipt.sol`** — the product.

- `postReceipt(jobId, imageHash, inputHash, outputHash, provider, requester, attestationHash, result)`  
  Only callable by the Mesh verifier (our backend key **or**, better, after on-chain checks we can justify).
- Emits `ReceiptPosted`.
- Anyone can `getReceipt(jobId)`.
- Receipts are append-only. We never overwrite history.

**`MeshStake.sol`** — provider skin in the game.

- Provider `stake()` with test tokens (minimum we pick, e.g. a small HBAR or test USDC amount).
- Provider must be World ID verified off-chain before we let them register; store `nullifierHash` to prevent two provider profiles per human.
- `slash(provider, jobId, reason)` if verification fails (tampered image, missing/invalid attestation when required, claimed success without matching hashes).
- `unstake()` after an unlock delay (can be short on testnet).

**`MeshEscrow.sol`** — settlement after verification, **not** the story.

- Requester payment locked when the x402 payment confirms.
- `release(jobId)` to provider only if a **successful receipt** exists.
- `refund(jobId)` if status is failed / expired / invalid proof.
- `release` and `refund` are mutually exclusive (reentrancy guards, checked status).

**`MockStable.sol`** (if needed) — a test ERC-20 if we are not using Hedera’s test USDC.

Keep contracts small. No upgrade proxy unless we have spare time. Emit rich events so the UI can show a live feed of hashes and slashes.

### 6.2 x402 flow

x402 means “HTTP 402 Payment Required”: the client pays inside a normal web request, no checkout page.

1. `POST /jobs` without payment → `402` with payment instructions (amount, asset, pay-to, job nonce).
2. Client retries with the x402 payment payload / header.
3. Our **facilitator** (a small service) verifies the Hedera payment, checks **replay** (same nonce cannot pay twice), then marks the job `paid` and locks escrow.
4. Only then is the job eligible to be assigned to PC B.

If the requester is a human demo wallet, we still use x402 so the integration is real — but we **describe** it as “machines and agents can pay the same way, with no Stripe account.” If we have time, a tiny scripted agent requester (no UI click) is a strong extra clip.

### 6.3 World ID

World’s brief (especially Agent Pass / IDKit):

- Full verify flow that ends in a **protected action** (creating a job, or registering as provider).
- A **denied / expired / cancelled** path where the action does **not** happen.
- Verification checked on **our server**, not only in the browser.
- A short feedback note on the integration for submission.

We implement both the happy path and the denied path, and we show both in the demo.

### 6.4 0G Private Computer

Goal: job execution inside a TEE (a sealed environment the operator should not see into). We ask 0G for:

- How to submit a workload
- What attestation we get back (signature over image/input/output hashes)
- How we verify that attestation in our API before calling `postReceipt` / `release`

If docs or SDKs stall us: Docker path remains the runner; the receipt’s `attestationHash` stays empty; verification still checks image/input/output hashes; we say this clearly. We never invent a fake attestation.

### 6.5 ENS and Arkiv (optional)

- ENS: `pca.mesh.eth` / `pcb.mesh.eth` or `anurag.mesh.eth` shown in the activity feed.
- Arkiv: upload output bytes, store the Arkiv pointer on the receipt so “download result” does not depend only on our API.

---

## 7. Repository and framework choices

Monorepo (recommended):

```
mesh/
  README.md          ← short; this plan can live at docs/IMPLEMENTATION-PLAN.md
  docs/
  apps/
    web/             ← Next.js (App Router) + TypeScript + Tailwind
                       Requester dashboard + provider status + receipt explorer
    api/             ← Node.js (Hono or Nest-light or Next route handlers)
                       Job queue, x402 facilitator hooks, World ID verify, 0G verify
    agent/           ← Node.js CLI + long-running worker on PC B (and PC A when swapped)
  packages/
    shared/          ← types: Job, Receipt, hashes
    sdk/             ← tiny TS client: createJob, waitForReceipt
  contracts/         ← Foundry (Solidity) for Hedera EVM
  jobs/
    echo/            ← sample job image: write input to output (sanity)
    resize/          ← sample: image resize (visible WOW)
    infer/           ← optional tiny model if time
  .github/           ← not required for the hack
```

**Why this stack**

- TypeScript everywhere so Misbah and Anurag share types.
- Next.js for a fast, demo-ready UI.
- Foundry for tests (`forge test`) we can show.
- Docker for cross-OS jobs.
- Hedera JSON-RPC so ethers.js / viem work as on any EVM chain.

**Environment variables** (never commit secrets; use `.env.example`):

- `HEDERA_RPC_URL`, `HEDERA_CHAIN_ID`, `DEPLOYER_PRIVATE_KEY`
- `RECEIPT_ADDRESS`, `STAKE_ADDRESS`, `ESCROW_ADDRESS`
- `WORLD_ID_APP_ID`, `WORLD_ID_ACTION`, `WORLD_ID_VERIFY_SECRET`
- `X402_FACILITATOR_URL` (or in-process)
- `OG_API_KEY` / endpoint (if any)
- `API_PUBLIC_URL` (PC A and PC B must reach this — use a tunnel like Cloudflare Tunnel or a laptop hotspot + LAN IP if needed)

**AI use:** keep `AI.md` listing which files/features an AI assistant wrote or substantially edited (ETHGlobal requires documenting AI help).

---

## 8. Saturday demo script (4 minutes)

Judges score WOW. Do this script, nothing longer.

1. **(15s)** One sentence: “Mesh is verifiable spare compute — not payday for freelancers.”
2. **(45s)** PC A posts a visible job (image resize or similar). Show World ID approved.
3. **(45s)** PC B’s terminal/UI shows the job pulled, image hash match, container running.
4. **(45s)** Result appears on PC A. Show on-chain receipt: image/input/output hashes + tx.
5. **(60s)** Repeat with a **tampered** path (wrong image or skipped attestation). Verification fails. Escrow refunds. Provider is slashed. Show both transactions.
6. **(30s)** Optional: denied World ID path, or a scripted agent paying via x402 with no checkout UI.

Backup: a pre-recorded 720p video of the same flow if venue Wi‑Fi dies. Demo video for submission: 2–4 minutes, 720p+, our own voice, not filmed on a shaky phone if we can avoid it.

---

## 9. Testing workflow (do not skip)

Write expected vs actual for each case in `docs/QA.md` as you go.

1. **Setup.** Docker running on both laptops. Two funded Hedera testnet wallets. World ID once each. Agent installed on both. API reachable from both (same Wi‑Fi or hotspot).
2. **Smoke, no chain.** PC A submits “echo hello”; PC B returns `hello`. If this fails, do not touch contracts yet.
3. **Hashes.** Change one byte of the image or input on PC B; job must fail verification.
4. **Payment + escrow happy path.** x402 pay → lock → run → receipt → release to provider.
5. **Failure refund.** Kill the container or force timeout; requester is refunded; provider is not paid.
6. **Slash path.** Provider claims success with a wrong `outputHash` or missing attestation (when required); slash + refund.
7. **Replay.** Submit the same x402 payment twice; second is rejected.
8. **World ID deny.** Expired/cancelled proof; job or provider register does not happen.
9. **Cross-OS.** PC A Mac / PC B Windows, then swap. Same job, same `outputHash`.
10. **Disconnect.** Unplug PC B mid-job; timeout → refund.
11. **Venue rehearsal.** One extra person runs the agent if possible. Time the happy path.
12. **Screen recording** of the happy path and the slash path.

---

## 10. Work split

Two people. Overlap is dangerous; interfaces are agreed below. If someone finishes early, they take items from **Shared / stretch**, not from the other person’s core until that core is working.

### Agreed interfaces (do not change without telling the other person)

- Job JSON schema (section 5.1)
- `POST /jobs`, `GET /jobs/:id`, `POST /jobs/:id/result`, `GET /receipts/:jobId`
- Docker image contract: read `/input`, write `/output`, exit 0 on success
- Hash function: **SHA-256** hex, lowercase, of raw bytes
- Chain IDs and contract ABIs in `packages/shared`

---

### Misbah — chain, verification, product truth

Misbah owns anything that would make judges say “this is just Web2 payments” if it were missing. Also architecture and the demo narrative (SolDiff-style: evidence, hashes, no over-claim).

**Thursday night (after 9:00 PM IST)**

- Create the repo (only after hacking starts), README stub, `.env.example`, `AI.md`, this plan copied into `docs/IMPLEMENTATION-PLAN.md`.
- Foundry project: `MeshReceipt`, `MeshStake`, `MeshEscrow`, tests for: cannot release without receipt; cannot double-release; slash then refund; replay-safe job ids.
- Deploy to Hedera testnet. Publish addresses in `.env.example` (addresses are fine to commit; keys are not).
- Define and document the receipt event layout.
- World ID server-side verify endpoint (action: `register-provider` and `create-job`).
- Sketch the 402 response format with Anurag so the web client and API match.

**Friday**

- x402 facilitator: verify payment, replay protection, call escrow lock.
- Verifier service: given a result payload, check image/input/output hashes; verify 0G attestation if present; then `postReceipt` + `release` or `refund` + `slash`.
- Receipt explorer page: paste `jobId`, show hashes, provider, slash-or-success, Hedera tx links.
- Denied World ID path in the UI (coordinate with Anurag on the component).
- 0G integration spike: one attested job or a written note in `docs/OG-STATUS.md` of exactly what blocked us (no fake proofs).
- Start `FEEDBACK` notes for World / Hedera / 0G (sponsors often want a short integration note).
- Write the demo script (section 8) on a one-pager in `docs/DEMO.md`.
- Friday night: record the backup video with Anurag.

**Saturday morning**

- Rehearse on the two laptops. Confirm testnet funds still exist.
- Submission: project name, description, repo, demo video, partner picks (Hedera, 0G, World), Finalist + Partner Prizes, AI disclosure.

**Misbah does not** spend Thursday night pixel-polishing the marketing landing page. The receipt and slash path come first.

---

### Anurag — agent, runner, two-OS reality, requester UX

Anurag owns the thing that has to work on a Windows laptop and a Mac: agent, Docker runner, job images, requester UI to post a job and see progress.

**Thursday night (after 9:00 PM IST)**

- Scaffold `apps/web`, `apps/api` (or agreed Next full-stack), `apps/agent`.
- Provider agent: register with API, heartbeat, poll/receive job, pull image, run Docker with CPU/memory limits and `--network none`, compute hashes, POST result.
- Sample job `jobs/echo` and `jobs/resize` with a Dockerfile that builds on **both** OS architectures if we can (`linux/amd64` is safest if one laptop is Intel/AMD; note Apple Silicon — use `--platform linux/amd64` or build two tags, but pick **one** platform and stick to it so hashes match).
- Requester UI: create job, upload/paste input, show status states from section 5.1.
- Get the **no-chain smoke test** passing: PC A → API → PC B → result.

**Friday**

- Wire UI to x402 payment (Misbah’s 402 format) and World ID widgets (Misbah’s verify endpoints).
- Provider dashboard: current job, logs (last N lines), last hashes.
- Happy-path and failure UX: timeout, crash, “verification failed.”
- Help Misbah test slash path by adding a hidden or flagged “tamper output” mode on the agent (dev-only flag, never default on).
- Cross-OS matrix: both directions, same `outputHash`.
- LAN/tunnel so PC B can always reach the API at the venue.
- With Misbah: record backup video.

**Saturday morning**

- Agent + Docker health check on both laptops before we leave for the floor.
- Live-demo driver: Anurag runs PC B visibly (terminal large font); Misbah runs PC A and talks.

**Anurag does not** rewrite Solidity on Thursday night. If the API needs a stub escrow before contracts are deployed, stub it behind an interface Misbah will replace.

---

### Shared / stretch (whoever finishes core first)

- ENS names for the two machines
- Arkiv output storage
- Scripted agent requester (no UI) paying with x402
- Extra job type (small inference)
- Public landing page copy that matches the demo sentence
- One extra venue provider (a friend’s laptop) if we have spare time Friday night

---

## 11. Suggested clock (keep this loose, but do not invert priorities)

| When | Together | Then split |
| --- | --- | --- |
| Thu 21:00–21:30 | Repo + interfaces + “echo” job contract | — |
| Thu 21:30–01:00 | — | Misbah: contracts + deploy. Anurag: agent + echo smoke test |
| Fri morning | Integrate paid job on testnet | — |
| Fri afternoon | Slash path + World ID deny path | 0G spike (Misbah), polish UI (Anurag) |
| Fri evening | Full QA list (section 9), demo rehearsal, record video | — |
| Sat before 09:00 | Submit | — |

Hacking officially starts 9:00 PM Thursday. Do not backdate commits.

---

## 12. Risks and how we handle them

| Risk | Handling |
| --- | --- |
| “This is just token escrow” | Lead with receipt + slash + attestation. Never open the pitch with payments. |
| 0G tooling too new | Docker + hashes + slash; document 0G status; no fake attestation |
| Venue Wi‑Fi | Hotspot; local API on one laptop; recorded backup |
| Docker on Windows vs Mac | One platform flag; echo job first; resize only if hashes match both ways |
| Hedera testnet faucet / RPC | Fund wallets early Thursday night; keep a second RPC URL |
| World ID sandbox issues | Implement deny path; test before Friday night |
| Time | Cut ENS, Arkiv, extra job types, marketing pages — never cut slash path or receipt |
| Isolation not perfect | Say so: v1 is hash-bound Docker (+ TEE when ready). Full provider-blind compute is the 6–12 month product |

---

## 13. What “done” means for Mumbai

We are done when all of the following are true:

1. PC A (OS 1) can pay, post a job, and receive a correct result from PC B (OS 2).
2. A compute receipt is on Hedera with image, input, and output hashes.
3. A tampered or fake success is rejected; requester refunded; provider slashed.
4. World ID happy path and deny path both work, verified on the server.
5. x402 payment cannot be replayed.
6. We have a 2–4 minute demo video, frequent git history, `AI.md`, and a submission on Finalist + Partner Prizes with Hedera, 0G, and World selected.

After Mumbai, the same repo becomes the product: more job types, real 0G attestation by default, encrypted payloads, public provider discovery, and mainnet. The weekend is v1 of that company, not a disposable demo.

---

## 14. One-line reminder

**Mesh lets spare machines run jobs for strangers. The chain does not exist to move the fee. It exists to prove what ran, punish a lie, and leave a receipt anyone in the world can check.**
