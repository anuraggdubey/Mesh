import { createHash, randomBytes, randomUUID } from "node:crypto";
import { getAddress, recoverMessageAddress } from "viem";
import { z } from "zod";
import { getDb, transaction } from "./db";
import { PROVIDER_OFFLINE_AFTER_SECONDS } from "./constants";
import { parseRegisterNonce, REGISTER_NONCE_MAX_AGE_MS, registerMessage } from "./claim";
import { addressSchema } from "./types";

const now = () => Math.floor(Date.now() / 1000);
const sha256Hex = (s: string) => createHash("sha256").update(s).digest("hex");

export const registerBodySchema = z.object({
  address: addressSchema,
  signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/, "signature must be 65 bytes of hex"),
  nonce: z.string().min(10).max(100),
  cores: z.number().int().positive().max(1024),
  memoryGb: z.number().positive().max(65536),
  os: z.string().min(1).max(40),
  arch: z.string().min(1).max(40),
  agentVersion: z.string().min(1).max(40),
  // World ID proof for `register-provider`. Verified server-side in a later step; accepted but ignored for now.
  worldProof: z.record(z.string(), z.unknown()).optional(),
});
export type RegisterBody = z.infer<typeof registerBodySchema>;

export const heartbeatBodySchema = z.object({
  load: z.number().min(0).max(1024).optional(),
  currentTask: z.string().max(100).nullable().optional(),
});

export interface ProviderRow {
  address: string; // lowercase
  providerId: string;
  cores: number;
  memoryGb: number;
  os: string;
  arch: string;
  agentVersion: string;
  worldNullifier: string | null;
  registeredAt: number;
  lastSeen: number;
  load: number | null;
  currentTask: string | null;
}

interface RawProvider {
  address: string;
  provider_id: string;
  cores: number;
  memory_gb: number;
  os: string;
  arch: string;
  agent_version: string;
  world_nullifier: string | null;
  registered_at: number;
  last_seen: number;
  load: number | null;
  current_task: string | null;
}

const fromRaw = (r: RawProvider): ProviderRow => ({
  address: r.address,
  providerId: r.provider_id,
  cores: r.cores,
  memoryGb: r.memory_gb,
  os: r.os,
  arch: r.arch,
  agentVersion: r.agent_version,
  worldNullifier: r.world_nullifier,
  registeredAt: r.registered_at,
  lastSeen: r.last_seen,
  load: r.load,
  currentTask: r.current_task,
});

export class RegistrationError extends Error {
  constructor(
    public readonly code: "bad_nonce" | "nonce_expired" | "nonce_replayed" | "bad_signature",
    message: string,
  ) {
    super(message);
    this.name = "RegistrationError";
  }
}

/**
 * Register (or re-register) a provider. The caller proves they own the address by signing
 * "mesh-register:<nonce>" with personal_sign. A nonce is "<unix-ms>-<random>", fresh within 5 minutes and usable once.
 * Returns a new bearer token (shown once; only its hash is stored). Re-registering rotates the token.
 *
 * NOTE: the World ID proof is not verified yet (step 13), so `worldNullifier` stays null for now.
 */
export async function registerProvider(body: RegisterBody): Promise<{ providerId: string; token: string; address: string }> {
  const stamp = parseRegisterNonce(body.nonce);
  if (stamp === null) throw new RegistrationError("bad_nonce", 'nonce must look like "<unix-ms>-<random>"');
  const age = Date.now() - stamp;
  if (age > REGISTER_NONCE_MAX_AGE_MS || age < -60_000) throw new RegistrationError("nonce_expired", "nonce is too old or from the future");

  let recovered: string;
  try {
    recovered = await recoverMessageAddress({ message: registerMessage(body.nonce), signature: body.signature as `0x${string}` });
  } catch {
    throw new RegistrationError("bad_signature", "signature could not be recovered");
  }
  if (recovered.toLowerCase() !== body.address.toLowerCase()) {
    throw new RegistrationError("bad_signature", "signature does not match the address");
  }

  const address = body.address.toLowerCase();
  const token = randomBytes(32).toString("hex");
  const tokenHash = sha256Hex(token);

  return transaction((db) => {
    const used = db.prepare("SELECT 1 FROM used_nonces WHERE nonce = ?").get(`register:${body.nonce}`);
    if (used) throw new RegistrationError("nonce_replayed", "nonce was already used");
    db.prepare("INSERT INTO used_nonces (nonce, job_id, ts) VALUES (?, ?, ?)").run(`register:${body.nonce}`, "register", now());

    const existing = db.prepare("SELECT provider_id FROM providers WHERE address = ?").get(address) as
      | { provider_id: string }
      | undefined;
    const providerId = existing?.provider_id ?? randomUUID();
    if (existing) {
      db.prepare(
        `UPDATE providers SET token_hash = ?, cores = ?, memory_gb = ?, os = ?, arch = ?, agent_version = ?, last_seen = ? WHERE address = ?`,
      ).run(tokenHash, body.cores, body.memoryGb, body.os, body.arch, body.agentVersion, now(), address);
    } else {
      db.prepare(
        `INSERT INTO providers (address, provider_id, token_hash, cores, memory_gb, os, arch, agent_version, world_nullifier, registered_at, last_seen)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      ).run(address, providerId, tokenHash, body.cores, body.memoryGb, body.os, body.arch, body.agentVersion, now(), now());
    }
    return { providerId, token, address: getAddress(address) };
  });
}

/** Resolve `Authorization: Bearer <token>` to a provider, or null. */
export function authenticateProvider(req: Request): ProviderRow | null {
  const header = req.headers.get("authorization") ?? "";
  const m = /^Bearer ([0-9a-f]{64})$/.exec(header);
  if (!m) return null;
  const row = getDb().prepare("SELECT * FROM providers WHERE token_hash = ?").get(sha256Hex(m[1])) as RawProvider | undefined;
  return row ? fromRaw(row) : null;
}

export function touchProvider(address: string, patch: { load?: number | null; currentTask?: string | null } = {}): void {
  const sets = ["last_seen = ?"];
  const args: (string | number | null)[] = [now()];
  if (patch.load !== undefined) {
    sets.push("load = ?");
    args.push(patch.load);
  }
  if (patch.currentTask !== undefined) {
    sets.push("current_task = ?");
    args.push(patch.currentTask);
  }
  getDb().prepare(`UPDATE providers SET ${sets.join(", ")} WHERE address = ?`).run(...args, address.toLowerCase());
}

export function getProvider(address: string): ProviderRow | null {
  const row = getDb().prepare("SELECT * FROM providers WHERE address = ?").get(address.toLowerCase()) as RawProvider | undefined;
  return row ? fromRaw(row) : null;
}

export function isOnline(p: ProviderRow, at = now()): boolean {
  return at - p.lastSeen <= PROVIDER_OFFLINE_AFTER_SECONDS;
}

/** Providers seen within the offline window, in a stable order (registration time, then address). */
export function listOnlineProviders(): ProviderRow[] {
  const cutoff = now() - PROVIDER_OFFLINE_AFTER_SECONDS;
  const rows = getDb()
    .prepare("SELECT * FROM providers WHERE last_seen >= ? ORDER BY registered_at, address")
    .all(cutoff) as unknown as RawProvider[];
  return rows.map(fromRaw);
}

export function listProviders(): (ProviderRow & { online: boolean })[] {
  const rows = getDb().prepare("SELECT * FROM providers ORDER BY registered_at, address").all() as unknown as RawProvider[];
  return rows.map((r) => {
    const p = fromRaw(r);
    return { ...p, online: isOnline(p) };
  });
}

/** Public view of a provider (never includes the token hash). Address is checksummed. */
export function publicProvider(p: ProviderRow & { online?: boolean }) {
  return {
    address: getAddress(p.address),
    providerId: p.providerId,
    cores: p.cores,
    memoryGb: p.memoryGb,
    os: p.os,
    arch: p.arch,
    agentVersion: p.agentVersion,
    worldVerified: p.worldNullifier !== null,
    lastSeen: p.lastSeen,
    online: p.online ?? isOnline(p),
    load: p.load,
    currentTask: p.currentTask,
  };
}
