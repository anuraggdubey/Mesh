# Provider protocol (for the real provider worker)

How a provider machine talks to the API. The reference implementation is `src/lib/provider-client.ts`; the real
worker (`workers/provider`) should import `ProviderClient` instead of re-implementing HTTP and signing. The mock
worker (`workers/mock-provider`, `npm run worker:mock`) is a complete working example. Full formats: `docs/job-spec.md`.

## Flow

1. **Register.** `POST /api/providers/register` with `{address, signature, nonce, cores, memoryGb, os, arch, agentVersion}`.
   - `nonce` = `"<unix-ms>-<random 8-64 alphanumerics>"`, at most 5 minutes old, usable once.
   - `signature` = `personal_sign` over `mesh-register:<nonce>` by the provider wallet.
   - Returns `{providerId, token}`. The token is shown once; send it as `Authorization: Bearer <token>`. Re-registering rotates it.
   - The World ID proof is accepted but not verified yet (a later step).
2. **Heartbeat** every 5 s: `POST /api/providers/heartbeat {load?, currentTask?}`. A provider unseen for 20 s is offline and gets no new work.
3. **Poll for work:** `GET /api/providers/tasks?wait=20` (long-poll, max 25 s). A task is delivered once.
   The first delivery moves the job from `assigned` to `running`.
4. **Get the input:** `GET /api/jobs/:id/input` returns the exact `job.json` for this provider's tiles. Verify the image digest
   (`task.imageDigest`) and hash before running.
5. **Compute each tile** and upload it right away so the UI fills live:
   `PUT /api/jobs/:id/tiles/:index` with the raw bytes and header `X-Tile-Hash: <sha256 hex>`.
   - The server recomputes the hash, checks the size (`tileW*tileH*2`), that you own the tile, and rejects a conflicting re-upload.
6. **Claim:** once all your tiles are uploaded, `POST /api/jobs/:id/claim` with `{provider, tilesDigest, signature, tiles:[{index,tileHash}]}`.
   - `tilesDigest = sha256(concat over your tiles ascending of uint16_be(index) || tileHash)`.
   - `signature` = EIP-712 `TileClaim(jobId, imageDigest, inputHash, provider, tilesDigest)`, domain
     `{name:"Mesh", version:"1", chainId: HEDERA_CHAIN_ID, verifyingContract: RECEIPT_ADDRESS}` (see `tileClaimTypedData`).
   - When every provider on the job has claimed, the API builds the Merkle root and the job becomes `pending`.
7. **On failure:** `POST /api/jobs/:id/failure {provider, reason, logTail?}` where `reason` is one of
   `timeout | crash | hash_mismatch | killed | attestation_missing`. In v1 this fails the whole job.

## Errors you can see

`401 unauthorized` (bad token), `403 no_task | not_tile_owner | provider_mismatch`, `400 bad_tile_size | tile_hash_mismatch |
tiles_mismatch | tiles_digest_mismatch | bad_signature`, `409 job_not_running | tile_conflict | tile_missing | already_claimed`.
Each has a `message`. `ProviderClient` throws `ApiRequestError` with `status` and `body`.

## Not built yet

- Posting the claim on chain (`MeshReceipt.postClaim`): `claimTx` is `null` until the chain-loop step.
- Verifying the World ID proof and calling `MeshStake.registerProvider`.
- Reassigning tiles when a provider drops; v1 fails the job instead.
