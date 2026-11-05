import { createHash } from "node:crypto";
import { recoverTypedDataAddress, getAddress } from "viem";
import type { Hex } from "viem";
import { z } from "zod";
import { getDb, transaction } from "./db";
import { appendEvent, getJob, transitionJob, updateJob } from "./jobs";
import { markTaskDone, markTasksFailed, tilesForProvider } from "./matcher";
import { computeTilesDigest, imageDigestToBytes32, tileClaimTypedData, with0x } from "./claim";
import { merkleLeaf, merkleRoot } from "./hash";
import { CHALLENGE_WINDOW_SECONDS, MAX_TILE_UPLOAD_BYTES } from "./constants";
import { getEnv } from "./env";
import type { Job } from "./types";

const now = () => Math.floor(Date.now() / 1000);

export class ProtocolError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ProtocolError";
  }
}

/** Expected byte length of one render tile: tileW * tileH * 2 (uint16 per pixel). */
export function expectedTileBytes(job: Job): number {
  const p = job.params as { width: number; height: number; gridCols: number; gridRows: number };
  return (p.width / p.gridCols) * (p.height / p.gridRows) * 2;
}

// ───────────────────────── tile upload ─────────────────────────

/**
 * Store one tile uploaded by its owner. The server recomputes SHA-256 and rejects a mismatch with the
 * `X-Tile-Hash` header, a wrong size, a tile the provider does not own, or a conflicting re-upload.
 * Idempotent for the same bytes.
 */
export function storeTile(jobId: string, providerAddress: string, index: number, bytes: Buffer, headerHash: string): { done: number; total: number } {
  const job = getJob(jobId);
  if (!job) throw new ProtocolError(404, "job_not_found", "job not found");
  if (job.status !== "running") throw new ProtocolError(409, "job_not_running", `job is ${job.status}`);
  if (!Number.isInteger(index) || index < 0 || index >= job.tileCount) throw new ProtocolError(400, "bad_tile_index", "tile index out of range");

  const tile = job.tiles[index];
  if (!tile.owner || tile.owner.toLowerCase() !== providerAddress.toLowerCase()) {
    throw new ProtocolError(403, "not_tile_owner", "this tile is not assigned to you");
  }
  if (bytes.length === 0 || bytes.length > MAX_TILE_UPLOAD_BYTES) throw new ProtocolError(413, "bad_tile_size", "tile is empty or too large");
  if (bytes.length !== expectedTileBytes(job)) {
    throw new ProtocolError(400, "bad_tile_size", `expected ${expectedTileBytes(job)} bytes, got ${bytes.length}`);
  }
  if (!/^[0-9a-fA-F]{64}$/.test(headerHash)) throw new ProtocolError(400, "bad_tile_hash", "X-Tile-Hash must be 64 hex characters");
  const hash = createHash("sha256").update(bytes).digest("hex");
  if (hash !== headerHash.toLowerCase()) throw new ProtocolError(400, "tile_hash_mismatch", "X-Tile-Hash does not match the uploaded bytes");

  return transaction((db) => {
    const existing = db.prepare("SELECT tile_hash FROM job_tiles WHERE job_id = ? AND idx = ?").get(jobId, index) as
      | { tile_hash: string }
      | undefined;
    if (existing && existing.tile_hash !== hash) throw new ProtocolError(409, "tile_conflict", "a different tile was already uploaded for this index");
    if (!existing) {
      db.prepare("INSERT INTO job_tiles (job_id, idx, tile_hash, bytes) VALUES (?, ?, ?, ?)").run(jobId, index, hash, bytes);
      const fresh = getJob(jobId)!;
      const tiles = fresh.tiles.map((t) => (t.index === index ? { ...t, status: "uploaded" as const, tileHash: hash } : t));
      updateJob(jobId, { tiles });
      const done = tiles.filter((t) => t.status === "uploaded").length;
      appendEvent(jobId, "tile", { index, owner: tile.owner, tileHash: hash, provider: tile.owner });
      appendEvent(jobId, "progress", { done, total: fresh.tileCount });
      return { done, total: fresh.tileCount };
    }
    const done = getJob(jobId)!.tiles.filter((t) => t.status === "uploaded").length;
    return { done, total: job.tileCount };
  });
}

export function getTileBytes(jobId: string, index: number): Buffer | null {
  const row = getDb().prepare("SELECT bytes FROM job_tiles WHERE job_id = ? AND idx = ?").get(jobId, index) as
    | { bytes: Uint8Array }
    | undefined;
  return row ? Buffer.from(row.bytes) : null;
}

// ───────────────────────── claims ─────────────────────────

export const claimBodySchema = z.object({
  provider: z.string(),
  tilesDigest: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/),
  tiles: z
    .array(z.object({ index: z.number().int().min(0), tileHash: z.string().regex(/^(0x)?[0-9a-fA-F]{64}$/) }))
    .min(1)
    .max(4096),
});
export type ClaimBody = z.infer<typeof claimBodySchema>;

/**
 * Validate and store a provider's signed claim over its own tiles. When every provider on the job has claimed,
 * the Merkle root is computed and the job moves to `pending`.
 *
 * NOTE: posting the claim on chain (MeshReceipt.postClaim) is the chain-loop step. Until then `claimTx` stays null
 * and the `claim` event carries only the Merkle root and the challenge-window end.
 */
export async function submitClaim(jobId: string, providerAddress: string, body: ClaimBody): Promise<{ claimed: number; of: number; merkleRoot: string | null }> {
  const env = getEnv();
  if (!env.RECEIPT_ADDRESS) throw new ProtocolError(503, "not_configured", "RECEIPT_ADDRESS is not set on the server");

  const job = getJob(jobId);
  if (!job) throw new ProtocolError(404, "job_not_found", "job not found");
  if (job.status !== "running") throw new ProtocolError(409, "job_not_running", `job is ${job.status}`);
  if (body.provider.toLowerCase() !== providerAddress.toLowerCase()) throw new ProtocolError(403, "provider_mismatch", "claim provider is not the authenticated provider");

  const mine = tilesForProvider(jobId, providerAddress);
  if (!mine) throw new ProtocolError(403, "no_task", "you have no tiles on this job");

  // the claim must cover exactly the provider's tiles, each already uploaded with the same hash
  const submitted = [...body.tiles].sort((a, b) => a.index - b.index);
  if (submitted.length !== mine.length || submitted.some((t, i) => t.index !== mine[i])) {
    throw new ProtocolError(400, "tiles_mismatch", "claim tiles must be exactly the tiles assigned to you");
  }
  for (const t of submitted) {
    const stored = job.tiles[t.index];
    if (stored.status !== "uploaded" || !stored.tileHash) throw new ProtocolError(409, "tile_missing", `tile ${t.index} has not been uploaded`);
    if (stored.tileHash !== t.tileHash.replace(/^0x/, "").toLowerCase()) throw new ProtocolError(400, "tile_hash_mismatch", `tile ${t.index} hash differs from the uploaded tile`);
  }

  // tilesDigest must be the digest of those tiles
  const digest = computeTilesDigest(submitted);
  if (digest.toLowerCase() !== body.tilesDigest.toLowerCase()) throw new ProtocolError(400, "tiles_digest_mismatch", "tilesDigest does not match the tiles");

  // EIP-712 signature by the provider
  let signer: string;
  try {
    signer = await recoverTypedDataAddress({
      ...tileClaimTypedData(
        {
          jobId: jobId as Hex,
          imageDigest: imageDigestToBytes32(job.imageDigest),
          inputHash: with0x(job.inputHash),
          provider: getAddress(providerAddress) as Hex,
          tilesDigest: digest,
        },
        env.HEDERA_CHAIN_ID,
        env.RECEIPT_ADDRESS as Hex,
      ),
      signature: body.signature as Hex,
    });
  } catch {
    throw new ProtocolError(400, "bad_signature", "claim signature could not be recovered");
  }
  if (signer.toLowerCase() !== providerAddress.toLowerCase()) throw new ProtocolError(400, "bad_signature", "claim signature does not match the provider");

  const claimed = transaction((db) => {
    const dup = db.prepare("SELECT 1 FROM claims WHERE job_id = ? AND provider = ?").get(jobId, providerAddress.toLowerCase());
    if (dup) throw new ProtocolError(409, "already_claimed", "this provider already claimed this job");
    db.prepare("INSERT INTO claims (job_id, provider, tiles_digest, signature, created_at) VALUES (?, ?, ?, ?, ?)").run(
      jobId,
      providerAddress.toLowerCase(),
      digest,
      body.signature,
      now(),
    );
    markTaskDone(jobId, providerAddress);
    return (db.prepare("SELECT COUNT(*) AS n FROM claims WHERE job_id = ?").get(jobId) as { n: number }).n;
  });

  if (claimed < job.providers.length) return { claimed, of: job.providers.length, merkleRoot: null };

  // every provider has claimed: build the Merkle root over all tiles (owner address bound into each leaf)
  const fresh = getJob(jobId)!;
  const leaves = await Promise.all(fresh.tiles.map((t) => merkleLeaf(t.index, t.tileHash as string, t.owner as string)));
  const root = await merkleRoot(leaves);
  const windowEnd = now() + CHALLENGE_WINDOW_SECONDS;
  try {
    transaction(() => {
      transitionJob(jobId, "pending", { merkleRoot: root });
      appendEvent(jobId, "claim", { claimTx: null, merkleRoot: root, windowEnd });
    });
  } catch {
    // another request finished the job first; nothing to do
  }
  return { claimed, of: job.providers.length, merkleRoot: root };
}

// ───────────────────────── failure ─────────────────────────

export const FAILURE_REASONS = ["timeout", "crash", "hash_mismatch", "killed", "attestation_missing"] as const;
export const failureBodySchema = z.object({
  provider: z.string(),
  reason: z.enum(FAILURE_REASONS),
  logTail: z.string().max(4000).optional(),
});

/** A provider reports it cannot finish. v1 fails the whole job (a retry on fresh providers is a later improvement). */
export function reportFailure(jobId: string, providerAddress: string, reason: string, logTail?: string): void {
  const job = getJob(jobId);
  if (!job) throw new ProtocolError(404, "job_not_found", "job not found");
  if (!tilesForProvider(jobId, providerAddress)) throw new ProtocolError(403, "no_task", "you have no tiles on this job");
  if (job.status !== "running" && job.status !== "assigned") throw new ProtocolError(409, "job_not_running", `job is ${job.status}`);
  transaction(() => {
    transitionJob(jobId, "failed");
    markTasksFailed(jobId);
    appendEvent(jobId, "error", { code: reason, message: `provider ${getAddress(providerAddress)} reported ${reason}`, logTail: logTail ?? null });
  });
}
