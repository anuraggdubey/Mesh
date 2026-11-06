# Mesh

**Verifiable spare-compute marketplace.** Anyone can post a compute job; anyone with a spare laptop can run it. The chain proves what ran, slashes a provider who lies, and leaves a public receipt anyone can check.

Built from scratch at **ETHGlobal Mumbai 2026** by Misbah Ansari and Anurag.

> The chain does not exist to move the fee. It exists to prove what ran, punish a lie, and leave a receipt anyone in the world can check.

**Partner tracks:** Hedera (x402 payments, HCS audit log), World (IDKit proof of human, human approval of agent spends), 0G (traceable AI review of every finished render).

## How it works

1. A requester (a person, or a scripted agent) posts a job and pays through **x402 on Hedera**. The settled payment goes to a treasury account and the escrow contract mirrors it.
2. The job (a tiled render) is split into 64 tiles and run by staked providers inside Docker, offline.
3. Each provider signs a claim over its tile hashes. The API commits a **Merkle root** of all tiles on chain, which opens a 45 s **challenge window**.
4. A verifier recomputes a random, seeded sample of tiles. A wrong tile produces a **fraud proof**: the provider is **slashed** and the requester **refunded**. Otherwise the receipt becomes **final** and providers are paid.
5. When a render is final, a vision model on **0G Private Computer** reviews the image. The job page shows the review with its 0G request ID and how it was verified. See [docs/OG-STATUS.md](docs/OG-STATUS.md).
6. **World ID** keeps it to one provider profile per human, and a human approves large agent spends. Every state change is also written to a **Hedera Consensus Service** audit log.

The site has a landing page (`/`), a dashboard (`/app`) and full documentation (`/docs`). Exact formats and interfaces are in [docs/job-spec.md](docs/job-spec.md).

## Status

| Area | State |
| --- | --- |
| Smart contracts (stake, escrow, receipt) | Done: 67 Foundry tests, deployed to Hedera testnet |
| API: store, state machine, provider protocol, claims and Merkle root, chain loop (lock, claim, finalize, refund), receipts, live SSE events | Done and tested; verified with real Docker workers on a local chain |
| x402 payment on `POST /api/jobs` and the scripted agent with spending controls | Done. **Live on Hedera testnet** (see the transaction below) |
| Verifier verdict endpoint, slash and refund bookkeeping | Done. The verifier worker is merged; the live cheat-detection rehearsal is still to run |
| HCS audit log | Done. Live on topic [`0.0.11333951`](https://hashscan.io/testnet/topic/0.0.11333951) |
| World ID: provider proof of human (IDKit), human approval of agent spends | IDKit scan verified live. Approval uses the World IdP when a client exists, otherwise an IDKit proof per approval (the auth.world.org portal was not available to us). See [docs/FEEDBACK-world.md](docs/FEEDBACK-world.md) |
| 0G AI review | Built and tested against a fake Router. The live call needs account credits ([docs/OG-STATUS.md](docs/OG-STATUS.md)) |
| Website: landing page, dashboard, docs, job page | Done |
| Permanent hosting | Local server behind a temporary tunnel; see [docs/HOSTING.md](docs/HOSTING.md) |

## Deployed contracts (Hedera testnet, chain ID 296)

| Contract | Address |
| --- | --- |
| MockStable (test payment token) | [`0x9009A5B2070a97aAa81c6EB77A2507273Ba46Ee3`](https://hashscan.io/testnet/contract/0x9009A5B2070a97aAa81c6EB77A2507273Ba46Ee3) |
| MeshStake | [`0x522C2eef0EF65d1f9eA9dfe12b88ba24565245f8`](https://hashscan.io/testnet/contract/0x522C2eef0EF65d1f9eA9dfe12b88ba24565245f8) |
| MeshEscrow | [`0x16eFE46De1CdA06Be455607A63514319aE130010`](https://hashscan.io/testnet/contract/0x16eFE46De1CdA06Be455607A63514319aE130010) |
| MeshReceipt | [`0x0118652ea87a8616Cb51979F5F121FC598bf3e7E`](https://hashscan.io/testnet/contract/0x0118652ea87a8616Cb51979F5F121FC598bf3e7E) |

Challenge window 45 s, minimum stake 0.5 HBAR, slash 0.2 HBAR. Deployment notes: [docs/DEPLOY.md](docs/DEPLOY.md).

## Settled x402 payments (Hedera requirement)

| Transaction ID | Amount | HashScan |
| --- | --- | --- |
| `0.0.9185802@1793937163.341350400` | 0.5 HBAR | [view](https://hashscan.io/testnet/transaction/0.0.9185802-1793937163-341350400) |
| `0.0.9185802@1793941137.019516163` | 0.1 HBAR | [view](https://hashscan.io/testnet/transaction/0.0.9185802-1793941137-019516163) |

Both are payments from the agent account `0.0.11333706` to the treasury `0.0.11327733`, settled through the official x402 facilitator. The audit log is HCS topic [`0.0.11333951`](https://hashscan.io/testnet/topic/0.0.11333951).

**How a payment works.** The agent posts a job; the API answers `402` with a price in HBAR on `hedera:testnet`; the agent signs a Hedera transfer and retries; the facilitator verifies and settles it on Hedera (it pays the network fee); only then is the job created. A signed payment works once. Above a spending threshold the agent must first get a human approval in World for that exact job. The payment on HashScan is real; the escrow contract holds a test token that mirrors it. More in [/docs/payments](src/app/docs/payments/page.tsx) or the running site.

## Quick start

Requires Node.js 24, npm, Docker Desktop (provider machine only) and Foundry (contracts only).

```bash
npm install
cp .env.example .env         # fill in your own values; .env is git-ignored
npm run dev                  # http://localhost:3000
```

| Command | What it does |
| --- | --- |
| `npm run build` / `npm start` | Production build and server. Use this, not `dev`, to review the site. |
| `npm test` | Vitest suite |
| `npm run typecheck` / `npm run lint` | Static checks |
| `npm run agent -- small` | Scripted agent: pays over x402 and follows one job |
| `npm run agent:activate` | One-time: gives a new agent wallet its public key on Hedera |
| `npm run hcs:create-topic` | One-time: create the HCS audit topic |
| `npm run worker:provider` | Provider worker (Docker) |
| `npm run worker:verifier` | Verifier worker |
| `npm run worker:mock` | Mock provider for development |
| `npm run chain:local` | Local anvil chain with contracts and staked providers |

Contracts (Foundry; on Windows Git Bash add it to PATH first):

```bash
cd contracts
forge build
forge test                   # 67 tests
```

Three ECDSA testnet accounts (deployer, api, verifier) funded with HBAR from https://portal.hedera.com are needed to deploy. MetaMask settings for Hedera Testnet: RPC `https://testnet.hashio.io/api`, chain ID `296`, symbol `HBAR`, explorer https://hashscan.io/testnet.

## Environment variables

[.env.example](.env.example) lists everything. Public values (contract addresses, World app ID) are safe to commit; **private keys and API secrets live only in your local `.env`, which is git-ignored.** Never paste a key into chat, an issue, or a commit.

## Project layout

```
src/
  app/            Next.js pages (landing, /app, /docs, /jobs, /provider, /approve) and API routes (src/app/api)
  components/     React components (site/ for nav, footer and hero; docs/ for the docs shell)
  lib/            core logic: jobs, claims, chain loop, x402, agent, HCS, World, 0G, verifier, env, db
workers/          provider, verifier and mock-provider processes (run with tsx)
scripts/          agent, HCS topic, staking, local chain and smoke-test helpers
contracts/        Foundry project: src/, test/, script/
jobs/             Docker job images (echo, render, matmul, infer)
docs/             specs, deployment, QA, track notes and feedback (index in docs/README.md)
```

## Documentation

- [docs/README.md](docs/README.md): index of everything below.
- [docs/job-spec.md](docs/job-spec.md): the full API, contract and data specification.
- [docs/TRACKS.md](docs/TRACKS.md): what each prize track requires, our decisions, and what is built.
- [docs/PROVIDER-PROTOCOL.md](docs/PROVIDER-PROTOCOL.md): how the provider worker talks to the API.
- [docs/LOCAL-REHEARSAL.md](docs/LOCAL-REHEARSAL.md): run the whole stack locally (anvil + Docker workers), free.
- [docs/HOSTING.md](docs/HOSTING.md): put the API on the internet.
- [docs/QA.md](docs/QA.md): determinism, timing and detection-rate results.
- [docs/AI.md](docs/AI.md): where AI assistance was used.

## Honest limits (v1)

- Verification is **optimistic**: a claim is pending for a challenge window, and a single Mesh verifier key decides fraud claims. The verifier cannot forge a result, only finalize or reject, and every decision is public and reproducible.
- Sampling is probabilistic: a provider that corrupts one tile of 64 is usually missed; detection rises fast with more bad tiles (see [docs/QA.md](docs/QA.md)).
- The API attributes tiles to providers (the owner address is inside each Merkle leaf). Provider signatures are published to the audit log, not checked on chain.
- The escrow contract mirrors the x402 payment with a test token. Real token escrow would need a contract redeploy.
- A provider can see the job inputs. Docker is not a hard security boundary.
- A 0G TEE signature proves the output came from the TEE, not which prompt produced it. The AI review is advisory: it never decides payment, slashing or finalization, and it can be wrong.
- World ID staging proofs use test identities and are not production Sybil resistance. The approval of agent spends may use an IDKit proof instead of the World IdP client.
- Test network, test funds, no outside audit. Do not use real money.

## Third-party code

Next.js, React, Tailwind, viem, TanStack Query, `@hiero-ledger/sdk`, `@worldcoin/idkit`, `@x402/core`, `@x402/hedera`, jose, zod, tsx, vitest, Foundry and forge-std (vendored in `contracts/lib`). See `package.json`. No pre-existing project code was reused.

## AI use

AI assistance is documented in [docs/AI.md](docs/AI.md).
