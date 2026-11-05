# Mesh

**Verifiable spare-compute marketplace.** Anyone can post a compute job; anyone with a spare laptop can run it. The chain proves what ran, slashes a provider who lies, and leaves a public receipt anyone can check.

Built from scratch at **ETHGlobal Mumbai 2026** by Misbah Ansari and Anurag.

> The chain does not exist to move the fee. It exists to prove what ran, punish a lie, and leave a receipt anyone in the world can check.

## How it works

1. A requester (a person, or a scripted agent) posts a job and pays through **x402 on Hedera**. The payment is locked in an escrow contract.
2. The job (for example a tiled render) is split into tiles and run by one or more providers inside Docker.
3. Each provider signs a claim over its tile hashes. The API commits a **Merkle root** of all tiles on chain, which opens a short **challenge window**.
4. A verifier recomputes a random, seeded sample of tiles. If a tile is wrong it submits a **fraud proof**: the provider is **slashed**, the requester is **refunded**. If nothing is wrong, the receipt becomes **final** and the provider is paid.
5. AI-inference jobs can't be re-run, so they carry a **0G Private Computer TEE signature** that the contract verifies on chain.
6. **World ID** keeps it to one provider profile per human. Every state change is also written to a **Hedera Consensus Service** audit log.

Design details: [MESH-IMPLEMENTATION-PLAN.md](MESH-IMPLEMENTATION-PLAN.md). Exact formats and interfaces: [docs/job-spec.md](docs/job-spec.md).

## Prize tracks

Hedera (x402), 0G (Private Computer), World (IDKit or Agent Pass).

## Status

| Area | State |
| --- | --- |
| Plan, job spec, task split | Done |
| Smart contracts (stake, escrow, receipt) | Done: 67 Foundry tests passing, deployed to Hedera testnet |
| API: env validation, SQLite store, job state machine, jobs endpoints, provider registry (signed register + bearer token), matcher, task delivery, tile upload, signed claims with Merkle root, live SSE events | Done (92 tests, live run with two mock providers). On-chain `postClaim`, x402 payment check and World ID still to do |
| x402 payment + escrow link | Not started |
| Requester UI, live tile grid, receipt explorer | Not started |
| Provider worker, verifier worker, job images | In progress (Misbah): deterministic render and echo job images (Go/Docker) and SHA-256/Merkle helpers are merged to `main`; the provider and verifier workers are still stubs |
| World ID, HCS audit log, scripted agent | Not started |
| 0G inference job | Not started |

## Deployed contracts (Hedera testnet, chain ID 296)

| Contract | Address |
| --- | --- |
| MockStable (test payment token) | [`0x9009A5B2070a97aAa81c6EB77A2507273Ba46Ee3`](https://hashscan.io/testnet/contract/0x9009A5B2070a97aAa81c6EB77A2507273Ba46Ee3) |
| MeshStake | [`0x522C2eef0EF65d1f9eA9dfe12b88ba24565245f8`](https://hashscan.io/testnet/contract/0x522C2eef0EF65d1f9eA9dfe12b88ba24565245f8) |
| MeshEscrow | [`0x16eFE46De1CdA06Be455607A63514319aE130010`](https://hashscan.io/testnet/contract/0x16eFE46De1CdA06Be455607A63514319aE130010) |
| MeshReceipt | [`0x0118652ea87a8616Cb51979F5F121FC598bf3e7E`](https://hashscan.io/testnet/contract/0x0118652ea87a8616Cb51979F5F121FC598bf3e7E) |

Challenge window 45 s, minimum stake 0.5 HBAR, slash 0.2 HBAR. Deployment notes and checks: [docs/DEPLOY.md](docs/DEPLOY.md).

**Settled-payment transaction ID (Hedera requirement):** not yet, added once the x402 flow works.

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

## Team and task lists

- [docs/PROVIDER-PROTOCOL.md](docs/PROVIDER-PROTOCOL.md): how the provider worker talks to the API.
- [MISBAH.md](MISBAH.md): Docker, heavy compute, provider and verifier workers, job images, 0G job.
- [ANURAG.md](ANURAG.md): contracts, API, x402, World ID, HCS, frontend, scripted agent, docs.

## Honest limits (v1)

- Verification is **optimistic**: a claim is pending for a challenge window, and in v1 a Mesh verifier key finalizes disputes. The verifier cannot forge a result, only finalize or reject, and every decision is public.
- The API attributes tiles to providers (the owner address is inside each Merkle leaf). Provider signatures are published to the audit log, not checked on chain.
- The verifier key supplies the "expected" tile hash in a fraud proof.
- A provider can see the job inputs. Docker is not a hard security boundary.
- A 0G TEE signature proves the output came from the TEE, not which prompt produced it.
- World ID sandbox proofs use fake identities and are not production Sybil resistance.

More in sections 1.2 and 3.7 of the implementation plan.

## Third-party code

Next.js, React, Tailwind, viem, wagmi, TanStack Query, `@hashgraph/sdk`, `@worldcoin/idkit`, x402 packages, zod, tsx, vitest, Foundry and forge-std (vendored in `contracts/lib`). See `package.json`. No pre-existing project code was reused.

## AI use

AI assistance is documented in [AI.md](AI.md).
