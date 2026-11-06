# Anurag — Backend, Contracts, Frontend, Payments, Identity

**You own everything that does not need heavy CPU or Docker:** the API and matcher, x402 facilitator, World ID, the Solidity contracts and deployment, the HCS audit log, the web UI, the scripted agent requester, and docs/submission. Your laptop is the **requester machine** (browser + scripted agent). It never runs heavy jobs.

Read `MESH-IMPLEMENTATION-PLAN.md` first (§5 partners, §7 flow, §8 on-chain, §10 demo). This file is your checklist. Misbah's is `MISBAH.md`.

**Rule:** nothing you build may require running Docker or rendering locally. Use a mock provider when Misbah's agent is not ready.

---

## 0. What you depend on from Misbah

| From Misbah | You use it for | Needed by |
| --- | --- | --- |
| Tile format / job spec (`docs/job-spec.md`) | Tile splitting, UI grid | Thu 21:30 |
| Merkle/hash helpers (`src/lib`) | API checks, explorer | Thu 23:00 |
| Claim signature format | `postClaim` signature check | Thu 23:00 |
| `render` image digest | Job creation form | Fri morning |
| Fraud payload format | `postFraud`, UI display | Fri afternoon |
| 0G signer address + signature encoding | `postAttested` | Fri afternoon |

You give Misbah: API endpoints, contract ABIs/addresses, 402 format, World provider token flow. Agree interfaces together 21:00–21:30 Thursday.

---

## 1. System setup (Thursday, first 30 min)

- [ ] Node.js 20+ (24 installed), Git, npm, Foundry (`foundryup`).
- [ ] Hedera testnet account(s) created and funded: deployer, requester/agent wallet, facilitator/operator.
- [ ] Hedera operator ID/key for HCS (SDK).
- [ ] World developer portal app created (App ID, action IDs `register-provider`, `create-job`).
- [ ] `.env.example` committed (no secrets); local `.env` filled.
- [ ] A way for Misbah's machine to reach the API: run the API on your laptop (LAN IP) **or** deploy it (Railway/Render/Vercel) or use a Cloudflare Tunnel. Test from Misbah's machine early.
- [ ] Repo is ONE Next.js full-stack app (`npm install`, `npm run dev`); workers in `workers/`, scripts in `scripts/`, Foundry in `contracts/`, job images in `jobs/`.
- [ ] `README.md` stub, `AI.md` started, plan copied to `docs/IMPLEMENTATION-PLAN.md`.
- [ ] Small, frequent commits from the start.

---

## 2. Smart contracts (`contracts/`, Foundry)

Keep small. Rich events.

### 2.1 `MeshStake.sol`
- [ ] `stake()`, `unstake()` with delay, `stakeOf(provider)`.
- [ ] `slash(provider, jobId, amount, reason)` callable only by the receipt contract.
- [ ] Store World ID nullifier → provider mapping; one profile per human.
- [ ] Events: `Staked`, `Slashed`, `Unstaked`.

### 2.2 `MeshEscrow.sol`
- [ ] Lock on x402 payment confirm (`payTo` = escrow, nonce = `jobId`).
- [ ] `release(jobId)` only when receipt is `final`; `refund(jobId)` when `rejected | failed | expired`.
- [ ] Mutually exclusive, reentrancy guard, checked status.
- [ ] Events: `Locked`, `Released`, `Refunded`.

### 2.3 `MeshReceipt.sol`
- [ ] `postClaim(jobId, imageHash, inputHash, merkleRoot, provider, requester, claimSig)` → `pending`, starts challenge window (short on testnet, e.g. 30–60 s).
- [ ] `finalize(jobId)` after window.
- [ ] `postFraud(jobId, tileIndex, expectedHash, claimedHash, merkleProof)` verifier-only → `rejected`, triggers slash + refund; verify the Merkle proof on chain.
- [ ] `postAttested(jobId, outputDigest, teeSig)` for `infer`: `ecrecover` against configured 0G signer.
- [ ] Append-only; `getReceipt(jobId)`.
- [ ] Events: `ClaimPosted`, `ReceiptFinal`, `FraudProven`, `AttestedPosted`.
- [ ] Slashed stake split (requester / verifier / pool) — decide and document.

### 2.4 Tests and deploy
- [ ] `forge test`: cannot release without `final`; no double release; fraud → slash + refund; replay-safe job IDs; Merkle proof accept/reject; wrong signer rejected; challenge window respected.
- [ ] `MockStable.sol` only if Hedera test USDC is unusable.
- [ ] Deploy to Hedera testnet; write addresses to `.env.example` and `src/lib`; export ABIs.
- [ ] Verify contracts on HashScan if possible.

---

## 3. Backend API (`src/app/api + src/lib`)

Next.js route handlers (`src/app/api`) with logic in `src/lib`. Storage: `node:sqlite` (built into Node 24) under `data/`, plus a file store for tiles/inputs. Keep it simple.

### 3.1 Endpoints
- [ ] `POST /jobs` → 402 or create `paid` job.
- [ ] `GET /jobs/:id` (status, tiles, progress, verdict).
- [ ] `GET /jobs/:id/events` (SSE/WebSocket) for the **live tile stream** to the UI.
- [ ] `POST /jobs/:id/claim` (provider claim + tiles).
- [ ] `POST /jobs/:id/result` (per Misbah's agreed schema).
- [ ] `GET /receipts/:jobId`.
- [ ] `POST /providers/register`, `POST /providers/heartbeat`, `GET /providers`.
- [ ] `POST /verify/world` (server-side proof verification).
- [ ] `GET /health`.

### 3.2 Job lifecycle and matcher
- [ ] Job states per plan §7.1: `created | paid | assigned | running | pending | final | challenged | rejected | slashed | refunded | expired`.
- [ ] **Tile splitting** per Misbah's spec; assign tiles across online, staked providers (round robin / by cores).
- [ ] Reassign tiles on provider timeout/disconnect.
- [ ] Timeouts per job; expire → refund.
- [ ] Verify the provider signature on claims; check `inputHash`/`imageHash` match the job.
- [ ] Trigger on-chain `postClaim` (or have the provider/verifier do it — decide once with Misbah).
- [ ] Store tile blobs so the verifier can recompute and the UI can render.
- [ ] Idempotency on every endpoint; reject duplicate claims.

### 3.3 x402 facilitator (Hedera)
- [ ] `402` response: amount, asset, `payTo = escrow`, nonce = `jobId`, expiry.
- [ ] Verify the client's payment header/transaction on Hedera (use a listed facilitator — Official x402 / Ax402 / Blocky402 — or your own).
- [ ] **Replay protection**: nonce used once; persist.
- [ ] On success: mark `paid`, confirm escrow lock on chain.
- [ ] Document a **settled payment transaction ID** (needed for the Hedera README requirement).

### 3.4 HCS audit log
- [ ] Create an HCS topic; save `HCS_TOPIC_ID`.
- [ ] Publish every state change: paid, assigned, claim, sample seed, verdict, slash, release (small JSON + job ID).
- [ ] Expose sequence numbers in job data; link to HashScan.

### 3.5 World ID (server side)
- [ ] Verify proofs for `register-provider` and `create-job` actions.
- [ ] Store nullifier hash; reject a second provider profile per human.
- [ ] **Denied path**: expired / cancelled / invalid proof → protected action does not happen; return a clear error.
- [ ] Decide **one World pick** (IDKit vs. Agent Pass) Friday morning after reading the live pages; if Agent Pass: authorize the scripted agent through the official flow.
- [ ] Remember: sandbox proofs use fake identities; do not claim production Sybil resistance.

### 3.6 Spending controls for the agent (Hedera extra points)
- [ ] Policy object: max budget, per-job cap, allowed image digests, allowed providers, human-approval threshold.
- [ ] Enforce server-side; log denials to HCS.

### 3.7 Mock provider
- [ ] A fake provider that returns canned tiles so you can build UI and API without Misbah's agent or Docker.

---

## 4. Scripted agent requester (`scripts/`)

- [ ] `createJob`, `payX402`, `waitForReceipt` functions.
- [ ] CLI script: has a wallet, a budget, a per-job cap, an image allowlist; posts a render job, pays via x402 **with no human click**, waits for the receipt, prints HashScan links.
- [ ] Denied-case demo: over-budget or non-allowlisted job is rejected.
- [ ] This is the Hedera-track demo, so it must be reliable.

---

## 5. Frontend (`src/app + src/components`)

Next.js (App Router) + TypeScript + Tailwind. Demo-ready, clean, big fonts.

### 5.1 Requester UI
- [ ] Create job form: choose type (`render`, `matmul`, `infer`), params, price, show estimate.
- [ ] World ID widget (IDKit) before job creation; clear success and **denied** states.
- [ ] Wallet connect (Hedera / EVM) and x402 payment step with status.
- [ ] Job page: status timeline (all states), per-provider progress, **live tile grid that fills in as tiles arrive**, assembled image preview.

### 5.2 Provider panel
- [ ] List providers online, stake, current job, last hashes, logs (last N lines).
- [ ] Provider registration page with World ID and stake action.

### 5.3 Receipt explorer
- [ ] Paste `jobId` → show hashes (image, input, output/Merkle root), provider(s), claim signature, sample seed, sampled tiles, verdict (`final` / `rejected`), slash tx, refund tx, HCS sequence, HashScan links.
- [ ] Fraud view: highlight the bad tile, expected vs. claimed hash, Merkle proof.
- [ ] Live activity feed of events (contract events + HCS).

### 5.4 Demo console page
- [ ] A single "demo" page showing: scripted agent log, payment, live render, receipt, cheat result side by side — so the 4-minute demo needs few clicks.

### 5.5 UX polish
- [ ] Loading, error, empty states; mobile-safe layout not required but nothing broken.
- [ ] Failure UX: timeout, crash, "verification failed" with a clear reason.
- [ ] Dark mode optional; large readable fonts for the projector.

---

## 6. Integrations and glue

- [ ] ABIs and addresses from `contracts/` into `src/lib`.
- [ ] viem client config for Hedera testnet (chain ID, RPC, second RPC fallback).
- [ ] Shared types: Job, Tile, Claim, Receipt.
- [ ] Error-handling convention and logging (pino/console with job IDs).
- [ ] Env validation at boot (fail fast on missing keys).

---

## 7. Docs, submission, feedback

- [ ] `README.md`: setup, architecture diagram, payment flow, **Hedera settled-payment transaction ID**, honest limits, third-party code list.
- [ ] `AI.md`: every file/feature AI wrote or substantially edited; spec files in repo if used.
- [ ] `docs/QA.md` (shared with Misbah), `docs/DEMO.md`, `docs/FEEDBACK-*.md` for Hedera, World, 0G.
- [ ] World debrief note and Hedera integration note.
- [ ] Demo video: 2–4 min, ≥720p, our own voice, no TTS/phone/speed-up, intro ≤ 20 s (record with Misbah Friday night).
- [ ] Submission form: title, description, repo, video, up to 3 partner picks (Hedera, 0G, World), Finalist + Partner Prizes, AI disclosure.
- [ ] Confirm the live prize text one more time before submitting.

---

## 8. Tests you own (`docs/QA.md`)

- [ ] Contract tests (`forge test`) all green.
- [ ] Replay: same x402 payment twice → second rejected.
- [ ] World deny: expired/cancelled proof → no job, no provider registration.
- [ ] Agent spending caps: over-cap and non-allowlisted denied.
- [ ] Timeout refund: provider disappears mid-job → tiles reassigned or refund.
- [ ] API idempotency and duplicate-claim rejection.
- [ ] End to end with the mock provider, then with Misbah's real agent.
- [ ] Cross-OS: your machine requests, Misbah's provider computes; UI shows the identical result.

---

## 9. Demo ownership (Saturday)

- [ ] You run the **requester side**: scripted agent, browser UI, receipt explorer, HashScan tabs.
- [ ] You speak the pitch and Q&A answers on verification and stake math (plan §10).
- [ ] Pre-open all tabs; wallets funded; API reachable from both laptops; hotspot tested.
- [ ] Backup video ready on the desktop.

---

## 10. Timeline

| When | You |
| --- | --- |
| Thu 21:00–21:30 | With Misbah: interfaces, tile spec, claim and 402 format |
| Thu 21:30–01:00 | Repo scaffold, contracts + tests, deploy, API skeleton + mock provider |
| Fri morning | x402 facilitator, tile matcher, live UI, real agent integration |
| Fri afternoon | `postFraud`/`postAttested`, HCS log, World verify + deny path, agent requester |
| Fri evening | Receipt explorer polish, QA, docs, record video with Misbah |
| Sat before 09:00 | Final README/submission, demo setup, submit |

## 11. Definition of done (your part)

1. Contracts deployed with passing tests; slash and refund work on chain.
2. x402 payment settles on Hedera with a recorded transaction ID; replay is rejected.
3. The scripted agent completes a paid job with no human click; caps enforced.
4. World ID happy and denied paths verified server-side.
5. UI shows the live tile stream, receipt, fraud proof, and HCS trail.
6. Repo, README, `AI.md`, video and submission are complete.


---

## Track work (added 2026-11-06, see docs/TRACKS.md)

Everything about what each sponsor requires, the technical facts and the open decisions is in **docs/TRACKS.md**. Read sections 2 (Hedera), 3 (World) and 6 (things only you can do).

### Already built (AI-assisted, tested; review before relying on it)

- [x] IDKit server: `POST /api/world/rp-context`, proof verification with the environment pinned, nullifier store (one human, one wallet), registration gated on a proof, denied path (spec section 11).
- [x] Agent Pass backend: device grant, ID token validation, approvals bound to one exact action and single use, spending-threshold gate on `POST /api/jobs` (spec section 17).
- [x] Provider client and worker accept `worldProof` (`PROVIDER_WORLD_PROOF`).
- [x] x402 on `POST /api/jobs` (Hedera, v2 headers, replay protection, settled tx stored on the job); escrow mirrors the payment (option B). 20 tests with a fake facilitator.
- [x] Scripted agent (`npm run agent -- small`): x402 payment, budget, per-job cap, preset and payee allowlists, approval flow above the threshold. 14 tests; the real x402 client signs offline.
- [x] Verifier endpoint `POST /api/verifier/verdict` (signed by the verifier key), slash and refund bookkeeping, chain adoption of a `Rejected` receipt. 13 tests.
- [x] HCS audit log (`src/lib/hcs.ts`), built from job events, retried, 1 KB guard; `npm run hcs:create-topic`; receipts return topic and sequences. 14 tests (fake submitter; **not yet run against live Hedera**).
- [x] **0G AI review** of the finished render (`src/lib/og.ts`, `review.ts`, `png.ts`, `/api/jobs/:id/review`, job page panel, HCS `INFERENCE`, receipt field). 27 tests with a fake Router; **needs your 0G key and a live spike** (docs/OG-STATUS.md).
- [x] IDKit widget page `/provider/verify` (renders; a full scan needs the portal app) and a "Become a provider" link.

### Only you can do (accounts, keys, funds, decisions)

- [ ] Create the **developer.world.org** app: set `NEXT_PUBLIC_WORLD_APP_ID`, `WORLD_RP_ID`, `WORLD_SIGNING_KEY` in `.env`. Action name: `register-provider`.
- [ ] Create the **auth.world.org** confidential OIDC client (accept **Orb only**): set `WORLD_IDP_CLIENT_ID`, `WORLD_IDP_CLIENT_SECRET`. Then set `AGENT_APPROVAL_THRESHOLD` (for example `200000`).
- [ ] Fund the **API wallet** (treasury) and the **agent wallet** with testnet HBAR (`small` costs 0.5 HBAR, `tiny` 0.1). Set `AGENT_PRIVATE_KEY` (ECDSA) and `X402_ENABLED=true`. (x402 option B was chosen, so no USDC or token association is needed.)
- [ ] Run `npm run hcs:create-topic` once and set `HCS_TOPIC_ID`.
- [ ] Get an HTTPS URL for the API (tunnel or small server) for the World approval and the demo link.
- [ ] Run the agent live (`npm run agent -- small`) and paste the settled transaction ID and HashScan link into the README.
- [ ] Optional: tell Claude if you want 0G as a stretch or a third partner pick (0G is dropped by default).

### Still to do

1. [ ] Live checks that need your keys: first x402 settlement on testnet, first HCS message, first World ID scan and first Agent Pass approval. Fill the timings into `docs/FEEDBACK-world.md` and `docs/FEEDBACK-hedera.md`.
2. [ ] Step 12 with Misbah: merge the real verifier worker (branch `codex/misbah-verifier-step6`), make it call `POST /api/verifier/verdict`, then run the cheat-caught rehearsal (`MESH_TAMPER=true`).
3. [ ] UI: show the payment HashScan link, approval and HCS links on the job page; the fraud view with slash and refund.
4. [ ] Demo scenes: agent pays by x402 (HashScan), approval succeeds, denied approval creates no job, cheat caught.
5. [ ] Option A upgrade (real USDC in escrow) only if there is time.
