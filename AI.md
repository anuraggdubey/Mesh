# AI Assistance Disclosure

ETHGlobal requires documenting where AI tools helped. Keep this file current: add a line whenever an AI assistant writes or substantially edits a file or feature.

| Date | File / feature | Tool | What AI did | What we changed |
| --- | --- | --- | --- | --- |
| 2026-11-05 | MESH-IMPLEMENTATION-PLAN.md, MISBAH.md, ANURAG.md | Claude Code | Researched prizes/rules/past winners; drafted and rewrote the plan and task lists | Team reviewed and directed scope |
| 2026-11-05 | Project scaffold, .gitignore, .env.example, README | Claude Code | Next.js scaffold, dependency selection, folder layout | Team reviewed |
| 2026-11-05 | docs/job-spec.md | Claude Code | Drafted the shared job/API/contract spec | Team reviews and owns it |
| 2026-11-05 | contracts/ (MeshStake, MeshEscrow, MeshReceipt, MockStable, MerkleSha256, tests, Deploy script), docs/DEPLOY.md | Claude Code | Wrote the Solidity contracts, 67 Foundry tests, deploy script and deploy guide | Team to review before testnet deploy |
| 2026-11-06 | src/lib (constants, env, types, hash, merkle, db, jobs, state-machine), src/app/api (health, jobs), tests | Claude Code | Wrote the API foundation and its 51 tests | Team to review |
| 2026-11-06 | src/lib (providers, matcher, claims, claim, provider-client, provider-auth), src/app/api (providers, tiles, claim, failure, events, input), workers/mock-provider, docs/PROVIDER-PROTOCOL.md, tests | Claude Code | Wrote the provider protocol, matcher, tile/claim validation, SSE stream, mock provider and 92 tests | Team to review |
| 2026-11-06 | src/components, src/app (page, layout, jobs/[id]), src/lib/ui, src/lib/render-reference.ts and tests | Claude Code | Wrote the requester UI, live tile grid, state reducer, TS reference renderer and 22 tests | Team to review |
| 2026-11-06 | src/lib/chain.ts, local-chain.ts, chain.test.ts, providers register route, scripts/local-chain.ts, scripts/with-env.ts, docs/LOCAL-REHEARSAL.md | Claude Code | Wrote on-chain provider registration, a local anvil rehearsal stack, and ran the real Docker workers end to end | Team to review |
| 2026-11-06 | src/lib/settler.ts, assign.ts, chain.ts (escrow/claim/finalize), instrumentation.ts, receipts route, UI payout display, settler tests, scripts/testnet-smoke.ts | Claude Code | Wrote the chain loop (lock, post claim, finalize, refund), eligibility-aware assignment and tests; ran it end to end | Team to review |

Spec files used in AI-assisted workflows live in this repo (the plan and the two task files).
