# Mesh — Implementation Plan (v2)
**ETHGlobal Mumbai 2026 · Misbah Ansari & Anurag**

This document is the single source of truth for what we are building, why the blockchain is in it, how verification really works, how the chain integrates, and who does what. Read it end to end before writing code. If something in chat disagrees with this file, update this file first, then the code.

- **Event:** ETHGlobal Mumbai 2026, Jio World Convention Centre, BKC
- **Hacking starts:** 9:00 PM IST, Thursday 5 November 2026
- **Submissions due:** 9:00 AM IST, Saturday 7 November 2026 — no late submissions
- **Submit as:** Finalist + Partner Prizes
- **Official prizes:** https://ethglobal.com/events/mumbai/prizes
- **Official rules / submission guidelines:** https://ethglobal.com/rules and https://ethglobal.com/events/mumbai/info/details
- **Repo:** https://github.com/anuraggdubey/Mesh (first commit was after kickoff, 21:06 IST). Commit often, small commits. A single giant commit can get us disqualified.
- **Built from scratch.** No pre-existing code, site, design, or assets are reused. Anything we did not write during the event (libraries, SDKs, sponsor templates) is listed in the README.

---

## 1. What Mesh is

Mesh is a **verifiable compute marketplace**.

People (or agents) who need processing power post a **job**. People with spare capacity on their laptops run a **provider agent** and execute it. That much exists in Web2.

What makes Mesh a blockchain product, and what we demo:

> After a job runs, anyone can check — without trusting the provider's word — that **this exact code** ran on **this exact input** and produced **this exact output**; that the provider who ran it had **stake on the line**; and that a **fake or lazy run is caught and slashed**. An honest run leaves an **on-chain compute receipt** other apps can look up later.

Payment exists, but it is not the headline. The headline is **proof + slashable stake + a public receipt**, shown on real, visibly heavy computation.

We are **not** building: a Stripe clone with tokens; "A pays B after the work" as the only chain feature; a full global cloud with perfect isolation in 36 hours.

We **are** building a real v1 of a product we can keep shipping after Mumbai.

### 1.1 One sentence for judges

"Mesh lets spare laptops run jobs for strangers, and the chain proves what ran, punishes a lie, and leaves a receipt anyone can check."

### 1.2 What we claim and what we do not (say this out loud)

| We claim | We do not claim |
| --- | --- |
| Provider signs a claim over image/input/output hashes; the claim is attributable and slashable | That the provider's machine is private or that jobs are hidden from the provider |
| Deterministic jobs are checked by independent re-execution or sampling; a mismatch is slashed | That a single run is cryptographically proven (no ZK in v1) |
| AI-inference jobs carry a TEE signature from 0G, verified on Hedera | That the TEE signature proves what prompt was asked — it proves the output came out of the TEE |
| Verification is **optimistic with a challenge window**; in v1 a Mesh verifier key finalizes disputes | That Mesh is trustless. The verifier cannot forge a result; it can only finalize or reject, and every decision is public on chain |

Overclaiming is the fastest way to lose a judge's trust. Winning projects at past events (Hands Unchained, AEGIS, Opti-om) stated their own limits openly.

---

## 2. Why a blockchain (and not "just Web2 escrow")

| Need | Why Web2 is not enough | What we put on chain |
| --- | --- | --- |
| Prove what ran | Trust Mesh's servers and the provider's word | Signed claim + image/input/output hashes on a **receipt**; TEE signature for AI jobs |
| Trust strangers, no company as bank | Escrow platforms can freeze, censor, or disappear | Provider **stake** locked in a contract; **slash** on proven fraud; **refund** on failure |
| Machines / agents buy compute | Agents cannot open Stripe or UPI accounts | **x402 on Hedera**: pay inside the HTTP request, no checkout account |
| One human is not fifty fake nodes | Email sign-ups are cheap | **World ID** unique-human check on providers and requesters, verified on our server |
| Other apps can reuse the result | A private DB is not composable | Public **receipt** any contract can read; **HCS audit log** of every state change |
| Global, permissionless | "Works where our company operates" | Anyone with a wallet and a machine can request or provide |

**Lead demo sentence:** two laptops split a heavy render; an honest run produces a receipt; a cheating run is caught, slashed, and refunded; everything is on HashScan.

---

## 3. The verification model (the heart of the project)

This section is the part judges will probe in Q&A. Everything else supports it.

### 3.1 The problem

If the provider reports `outputHash`, nothing stops it from reporting a consistent fake. A hash alone proves nothing about execution. So Mesh uses **three layers**:

1. **Signed claim.** The provider signs `(jobId, imageHash, inputHash, outputHash, merkleRoot)` with its staked key. A lie is now attributable and slashable.
2. **Independent check.** The verifier recomputes some or all of the work and compares (modes below).
3. **Challenge window.** A receipt is `pending`, then `final` after the window. A mismatch inside the window means slash + refund.

### 3.2 Two verification modes

| Job class | Example | How it is checked |
| --- | --- | --- |
| **Deterministic** | tiled render, matrix multiply, hashing | **Spot-check re-execution** of random tiles/chunks, plus Merkle proofs; exact match required |
| **Non-deterministic** | AI inference | **TEE attestation** from 0G Private Computer; Hedera contract verifies the signature. Re-running cannot match, so attestation is the only honest check |

### 3.3 Determinism contract (so Windows and Mac produce identical hashes)

- Jobs use **integer / fixed-point arithmetic only** — no floating point in anything we hash.
- One platform: `linux/amd64` for every job image. Apple Silicon runs it with `--platform linux/amd64` (slower, same bytes). Pick one and never change it.
- Image referenced by **digest** (`sha256:...`), not tag. Agent refuses a mismatch.
- Hash function: SHA-256, lowercase hex, over raw bytes. Merkle tree over per-tile hashes (binary, SHA-256, sorted by tile index).
- Cross-OS test: same job, both directions, identical `merkleRoot`.

### 3.4 Spot-check and stake economics

For a deterministic job with `n` tiles, a cheater computes a fraction `f` wrongly. The verifier recomputes a random sample of `k` tiles (sampling rate `s = k/n`). Probability of catching at least one bad tile:

`P(detect) = 1 − (1 − f)^k`  (for sampling without replacement this is slightly higher)

Example: `n = 100`, `f = 10%` cheated tiles, sample `k = 20` → `P ≈ 88%`. Cheat 30% of tiles → `P ≈ 99.9%`.

**Stake rule:** `stake ≥ (value of work skipped) / P(detect)`. A rational provider will not cheat when expected loss exceeds expected gain. State this in the demo; it is the answer to "why would anyone be honest?"

Verifier sampling is **seeded after the claim is posted** (seed = blockhash/HCS sequence at claim time) so the provider cannot predict which tiles will be checked.

### 3.5 Optional stronger check: Freivalds (matrix multiply)

For a matrix job `C = A·B`, the verifier checks with Freivalds' algorithm: pick a random vector `r`, test `A(Br) == Cr` in O(n²) instead of O(n³). Each round has false-accept probability ≤ 1/2; 20 rounds ≈ 2⁻²⁰. Real verification without re-execution and without a TEE. Use mod-prime integer matrices so results are exact.

### 3.6 Fraud flow

1. Provider posts a signed claim → receipt `pending`; escrow stays locked.
2. Verifier samples and recomputes. All match → after the challenge window, receipt `final`, escrow released.
3. Any mismatch → verifier posts a **fraud result** (tile index, expected hash, claimed hash, Merkle proof) → provider slashed, requester refunded, receipt marked `rejected`.
4. Slashed stake split: part to requester as compensation, part to verifier as reward, remainder burned or kept in the pool (pick one, document it).

### 3.7 What can still go wrong (list it in the README)

- A colluding verifier + provider can finalize a bad result. Mitigation (post-Mumbai): multiple verifiers, anyone may challenge during the window.
- Provider can see job inputs. Mitigation (post-Mumbai): encrypted inputs, TEE-hosted providers.
- Docker is not a hard security boundary; it protects PC B from accidents and bad jobs, not from a determined escape.

---

## 4. Job types (what we actually compute)

The demo needs **hard, visible computation**, not "echo hello." Ship in this order.

### 4.1 `render` — primary demo job (must ship)

Tiled **fixed-point Mandelbrot / ray-traced scene**, split into tiles (e.g. 8×8 = 64 tiles, deep iteration counts so it takes real seconds of CPU).

- Visibly heavy: CPUs spike, tiles complete one by one, the image assembles live on the requester's screen.
- **Both laptops are providers**: PC A gets half the tiles, PC B the other half.
- Each tile hashed; `outputHash` = Merkle root of all tile hashes; per-tile data stored off chain by the API.
- Cheat mode on PC B (dev flag): blur / interpolate / skip some tiles. Spot-check catches it.
- One bad tile can be shown on chain with a Merkle proof.

### 4.2 `matmul` — second job (stretch, strong correctness story)

Large integer (mod-p) matrix multiply with Freivalds verification (§3.5). Less visual; show a progress bar and the "false-accept 2⁻²⁰" line.

### 4.3 `infer` — private inference via 0G (must ship if 0G is a pick)

A small model call routed through **0G Private Computer** (OpenAI-compatible API). The receipt for this job is valid **only if** 0G's TEE signature verifies on Hedera. Without 0G this job type has no verification at all, so 0G is load-bearing, not decoration. Record the 0G **request ID** on the receipt and in the UI. See §7.

### 4.4 `echo` — sanity job

`echo hello` for the no-chain smoke test only. Never demo it.

---

## 5. Partner tracks we enter (max 3 partners, confirmed)

Rules (verified on the Mumbai submission guidelines): select **up to 3** partner prizes; multiple tracks of one partner count as one pick. Partner-only judging uses the materials we submit; booth visits are optional. Confirm live prize text before submitting.

1. **Hedera — "AI Agents That Pay: x402 on Hedera"** ($6,500: $3,000 / $2,000 / $1,500)
   Requirements from the prize page: at least one x402-protected endpoint settling on Hedera (testnet or mainnet) via a listed facilitator (Official x402, Ax402, Blocky402) or our own; **an agent/client completes one paid request end to end with no human approving**; public README covering setup, architecture, payment flow and a **settled Hedera transaction ID**; demo video ≤ 5 min linking to HashScan.
   Extra points we plan to take: spending controls (budget, per-job cap, allowlist); **HCS topic as tamper-evident audit log**; ERC-8004 / HCS-14 identity if time; Hedera Agent Kit if time.
   Consequence: the **scripted agent requester is core**, not stretch.

2. **0G — "Build with 0G Private Computer"** ($5,000: $2,500 / $1,500 / $1,000)
   Requirements: inference on 0G Private Computer **in the main flow with request IDs**, working app, one sentence on **what breaks without 0G**, demo video under 3 min + live link, contract addresses. 0G does not want generic chat wrappers or an AI call that can be removed unnoticed. Our answer: the `infer` job's verification is the 0G signature; remove 0G and the receipt cannot be validated.
   If 0G tooling blocks us: ship `render` + Hedera + World first, keep `infer` as the next job, never fake an attestation, and write `docs/OG-STATUS.md`.

3. **World** — one of:
   - **Best Use of IDKit** (2 teams × $1,250): use the **minimum sufficient credential** (likely Proof of Human); IDKit in a working flow; server or on-chain verification; explain the trust event; one success path and one alternative path; short debrief.
   - **World ID Agent Pass** ($5,000: $2,500 / $1,500 / $1,000): official Agent Pass integration; full request → completion → validated result → protected action; a **denied/expired/cancelled** path where the action does not happen; validation in a secure backend; integration debrief.
   Plan: use IDKit to gate providers (one human, one provider profile) and Agent Pass to authorize the scripted agent requester. Decide the final single pick after reading the live pages Friday morning. Proofs in the sandbox use fake identities; do not claim production Sybil resistance.

**Optional only if the core is done** (does not take a pick unless the work is real): Arkiv "build from scratch" ($4,000; job board/claims that expire, plus `schema.md` and `friction.md`). **ENS is cut**: ENSv2 must be central to the product; a name in an activity feed will not place.

**Judging categories we write toward** (all submissions): Technicality, Originality, Practicality, Usability, WOW. Finalist session: 7 minutes (4 demo, 3 judge Q&A).

---

## 6. Roles: two machines (PC A and PC B)

| Name | Owner | OS | Demo role |
| --- | --- | --- | --- |
| **PC A** | Anurag | Windows or Mac | **Requester**: browser UI + scripted agent, API host (light work only) |
| **PC B** | Misbah | The other OS | **Provider + verifier**: Docker, heavy processing, cheat mode |

Anurag's laptop cannot handle heavy processing, so all Docker, rendering, and verifier recomputation run on Misbah's machine. Cross-OS determinism is proven with a **tiny test tile** run on both laptops. A second provider is a second agent instance, a friend's laptop, or a cloud VM (see `MISBAH.md` §10). Per-person task lists: `MISBAH.md` and `ANURAG.md`.

Both machines need: Git, Node.js 20+, Docker Desktop **running**, a Hedera testnet wallet funded, the Mesh agent installed, World ID done once, same network (venue Wi‑Fi first, hotspot backup).

If Docker is painful on one machine, fall back to a Node/WASM job runner that gives identical integer results on both OS runtimes. No OS-specific demo jobs.

---

## 7. How compute works (PC A ↔ API ↔ PC B)

```
Requester (agent or UI)      Mesh API / Verifier              Provider(s)
   | 1. World ID / Agent Pass check (server)                      |
   | 2. POST /jobs {image, input, params}                         |
   | 3. HTTP 402 + payment instructions (payTo = escrow) -------->|
   | 4. x402 payment on Hedera (nonce = jobId)                    |
   | 5. Facilitator verifies, replay-checks, escrow locks         |
   |                              | 6. Job split into tiles, assigned
   |                              |---------------------------->  |
   |                              | 7. Pull image (digest), run in Docker
   |                              |<---- tile hashes + signed claim
   |                              | 8. Receipt posted as PENDING   |
   |                              | 9. Seeded spot-check recompute |
   | 10. Live image / result      | 10. Window passes: FINAL, release
   |                              |     or FRAUD: slash + refund   |
   | 11. Receipt + HCS audit trail visible on HashScan            |
```

### 7.1 Job object (stored by API, referenced on chain by `jobId`)

- `jobId`, `type` (`render | matmul | infer | echo`), `mode` (`deterministic | attested`)
- `requester` (address + World ID nullifier hash, server-checked), `providers[]` (set on assignment)
- `imageRef` + `imageHash` (container digest); `inputRef` + `inputHash`; `params` (tile count, iterations, seed)
- `tiles[]`: `{index, provider, tileHash, status}`
- `merkleRoot` (render/matmul) or `0gRequestId` + `attestation` (infer)
- `claimSig` (provider-signed claim); `verifier` seed + sample indices + result
- `price`, `stakeRequired`, `timeoutSeconds`
- `status`: `created | paid | assigned | running | pending | final | challenged | rejected | slashed | refunded | expired`
- `receiptTx`, `hcsSequence`

### 7.2 Execution on a provider

1. Receive job; verify `imageHash` after pulling (refuse on mismatch).
2. Verify `inputHash` before running.
3. `docker run --rm --network none --platform linux/amd64` with CPU/memory limits and a timeout.
4. Per tile: write output, compute `tileHash`.
5. Sign the claim; POST to the API.
6. On failure report reason: `timeout | crash | hash_mismatch | attestation_missing | killed`.
7. The agent never decides success. API + contract do.

### 7.3 Isolation levels (ship in this order)

1. **Must:** Docker isolation + hashes + signed claims + spot-check re-execution.
2. **Should:** 0G attestation for `infer`.
3. **Nice:** encrypted inputs (TLS only for the hack).

---

## 8. On-chain design (Hedera testnet)

Hedera because it is EVM-compatible and x402 is an explicit Mumbai track. Testnet only. Keep contracts small; emit rich events.

### 8.1 Contracts (Solidity, Foundry)

**`MeshReceipt.sol`**
- `postClaim(jobId, imageHash, inputHash, merkleRoot, provider, requester, claimSig)` → `pending`, starts challenge window.
- `finalize(jobId)` after the window → `final`.
- `postFraud(jobId, tileIndex, expectedHash, claimedHash, merkleProof)` (verifier-only in v1) → `rejected`, triggers slash/refund.
- `postAttested(jobId, ..., teeSig)` for `infer`: contract `ecrecover`s 0G's signature over the output digest and checks the signer against a configured 0G signer address. (Pattern: a Hedera contract verifying the TEE signature on an AI result. We implement it ourselves.)
- Append-only; `getReceipt(jobId)` public; events `ClaimPosted`, `ReceiptFinal`, `FraudProven`.

**`MeshStake.sol`**
- `stake()` (HBAR or test token), `unstake()` after delay, `slash(provider, jobId, amount, reason)` callable only by the receipt contract.
- Stake minimum scales with job value per the §3.4 rule.
- Provider must hold a World-ID-verified profile (checked off chain; nullifier stored to prevent two profiles per human).

**`MeshEscrow.sol`**
- Locked on x402 payment confirm (payTo = escrow, nonce = `jobId`).
- `release(jobId)` only if receipt is `final`; `refund(jobId)` if `rejected | failed | expired`. Mutually exclusive, reentrancy-guarded.

**`MockStable.sol`** only if Hedera test USDC is not usable.

### 8.2 HCS audit log

Every state change (paid, assigned, claim, sample seed, verdict, slash, release) is published to a Hedera Consensus Service topic. Anyone can replay the full history of a job from the topic, independent of our API. This is an explicit Hedera extra-points item and strengthens the "don't trust our server" story.

### 8.3 x402 flow

1. `POST /jobs` without payment → `402` with payment instructions (amount, asset, `payTo = escrow`, nonce = `jobId`).
2. Client retries with the x402 payment header.
3. Facilitator verifies the Hedera payment, **checks replay** (same nonce cannot pay twice), marks the job `paid`, locks escrow.
4. Only then is the job eligible for assignment.

**Scripted agent requester (core):** a small script with a wallet, a budget, a per-job cap, and an allowlist of image digests posts a job, pays via x402 with **no human clicking**, and waits for a receipt. A human UI exists too, but the agent is the Hedera-track demo.

**Spending controls (extra points):** max budget, per-job cap, allowed providers/images, human-approval threshold above a limit.

### 8.4 World ID

- Verify **on our server**, not only in the browser.
- Protected actions: `register-provider`, `create-job` (and agent authorization if Agent Pass).
- Required **denied path**: expired / cancelled / invalid proof → action does not happen. Show both paths.
- Short debrief written for the sponsor.

### 8.5 0G Private Computer (`infer` job)

- Workload: a small model call through 0G's OpenAI-compatible endpoint.
- Capture: request ID, TEE-signed response, signer address.
- Verify: API checks the signature, then Hedera contract `ecrecover`s it on `postAttested`.
- Honest limit (say it): the signature proves the output came from 0G's TEE, not what prompt produced it.
- If blocked: `docs/OG-STATUS.md` listing exactly what blocked us; no fake proofs.

---

## 9. Repository and framework choices

```
mesh/
  README.md                ← setup, architecture, payment flow, Hedera tx ID, honest limits
  AI.md                    ← every file/feature AI wrote or substantially edited
  docs/
    IMPLEMENTATION-PLAN.md ← this file (or keep at repo root)
    QA.md  DEMO.md  OG-STATUS.md  FEEDBACK-*.md
  apps/
    web/    Next.js + TypeScript + Tailwind: requester UI, live render, receipt explorer, provider panel
    api/    Node (Hono or Next route handlers): jobs, x402 facilitator, World verify, verifier, HCS publisher
    agent/  Node CLI + worker: provider runtime; scripted agent requester lives in packages/sdk
  packages/
    shared/ types, ABIs, chain IDs, hash/Merkle helpers
    sdk/    createJob, payX402, waitForReceipt; scripted agent
  contracts/  Foundry
  jobs/
    echo/  render/  matmul/  infer/
```

**Stack:** TypeScript everywhere; Next.js for a demo-ready UI; Foundry for tests we can show; Docker for cross-OS jobs; Hedera JSON-RPC with viem/ethers; Hedera SDK for HCS.

**Environment variables** (never commit secrets; `.env.example` committed):
- `HEDERA_RPC_URL`, `HEDERA_CHAIN_ID`, `DEPLOYER_PRIVATE_KEY`, `HEDERA_OPERATOR_ID/KEY`, `HCS_TOPIC_ID`
- `RECEIPT_ADDRESS`, `STAKE_ADDRESS`, `ESCROW_ADDRESS`
- `WORLD_ID_APP_ID`, `WORLD_ID_ACTION`, `WORLD_ID_VERIFY_SECRET`
- `X402_FACILITATOR_URL` (or in-process)
- `OG_API_KEY` / endpoint, `OG_SIGNER_ADDRESS`
- `VERIFIER_PRIVATE_KEY`, `API_PUBLIC_URL` (reachable from both PCs; tunnel or hotspot LAN IP)

**AI use:** keep `AI.md`. ETHGlobal allows AI with attribution but submissions that rely entirely on AI without meaningful team contribution may lose partner-prize and finalist eligibility. If we use spec-driven workflows, spec files go in the repo.

---

## 10. Demo script (4 minutes) and Q&A prep

Finalist session = 4 min demo + 3 min Q&A. Submission video = 2–4 minutes, at least 720p, our own voice (no text-to-speech, no phone recording, no sped-up footage, intro ≤ 20 s, ≤ 4 bullets per slide).

1. **(15s)** "Mesh is verifiable spare compute — the chain proves what ran, punishes a lie, and leaves a receipt."
2. **(40s)** A **scripted agent** on PC A posts a heavy render job, pays via x402 on Hedera (no checkout, no human click). Show World ID approved.
3. **(50s)** Render splits across PC A and PC B. Both CPUs spike; the image assembles live; tile hashes stream by.
4. **(40s)** Honest receipt on HashScan: image/input/output hashes, Merkle root, spot-check seed, HCS trail. Escrow releases after the window.
5. **(55s)** **Cheat run:** PC B blurs some tiles. Verifier's seeded spot-check catches it. Show the fraud proof (tile + Merkle proof), slash tx, refund tx.
6. **(25s)** `infer` job through 0G: show the request ID and the TEE signature verified by the Hedera contract. One sentence: "without 0G this job type has no verification."
7. **(15s)** Optional: denied World ID path.

**Likely judge questions and our answers**
- *"How do you know the output was wrong?"* Independent recomputation of seeded random tiles; mismatch proven with a Merkle proof.
- *"Why would anyone be honest?"* Stake ≥ skipped-work value ÷ detection probability (§3.4).
- *"Can the provider just skip the unchecked tiles?"* Yes at risk: detection probability grows quickly with the cheated fraction; the sample seed is unknown at claim time.
- *"Is the verifier trusted?"* In v1 yes for finalizing disputes, but it cannot forge results and every decision is on HCS/chain; multi-verifier is the next step.
- *"Why Hedera?"* x402 track + low fees + HCS audit log + EVM contracts.
- *"What does 0G add?"* The only verification path for non-deterministic AI jobs.

Backup: pre-recorded 720p video of the full flow if venue Wi‑Fi dies. Both machines tested on hotspot before the final session.

---

## 11. Testing workflow (do not skip)

Write expected vs actual for each case in `docs/QA.md` as you go.

1. **Setup.** Docker running on both laptops; funded Hedera wallets; World ID done; agent installed; API reachable.
2. **Smoke, no chain.** `echo hello` PC A → API → PC B → result. Fail here → do not touch contracts.
3. **Hashes.** Change one byte of image or input; job must fail verification.
4. **Determinism.** `render` run on Mac and Windows produces the identical Merkle root, both directions.
5. **Happy path.** x402 pay → lock → split render → claim → spot-check → final → release.
6. **Cheat detection.** Tamper N% of tiles; verifier catches at the expected rate; slash + refund. Run it 20× and record the empirical detection rate against §3.4.
7. **Failure refund.** Kill container / force timeout; requester refunded; provider not paid.
8. **Replay.** Same x402 payment twice; second rejected.
9. **Agent requester.** Budget cap and allowlist enforced; over-cap job denied.
10. **World ID deny.** Expired/cancelled proof; protected action does not happen.
11. **0G.** `infer` returns request ID + signature; contract accepts a valid one, rejects a tampered one.
12. **Disconnect.** Unplug PC B mid-job; timeout → refund; tiles reassigned.
13. **Venue rehearsal.** Time the happy path; someone else runs PC B if possible.
14. **Recordings** of happy path and cheat path.

---

## 12. Work split

**The detailed, current task lists are `MISBAH.md` (Docker, heavy processing, agent, verifier, 0G job) and `ANURAG.md` (contracts, API, x402, World ID, HCS, frontend, scripted agent, docs). Where the role descriptions below differ, those two files win.**

Overlap is dangerous; interfaces are agreed below. If someone finishes early, take items from **Shared / stretch**, not the other person's core.

### Agreed interfaces (do not change without telling the other person)

- Job schema (§7.1) and statuses
- `POST /jobs`, `GET /jobs/:id`, `POST /jobs/:id/result`, `GET /receipts/:jobId`, `POST /jobs/:id/claim`
- Docker image contract: read `/input`, write `/output/tile-<i>`, exit 0 on success; integer-only math
- Hashing: SHA-256 lowercase hex; Merkle tree format in `packages/shared`
- 402 response format and x402 header handling
- Chain IDs and contract ABIs in `packages/shared`

### Misbah — chain, verification, product truth

**Thursday night (after 9:00 PM IST)**
- README stub, `.env.example`, `AI.md`.
- Foundry: `MeshReceipt`, `MeshStake`, `MeshEscrow`. Tests: cannot release without `final`; no double release; fraud → slash + refund; replay-safe job IDs; Merkle proof verification; `ecrecover` check for 0G signer.
- Deploy to Hedera testnet; commit addresses (not keys).
- World ID server verify (`register-provider`, `create-job`).
- Agree the 402 format with Anurag.

**Friday**
- x402 facilitator (verify, replay protection, escrow lock) and HCS publisher.
- Verifier service: seeded sampling, tile recompute, Merkle fraud proof, post `finalize`/`postFraud`.
- Receipt explorer: paste `jobId` → hashes, Merkle root, verdict, HashScan + HCS links.
- 0G spike: one `infer` request with signature verified on chain, or `docs/OG-STATUS.md`.
- Denied World ID path; spending-controls policy for the agent.
- Sponsor feedback notes and `docs/DEMO.md`.

**Saturday morning:** rehearse; confirm testnet funds; submit.

Misbah does not polish landing pages on Thursday.

### Anurag — agent, runner, two-OS reality, requester UX

**Thursday night**
- Scaffold `apps/web`, `apps/api`, `apps/agent`.
- Provider agent: register, heartbeat, poll, pull image by digest, run Docker with limits and `--network none --platform linux/amd64`, hash tiles, sign claim, POST.
- `jobs/echo` then `jobs/render` (fixed-point, deterministic).
- No-chain smoke test passing.

**Friday**
- Live render UI: tiles appear as they finish; per-provider CPU/progress; status states.
- Wire x402 payment (Misbah's 402 format) and World ID widgets.
- Scripted agent requester in `packages/sdk`.
- Provider dashboard: current job, logs, last hashes.
- Dev-only `--tamper` flag on the agent (never default on) for the cheat demo.
- Cross-OS determinism matrix; LAN/tunnel setup; `jobs/matmul` if time.
- Record backup video with Misbah.

**Saturday morning:** agent + Docker health check on both laptops; drive PC B in the demo (large terminal font).

Anurag does not rewrite Solidity; if the API needs a stub escrow, build it behind an interface Misbah replaces.

### Shared / stretch (whoever finishes core first)

- `matmul` with Freivalds
- Arkiv job board (only if it can be central)
- ERC-8004 / HCS-14 identity for the agent
- Extra venue provider
- Landing page copy matching the demo sentence

---

## 13. Suggested clock

| When | Together | Then split |
| --- | --- | --- |
| Thu 21:00–21:30 | Interfaces, tile format, determinism rules, 402 format | — |
| Thu 21:30–01:00 | — | Misbah: contracts + deploy. Anurag: agent + echo smoke test |
| Fri morning | Deterministic render across both OS; integrate paid job on testnet | — |
| Fri afternoon | Verifier + cheat path + fraud proof; World deny path | 0G spike (Misbah), live UI (Anurag) |
| Fri evening | Full QA (§11), demo rehearsal, record video | — |
| Sat before 09:00 | Submit | — |

Do not backdate commits.

---

## 14. Risks and how we handle them

| Risk | Handling |
| --- | --- |
| "This is just token escrow" | Open with proof, slash, receipt — never payments |
| "How is wrong detected?" | Seeded spot-check + Merkle fraud proof; stake math in §3.4 |
| Verifier trust questioned | State it plainly (§1.2, §3.7); everything public on chain + HCS |
| 0G tooling too new | `render` + Hedera + World ship regardless; `infer` is additive; document status; no fake proofs |
| x402 is crowded (many projects use it) | Differentiate on verification + slashing; use agent spending controls and HCS audit trail |
| Determinism breaks across OS | Integer-only math, one platform flag, digest pinning, test early Friday morning |
| Docker on Windows/Mac | Echo first; Node/WASM fallback runner |
| Venue Wi‑Fi | Hotspot; local API on one laptop; recorded backup |
| Hedera faucet / RPC | Fund wallets early Thursday; keep a second RPC URL |
| World sandbox issues | Implement deny path; test before Friday night |
| Time | Cut order: ENS, Arkiv, matmul, extra job types, landing page — never the render demo, receipt, or slash path |
| Isolation not perfect | Say so: v1 is hash-bound Docker + spot-check (+ TEE for AI jobs) |
| Disqualification | Fresh repo, steady commits, `AI.md`, README lists third-party code, no faked attestations |

---

## 15. What "done" means for Mumbai

1. A scripted agent on one OS pays via x402 on Hedera, posts a render job, and receives a correct result computed across two machines on two OSes.
2. A receipt on Hedera shows image/input hashes and the Merkle root; the full history is on an HCS topic.
3. A cheating provider is caught by a seeded spot-check, slashed, and the requester is refunded, with the fraud proof shown.
4. An `infer` job through 0G has a request ID and a TEE signature verified by the Hedera contract (or `OG-STATUS.md` explains exactly why not).
5. World ID happy path and denied path both work, verified on the server.
6. x402 replay is rejected; the agent's spending cap is enforced.
7. 2–4 minute demo video (≥720p, our voice), frequent git history, `AI.md`, README with Hedera transaction IDs, and a submission on Finalist + Partner Prizes with Hedera, 0G, and World.

After Mumbai: more job types, multi-verifier challenges, encrypted inputs, TEE-hosted providers, public discovery, mainnet.

---

## 16. One-line reminder

**Mesh lets spare machines run jobs for strangers. The chain does not exist to move the fee. It exists to prove what ran, punish a lie, and leave a receipt anyone in the world can check.**
