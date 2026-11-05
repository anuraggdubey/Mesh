import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { getEnv } from "./env";

/**
 * SQLite store (node:sqlite, built into Node 24: no native build step). One process owns the file.
 * Tables:
 *   jobs         one row per job; `data` holds the full Job JSON, `status`/`created_at` are indexed copies
 *   job_events   append-only event log; replayed to the SSE stream and used for the audit trail
 *   job_tiles    tile bytes uploaded by providers (tile hashes live inside the job JSON too)
 *   providers    registered provider machines (bearer-token auth, heartbeat, load)
 *   tasks        tile assignments handed to providers
 *   claims       provider-signed TileClaims (EIP-712), kept as audit evidence
 *   world_nullifiers  World ID nullifiers already used per action (one human, one provider profile)
 *   approvals    human approvals (World Agent Pass) bound to one exact action, single use
 *   used_nonces  x402 payment nonces and provider-register nonces already used (replay protection)
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  job_id     TEXT PRIMARY KEY,
  status     TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  data       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);

CREATE TABLE IF NOT EXISTS job_events (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id  TEXT NOT NULL,
  type    TEXT NOT NULL,
  data    TEXT NOT NULL,
  ts      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_job ON job_events(job_id, id);

CREATE TABLE IF NOT EXISTS job_tiles (
  job_id    TEXT NOT NULL,
  idx       INTEGER NOT NULL,
  tile_hash TEXT NOT NULL,
  bytes     BLOB NOT NULL,
  PRIMARY KEY (job_id, idx)
);

CREATE TABLE IF NOT EXISTS providers (
  address        TEXT PRIMARY KEY,   -- lowercase 0x address
  provider_id    TEXT NOT NULL,
  token_hash     TEXT NOT NULL,      -- sha256 of the bearer token
  cores          INTEGER NOT NULL,
  memory_gb      REAL NOT NULL,
  os             TEXT NOT NULL,
  arch           TEXT NOT NULL,
  agent_version  TEXT NOT NULL,
  world_nullifier TEXT,
  chain_tx       TEXT,               -- tx hash of MeshStake.registerProvider (null until registered on chain)
  registered_at  INTEGER NOT NULL,
  last_seen      INTEGER NOT NULL,
  load           REAL,
  current_task   TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_providers_token ON providers(token_hash);

CREATE TABLE IF NOT EXISTS tasks (
  task_id      TEXT PRIMARY KEY,
  job_id       TEXT NOT NULL,
  provider     TEXT NOT NULL,        -- lowercase address
  tiles        TEXT NOT NULL,        -- JSON array of tile indices
  status       TEXT NOT NULL,        -- queued | delivered | done | failed
  created_at   INTEGER NOT NULL,
  delivered_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tasks_provider ON tasks(provider, status);
CREATE INDEX IF NOT EXISTS idx_tasks_job ON tasks(job_id);

CREATE TABLE IF NOT EXISTS claims (
  job_id        TEXT NOT NULL,
  provider      TEXT NOT NULL,
  tiles_digest  TEXT NOT NULL,
  signature     TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (job_id, provider)
);

CREATE TABLE IF NOT EXISTS world_nullifiers (
  nullifier   TEXT NOT NULL,
  action      TEXT NOT NULL,
  address     TEXT NOT NULL,         -- lowercase provider address bound to this human
  verified_at INTEGER NOT NULL,
  PRIMARY KEY (nullifier, action)
);

CREATE TABLE IF NOT EXISTS approvals (
  approval_id  TEXT PRIMARY KEY,
  purpose      TEXT NOT NULL,        -- e.g. create-job
  binding      TEXT NOT NULL,        -- sha256 of the exact action this approval authorizes
  params       TEXT NOT NULL,        -- JSON of the bound action (requester, preset, price)
  status       TEXT NOT NULL,        -- pending | approved | denied | expired | used
  device_code  TEXT NOT NULL,
  user_code    TEXT NOT NULL,
  verification_uri TEXT NOT NULL,
  interval_s   INTEGER NOT NULL,
  next_poll_at INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  subject      TEXT,                 -- (iss, sub) of the approving human once approved
  reason       TEXT,
  created_at   INTEGER NOT NULL,
  decided_at   INTEGER,
  used_at      INTEGER
);

CREATE TABLE IF NOT EXISTS used_nonces (
  nonce   TEXT PRIMARY KEY,
  job_id  TEXT NOT NULL,
  ts      INTEGER NOT NULL
);
`;

/** Add columns introduced after a database file was first created (CREATE TABLE IF NOT EXISTS never alters). */
function ensureColumn(db: DatabaseSync, table: string, column: string, definition: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function migrate(db: DatabaseSync): void {
  ensureColumn(db, "providers", "chain_tx", "TEXT");
}

type GlobalWithDb = typeof globalThis & { __meshDb?: { path: string; db: DatabaseSync } };

export function dbPath(): string {
  return path.resolve(process.cwd(), getEnv().DATA_DIR, "mesh.db");
}

/** Lazily open the database (survives Next.js dev hot reloads via globalThis). */
export function getDb(): DatabaseSync {
  const g = globalThis as GlobalWithDb;
  const p = dbPath();
  if (g.__meshDb && g.__meshDb.path === p) return g.__meshDb.db;
  if (g.__meshDb) g.__meshDb.db.close();

  mkdirSync(path.dirname(p), { recursive: true });
  const db = new DatabaseSync(p);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  migrate(db);
  g.__meshDb = { path: p, db };
  return db;
}

/** For tests: close and forget the open database. */
export function closeDb(): void {
  const g = globalThis as GlobalWithDb;
  if (g.__meshDb) {
    g.__meshDb.db.close();
    g.__meshDb = undefined;
  }
}

let txDepth = 0;

/**
 * Run `fn` inside a transaction; rolls back if it throws. Re-entrant: a nested call joins the outer
 * transaction, so a failure anywhere rolls the whole thing back.
 */
export function transaction<T>(fn: (db: DatabaseSync) => T): T {
  const db = getDb();
  if (txDepth > 0) return fn(db);
  db.exec("BEGIN IMMEDIATE");
  txDepth = 1;
  try {
    const result = fn(db);
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  } finally {
    txDepth = 0;
  }
}
