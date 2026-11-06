# Mesh

**Verifiable spare-compute marketplace.** Anyone can post a compute job; anyone with a spare laptop can run it. The chain proves what ran, slashes a provider who lies, and leaves a public receipt anyone can check.

Built from scratch at **ETHGlobal Mumbai 2026** by Misbah Ansari and Anurag.

> The chain does not exist to move the fee. It exists to prove what ran, punish a lie, and leave a receipt anyone in the world can check.

## How it works

1. A requester (a person, or a scripted agent) posts a job and pays through **x402 on Hedera**. The payment is locked in an escrow contract.
2. The job (for example a tiled render) is split into tiles and run by one or more providers inside Docker.
3. Each provider signs a claim over its tile hashes. The API commits a **Merkle root** of all tiles on chain, which opens a short **challenge window**.
4. A verifier recomputes a random, seeded sample of tiles. If a tile is wrong it submits a **fraud proof**: the provider is **slashed**, the requester is **refunded**. If nothing is wrong, the receipt becomes **final** and the provider is paid.
5. When a render is final, a vision model on **0G Private Computer** reviews the finished image. The job page shows the review with its 0G **request id** and a badge for how it was verified (TEE signature checked here, or only checked by the Router). Without 0G the render, payment and receipt still work, but there is no independent, traceable check of the finished image. See [docs/OG-STATUS.md](docs/OG-STATUS.md).
6. **World ID** keeps it to one provider profile per human. Every state change is also written to a **Hedera Consensus Service** audit log.

Design details: [MESH-IMPLEMENTATION-PLAN.md](MESH-IMPLEMENTATION-PLAN.md). Exact formats and interfaces: [docs/job-spec.md](docs/job-spec.md).

## Status

| Area | State |
| --- | --- |
| Plan, job spec, task split | Done |
| Smart contracts (stake, escrow, receipt) | Done: 67 Foundry tests passing, deployed to Hedera testnet |
| API: env validation, SQLite store, job state machine, jobs endpoints, provider registry (signed register + bearer token), matcher, task delivery, tile upload, signed claims with Merkle root, live SSE events | Done (92 tests, live run with two mock providers). On-chain `postClaim`, x402 payment check and World ID still to do |
| Chain loop: escrow lock, on-chain claim, challenge window, finalize and payout; receipt endpoint | Done: verified with real Docker workers on a local chain (created -> final in about 39 s, providers paid on chain) and the API wallet's transactions on Hedera testnet. x402 payment check, verifier gating and fraud path still to do |
| Requester UI: job form, providers panel, recent jobs, live job page (timeline, tile grid, image assembling from tiles, verification panel, activity log) | Done (verified in a browser with two providers). Wallet connect, x402 payment UI, World ID widget and the receipt explorer still to do |
| Provider worker (real, Docker), job images, on-chain provider registration | Done: verified end to end on Windows with two real Docker workers; tiny hashes match the macOS golden file. Verifier worker and 0G job still to do |
| World ID (IDKit provider gate, Agent Pass approvals above a spending threshold) | Done and tested with fixtures (denied paths included), plus the `/provider/verify` widget page. Needs the portal app and client for a live check |
| x402 payment on `POST /api/jobs` (Hedera), scripted agent with spending controls | Done and tested against a fake facilitator (replay, mismatch, denied and timeout paths). The first live settlement needs funded accounts |
| Verifier verdict endpoint, slash and refund bookkeeping | Done (signed by the verifier key). The real verifier worker is on Misbah's branch |
| HCS audit log | Done and tested with a fake submitter; needs `npm run hcs:create-topic` for a live run |
| 0G AI review of the finished render (request id, TEE verification, HCS record) | Built and tested against a fake 0G Router (27 tests). Not run against the real Router: needs an API key ([docs/OG-STATUS.md](docs/OG-STATUS.md)) |

## Deployed contracts (Hedera testnet, chain ID 296)

| Contract | Address |
| --- | --- |
| MockStable (test payment token) | [`0x9009A5B2070a97aAa81c6EB77A2507273Ba46Ee3`](https://hashscan.io/testnet/contract/0x9009A5B2070a97aAa81c6EB77A2507273Ba46Ee3) |
| MeshStake | [`0x522C2eef0EF65d1f9eA9dfe12b88ba24565245f8`](https://hashscan.io/testnet/contract/0x522C2eef0EF65d1f9eA9dfe12b88ba24565245f8) |
| MeshEscrow | [`0x16eFE46De1CdA06Be455607A63514319aE130010`](https://hashscan.io/testnet/contract/0x16eFE46De1CdA06Be455607A63514319aE130010) |
| MeshReceipt | [`0x0118652ea87a8616Cb51979F5F121FC598bf3e7E`](https://hashscan.io/testnet/contract/0x0118652ea87a8616Cb51979F5F121FC598bf3e7E) |

Challenge window 45 s, minimum stake 0.5 HBAR, slash 0.2 HBAR. Deployment notes and checks: [docs/DEPLOY.md](docs/DEPLOY.md).

**Settled-payment transaction ID (Hedera requirement):** `0.0.9185802@1793937163.341350400` on Hedera testnet, a 0.5 HBAR x402 payment from the agent account `0.0.11333706` to the treasury `0.0.11327733`, settled through the official x402 facilitator: [view on HashScan](https://hashscan.io/testnet/transaction/0.0.9185802-1793937163-341350400). The audit log is HCS topic [`0.0.11333951`](https://hashscan.io/testnet/topic/0.0.11333951).

**How a payment works.** The agent posts a job; the API answers `402` with a price in HBAR on `hedera:testnet`; the agent signs a Hedera transfer and retries; the x402 facilitator verifies and settles it on Hedera (it pays the network fee); only then is the job created. A signed payment works once. Above a spending threshold the agent must first get a human approval in World (Agent Pass) for that exact job. The settled payment goes to the treasury account; the escrow contract then mirrors it (an honest limit: the payment on HashScan is real, the escrow holds a test token that mirrors it).

## Quick start

Requires Node.js 20+ (developed on 24), npm, Docker Desktop (provider machine only) and Foundry (contracts).

```bash
npm install
cp .env.example .env         # then fill in your own values; .env is git-ignored
npm run dev                  # Next.js app on http://localhost:3000
```

Other commands:

```bash
npm run typecheck            # TypeScript check
npm run lint
npm test                     # vitest (no tests yet)
npm run build
npm run worker:mock          # mock provider: fake tiles, speaks the real protocol (dev only)
MOCK_REAL_RENDER=true npm run worker:mock   # same, but real Mandelbrot tiles (tiny preset only)
npm run worker:provider      # real provider worker (stub for now)
npm run worker:verifier      # verifier worker (stub for now)
npm run agent                # scripted agent requester (stub for now)
```

Contracts (Foundry; on Windows Git Bash add it to PATH first):

```bash
export PATH="$PATH:/c/Users/dubey/.foundry/bin"
cd contracts
forge build
forge test                   # 67 tests
```

Deploy to Hedera testnet: see [docs/DEPLOY.md](docs/DEPLOY.md). You need three ECDSA testnet accounts (deployer, api, verifier) funded with testnet HBAR from https://portal.hedera.com. MetaMask settings for Hedera Testnet: RPC `https://testnet.hashio.io/api`, chain ID `296`, symbol `HBAR`, explorer https://hashscan.io/testnet.

## Environment variables

`.env.example` lists everything. Public values (contract addresses, World app ID) are safe to commit; **private keys and API secrets live only in your local `.env`, which is git-ignored.** Never paste a key into chat, an issue, or a commit.

## Layout

```
src/app          Next.js pages and API route handlers
src/components   React components
src/lib          shared code: contract ABIs and addresses today; hashing, chain, HCS, x402, World to come
workers/         provider and verifier processes (run with tsx)
scripts/         scripted agent requester, deploy/stake helpers
contracts/       Foundry project: src/, test/, script/
jobs/            Docker job images (echo, render, matmul, infer)
docs/            job-spec, DEPLOY, and later QA, DEMO, 0G status, sponsor feedback
```

## Prize tracks

Hedera (x402), World (Agent Pass + IDKit, one pick), and 0G (AI review of the finished render, built; needs a live key). Requirements, technical facts, decisions and owners: [docs/TRACKS.md](docs/TRACKS.md). World integration debrief: [docs/FEEDBACK-world.md](docs/FEEDBACK-world.md).

## Team and task lists

- [docs/PROVIDER-PROTOCOL.md](docs/PROVIDER-PROTOCOL.md): how the provider worker talks to the API.
- [docs/LOCAL-REHEARSAL.md](docs/LOCAL-REHEARSAL.md): run the whole stack locally (anvil + Docker workers), free.
- [MISBAH.md](MISBAH.md): Docker, heavy compute, provider and verifier workers, job images, 0G job.
- [ANURAG.md](ANURAG.md): contracts, API, x402, World ID, HCS, frontend, scripted agent, docs.

## Honest limits (v1)

- Verification is **optimistic**: a claim is pending for a challenge window, and in v1 a Mesh verifier key finalizes disputes. The verifier cannot forge a result, only finalize or reject, and every decision is public.
- The API attributes tiles to providers (the owner address is inside each Merkle leaf). Provider signatures are published to the audit log, not checked on chain.
- The verifier key supplies the "expected" tile hash in a fraud proof.
- A provider can see the job inputs. Docker is not a hard security boundary.
- A 0G TEE signature proves the output came from the TEE, not which prompt produced it. The AI review is advisory: it never decides payment, slashing or finalization, and it can be wrong.
- World ID sandbox proofs use fake identities and are not production Sybil resistance.

More in sections 1.2 and 3.7 of the implementation plan.

## Third-party code

Next.js, React, Tailwind, viem, wagmi, TanStack Query, `@hashgraph/sdk`, `@worldcoin/idkit`, x402 packages, zod, tsx, vitest, Foundry and forge-std (vendored in `contracts/lib`). See `package.json`. No pre-existing project code was reused.

## AI use

AI assistance is documented in [AI.md](AI.md).
