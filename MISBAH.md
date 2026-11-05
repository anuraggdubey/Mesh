# Misbah — Compute, Docker, Verification Runtime

**You own everything that burns CPU or needs Docker:** the provider agent, the job images, the render/matmul/inference engines, the verifier that recomputes tiles, and determinism across operating systems. Your laptop is the **main provider machine** in the demo.

Read `MESH-IMPLEMENTATION-PLAN.md` first (especially §3 verification, §4 job types, §7 execution). This file is your checklist. Anurag's is `ANURAG.md`.

**Rule:** the heavy parts live on your machine. Anurag's laptop cannot run heavy jobs, so nothing on his side may depend on running Docker or rendering.

---

## 0. Your outputs (what Anurag depends on)

| Deliverable | Anurag needs it for | Needed by |
| --- | --- | --- |
| Tile format + job param spec (`packages/shared/job-spec.md`) | API tile splitting, UI | Thu 21:30 |
| Merkle + hash helpers in `packages/shared` | API, receipt explorer | Thu 23:00 |
| Provider agent talking to the agreed API | End-to-end flow | Thu 01:00 |
| `jobs/render` image + digest | Job creation | Fri morning |
| Claim signing format (EIP-712 or personal_sign, documented) | Contract `postClaim` | Thu 23:00 |
| Verifier worker + fraud proof payload format | Contract `postFraud`, UI | Fri afternoon |
| 0G signature format | Contract `postAttested` | Fri afternoon |

Agree the first three with Anurag at 21:00–21:30 Thursday before splitting.

---

## 1. System setup (Thursday, first 30 min)

- [ ] Docker Desktop installed and **running**; test `docker run hello-world`.
- [ ] `docker run --platform linux/amd64 hello-world` works (matters on Apple Silicon).
- [ ] Node.js 20+, Git, pnpm/npm, Foundry optional (only to read ABIs).
- [ ] Hedera testnet wallet created and funded; second wallet for the verifier key.
- [ ] Machine tuned for demo: power plugged in, sleep disabled, thermal headroom, Docker resource limits set (CPU/RAM given to Docker Desktop).
- [ ] Note your CPU core count and RAM; this decides tile size and iteration depth.
- [ ] Network: same Wi‑Fi as Anurag; test the phone-hotspot fallback; know your LAN IP.
- [ ] Clone repo, create `.env` from `.env.example` (never commit keys).

---

## 2. Shared determinism spec (do first — everything depends on it)

- [ ] Write `packages/shared/job-spec.md`: tile grid (e.g. 8×8), pixel/iteration parameters, fixed-point format (e.g. Q32.32 in 64-bit ints), seed handling, tile index → file name (`/output/tile-<i>`), output byte layout.
- [ ] Integer-only math. No `float`/`double` anywhere in anything hashed.
- [ ] One platform: `linux/amd64`. Document it.
- [ ] Hash rules: SHA-256 lowercase hex over raw bytes; Merkle tree = binary, leaves = tile hashes ordered by index, odd node duplicated (or promoted — pick and document).
- [ ] Implement `sha256`, `merkleRoot(leaves)`, `merkleProof(leaves, i)`, `verifyProof(...)` in `packages/shared` with unit tests (known vectors).

---

## 3. Job images (`jobs/`)

### 3.1 `jobs/echo` (sanity only)
- [ ] Dockerfile: read `/input`, write same bytes to `/output/tile-0`, exit 0.

### 3.2 `jobs/render` — primary demo job (must ship)
- [ ] Fixed-point Mandelbrot (or integer ray-marcher) in a language with deterministic integer math (Rust/Go/C/Node BigInt — pick what you can write fastest; Rust or Go preferred for speed).
- [ ] Inputs: tile index, grid size, viewport, max iterations, seed — from `/input` (JSON).
- [ ] Output: raw tile bytes at `/output/tile-<i>`; exit 0 on success.
- [ ] Iteration depth tuned so one tile takes a few seconds on your CPU (the demo must look heavy: whole job ≈ 20–40 s).
- [ ] Multi-core: use all cores inside the container (threads or goroutines), but respect a CPU limit flag.
- [ ] `docker build --platform linux/amd64`, push to a registry (Docker Hub / GHCR) **or** load locally; record the **image digest**.
- [ ] Verify bit-identical output across two runs and across Docker restarts.
- [ ] Verify bit-identical output with Anurag's machine on a **tiny** tile (see §9).

### 3.3 `jobs/matmul` — stretch
- [ ] Integer (mod prime) matrix multiply, size big enough to take seconds.
- [ ] Output `C` plus nothing else; Freivalds check lives in the verifier (§6.4).

### 3.4 `jobs/infer` — 0G job (must ship if 0G is a pick)
- [ ] Small script that calls 0G Private Computer (OpenAI-compatible endpoint) with a fixed prompt/input.
- [ ] Capture: response text, **request ID**, TEE signature/attestation payload, signer address.
- [ ] Write the response + signature to `/output` (or return them via the agent, since the call is a network call: this job type is the one exception to `--network none`; use a separate allowlist flag).
- [ ] Document exact signature format and what it covers into `docs/OG-STATUS.md` (even if blocked: record what failed).

---

## 4. Provider agent (`apps/agent`)

Runs on your machine (and, in a limited mode, on Anurag's).

- [ ] CLI: `mesh-agent start --api <url> --key <wallet key> [--tamper]`.
- [ ] Register with the API (wallet address, World ID–verified provider token from Anurag's flow, capabilities, CPU cores).
- [ ] Heartbeat every few seconds; reconnect on network drop.
- [ ] Poll/receive assigned tiles; accept only if staked (check via API/contract).
- [ ] **Pull image by digest**; refuse and fail the job if the digest does not match.
- [ ] Download input, **verify `inputHash`**; refuse on mismatch.
- [ ] Run: `docker run --rm --network none --platform linux/amd64 --cpus <n> --memory <m> --pids-limit <p> --read-only` with a wall-clock timeout and kill on timeout.
- [ ] Collect output tiles; compute per-tile SHA-256.
- [ ] Build the **claim**: `(jobId, imageHash, inputHash, merkleRoot)`; **sign with the provider key**; POST to `/jobs/:id/claim` along with tile bytes (or upload refs).
- [ ] Failure reasons enum: `timeout | crash | hash_mismatch | killed | attestation_missing`; send truncated logs (last N lines).
- [ ] Local log stream + live terminal output (large font; this is what judges see on PC B).
- [ ] Never decides success; only reports.
- [ ] **`--tamper` dev flag**: after computing, corrupt a configurable % of tiles (blur/skip/interpolate) **before hashing**, so the claim stays internally consistent but the pixels are wrong. Default OFF. Log loudly when on.
- [ ] Graceful shutdown; clean up leftover containers.
- [ ] Fallback runner (Node/WASM) if Docker is unusable on a machine.

---

## 5. Provider stake + registration (light chain interaction)

- [ ] Script to call `MeshStake.stake()` from the provider wallet (ABI from Anurag's contracts).
- [ ] Agent checks it is staked before accepting work.
- [ ] Show stake balance in the agent terminal.
- [ ] Test slash path reduces displayed stake.

---

## 6. Verifier worker (`apps/verifier`) — heavy, runs on your machine

Recomputation is real CPU work, so it runs on your laptop.

- [ ] Subscribe to / poll the API (or HCS topic) for `pending` claims.
- [ ] Derive the **sample seed after the claim is posted** (e.g. hash of claim tx hash/HCS sequence number); never visible to the provider beforehand.
- [ ] Choose `k` random tile indices from the seed (documented algorithm, reproducible by anyone).
- [ ] For each sampled tile: run the **same image digest** in Docker with the stored input; compute the tile hash; compare to the claimed tile hash and to the Merkle leaf.
- [ ] All match → submit `finalize(jobId)` after the challenge window.
- [ ] Any mismatch → build the **fraud payload**: `{jobId, tileIndex, expectedHash, claimedHash, merkleProof}`; submit `postFraud` on chain; notify API.
- [ ] For `matmul`: implement **Freivalds** (random vector, `A(Br) == Cr`, ≥20 rounds, mod-prime) as an alternative check.
- [ ] For `infer`: verify the 0G signature off chain before the API calls `postAttested`.
- [ ] Keep the verifier key in a separate wallet; log every verdict (also published to HCS by Anurag's API).
- [ ] Measure and record: detection rate vs. `f` and `k`; verify it matches `1 − (1−f)^k` (§3.4 of the plan) over ≥20 runs for `docs/QA.md`.

---

## 7. 0G integration (`infer` end to end)

- [ ] Get access/keys (0G Private Computer, `pc.0g.ai`); store in `.env`.
- [ ] One working request with request ID and TEE-signed response.
- [ ] Confirm the **signer address** and the exact message the signature covers.
- [ ] Hand Anurag: signer address, digest format, signature encoding for `postAttested`.
- [ ] Provide a tampered example (flip a byte) to prove the contract rejects it.
- [ ] If blocked after ~2 h of effort: write `docs/OG-STATUS.md` (what blocked, what we tried); do not fake anything; `render` ships regardless.

---

## 8. Performance and demo reliability

- [ ] Tune tile count × iterations so the full render takes ~20–40 s on your machine at full CPU.
- [ ] Add a **small preset** (fast, ~5 s) used for repeated rehearsals and the cheat run.
- [ ] Confirm the whole demo works on battery-saver off, plugged in, Docker given enough cores.
- [ ] Cooling and background apps: close browsers/IDE during the live demo.
- [ ] Pre-pull images and warm the Docker cache before the final session.
- [ ] Stress test: run 5 jobs back to back; no leaked containers or memory growth.

---

## 9. Cross-OS determinism (with Anurag's machine)

His laptop can only run **tiny** work, but the hash must still match.

- [ ] Define a **tiny determinism test tile** (e.g. 32×32, few iterations) that runs in <2 s on a weak machine.
- [ ] Both machines run it; `tileHash` must be identical (Mac ↔ Windows).
- [ ] Record the result in `docs/QA.md` with both OS names.
- [ ] If Anurag cannot run Docker at all: he runs the Node/WASM fallback on the tiny tile instead.

---

## 10. Second provider (the "two laptops" story)

Because Anurag's laptop is light, you need a second provider that is not him:

- [ ] Option A: run **two agent instances** on your machine (different wallets, different Docker CPU limits) — simplest; say "two providers" truthfully, and note that it is one machine.
- [ ] Option B: a friend's laptop or a cheap cloud VM running the agent (best for the demo).
- [ ] Decide by Friday noon. Be honest on stage if both providers share hardware.
- [ ] Anurag's laptop = requester + UI + (optional) tiny determinism check.

---

## 11. Tests you own (`docs/QA.md`)

- [ ] Unit: hash, Merkle, tile index mapping, sample selection reproducible from seed.
- [ ] Smoke: `echo` end to end, no chain.
- [ ] Image/input digest mismatch → agent refuses.
- [ ] Render determinism: same output twice, across restarts, across OS tiny tile.
- [ ] Cheat detection (20 runs, record rate).
- [ ] Timeout and kill: container killed, tiles reassigned.
- [ ] `--network none` actually blocks outbound traffic (prove with a test image).
- [ ] Resource limits hold (a runaway job does not freeze your machine).
- [ ] Unplug mid-job → API timeout → refund (with Anurag).

---

## 12. Demo ownership (Saturday)

- [ ] You drive the **provider terminal** and the verifier view (large font).
- [ ] Rehearse the cheat run until it takes <60 s.
- [ ] Health check before leaving for the floor: Docker up, images pulled, wallets funded, hotspot tested.
- [ ] Backup recording of provider terminal during happy and cheat runs.

---

## 13. Timeline

| When | You |
| --- | --- |
| Thu 21:00–21:30 | With Anurag: interfaces, tile spec, claim format |
| Thu 21:30–01:00 | Setup, Merkle/hash helpers, `echo`, agent skeleton, smoke test |
| Fri morning | `render` image + deterministic output; agent signs claims; cross-OS tiny test |
| Fri afternoon | Verifier + cheat flag + fraud payload; 0G spike; second provider decided |
| Fri evening | Performance tuning, detection-rate test, QA, rehearsal, recording |
| Sat before 09:00 | Health check, submit with Anurag |

## 14. Definition of done (your part)

1. `render` job runs across two providers with identical results on both OS tiny-test.
2. Agent refuses wrong image/input; `--tamper` produces a consistent-but-wrong claim.
3. Verifier catches tampering with the expected probability and emits a valid fraud payload.
4. `infer` returns request ID + TEE signature accepted by the contract (or `OG-STATUS.md` explains why not).
5. Whole demo runs repeatably, under 60 s per scene, on your machine.
