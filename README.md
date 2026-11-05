# Mesh

Verifiable spare-compute marketplace for ETHGlobal Mumbai 2026. Jobs run on other people's machines; the chain proves what ran, slashes a lie, and leaves a public receipt.

Full design: [MESH-IMPLEMENTATION-PLAN.md](MESH-IMPLEMENTATION-PLAN.md). Task lists: [MISBAH.md](MISBAH.md) (Docker, heavy compute, verifier) and [ANURAG.md](ANURAG.md) (contracts, API, frontend, payments).

## Setup

Requires Node.js 20+, Docker Desktop (provider machine only), and Foundry (contracts).

```bash
npm install
cp .env.example .env.local   # fill in values; never commit this file
npm run dev                  # Next.js app on http://localhost:3000
```

Workers (run on the provider machine):

```bash
npm run worker:provider
npm run worker:verifier
```

Scripted agent requester:

```bash
npm run agent
```

## Layout

```
src/app          Next.js pages and API route handlers
src/components   React components
src/lib          shared server/client code (hashing, Merkle, chain, HCS, x402, World)
workers/         provider and verifier processes (tsx)
scripts/         scripted agent requester, deploy/stake helpers
contracts/       Foundry project
jobs/            Docker job images (echo, render, matmul, infer)
docs/            QA, demo script, 0G status, sponsor feedback
```

## Honest limits

See section 1.2 and 3.7 of the implementation plan. Verification is optimistic with a challenge window; v1 uses a Mesh verifier key to finalize disputes.

## Third-party code

Next.js, React, Tailwind, viem, wagmi, @hashgraph/sdk, @worldcoin/idkit, x402 packages, zod. See `package.json`.

## AI use

See [AI.md](AI.md).
