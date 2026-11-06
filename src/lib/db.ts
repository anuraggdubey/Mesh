import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
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
 *   auth_nonces  wallet sign-in nonces (single use)
 *   credits, ledger  prepaid HBAR a user deposited for the Mesh agent to spend, and every change to it
 *   plans, runs  what the user asked the agent for (planned by 0G or manually) and the agent's run for it
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

-- Wallet sign-in nonces: single use, short lived, bound to the address that asked for them
CREATE TABLE IF NOT EXISTS auth_nonces (
  nonce      TEXT PRIMARY KEY,
  address    TEXT NOT NULL,          -- lowercase
  issued_at  INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used       INTEGER NOT NULL DEFAULT 0
);

-- Prepaid credit (tinybars) for the Mesh agent to spend on a user's behalf
CREATE TABLE IF NOT EXISTS credits (
  address           TEXT PRIMARY KEY, -- lowercase
  balance_tinybars  INTEGER NOT NULL CHECK (balance_tinybars >= 0)
);
CREATE TABLE IF NOT EXISTS ledger (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  address  TEXT NOT NULL,
  kind     TEXT NOT NULL,            -- deposit | job_hold | job_refund | job_spent
  amount   INTEGER NOT NULL,         -- tinybars, always positive
  ref      TEXT NOT NULL,            -- deposit tx hash, or the run id
  ts       INTEGER NOT NULL,
  receipt_id TEXT NOT NULL           -- rcpt_..., the receipt page for this entry
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_receipt ON ledger(receipt_id);
CREATE INDEX IF NOT EXISTS idx_ledger_address ON ledger(address, id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_once ON ledger(kind, ref);  -- a deposit, hold, refund or spend happens once

-- A plan: what the user asked for, and what 0G (or the user, manually) chose. Single use, short lived.
CREATE TABLE IF NOT EXISTS plans (
  plan_id        TEXT PRIMARY KEY,
  address        TEXT NOT NULL,
  source         TEXT NOT NULL,      -- og | manual
  prompt         TEXT,
  preset         TEXT NOT NULL,
  price          TEXT NOT NULL,      -- job price units (0.1 = 100000)
  reason         TEXT,
  og_request_id  TEXT,
  og_provider    TEXT,
  og_model       TEXT,
  tee_verified   INTEGER,            -- null = the Router did not say
  verification   TEXT,               -- tee-signature | router-checked | unverified
  signer         TEXT,
  digest         TEXT,
  created_at     INTEGER NOT NULL,
  expires_at     INTEGER NOT NULL,
  status         TEXT NOT NULL,      -- planned | used
  run_id         TEXT
);

-- A run: the agent buying one job for a plan. A row, so it survives the request that started it.
CREATE TABLE IF NOT EXISTS runs (
  run_id        TEXT PRIMARY KEY,
  address       TEXT NOT NULL,
  plan_id       TEXT NOT NULL,
  preset        TEXT NOT NULL,
  amount        INTEGER NOT NULL,    -- tinybars held for this run
  status        TEXT NOT NULL,       -- queued | needs_approval | paying | paid | failed
  approval_id   TEXT,
  approval_url  TEXT,
  user_code     TEXT,
  job_id        TEXT,
  payment_tx    TEXT,
  receipt_id    TEXT,                -- the receipt for the credit held for this run
  error         TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_runs_address ON runs(address, created_at);
`;

/** Add columns introduced after a database file was first created (CREATE TABLE IF NOT EXISTS never alters). */
function ensureColumn(db: DatabaseSync, table: string, column: string, definition: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function migrate(db: DatabaseSync): void {
  ensureColumn(db, "providers", "chain_tx", "TEXT");
  ensureColumn(db, "job_events", "hcs_seq", "INTEGER"); // NULL = not published to HCS yet, 0 = not part of the log
  ensureColumn(db, "approvals", "method", "TEXT NOT NULL DEFAULT 'device'"); // device = World IdP device grant, idkit = World ID proof per approval
}

type GlobalWithDb = typeof globalThis & { __meshDb?: { path: string; schema: string; db: DatabaseSync } };

// A long-running server (or a hot-reloaded dev server) keeps its open handle. If the schema changed since it was opened, reopen so new
// tables exist, instead of failing with "no such table".
const SCHEMA_ID = createHash("sha1").update(SCHEMA).update(migrate.toString()).digest("hex");

export function dbPath(): string {
  return path.resolve(process.cwd(), getEnv().DATA_DIR, "mesh.db");
}

/** Lazily open the database (survives Next.js dev hot reloads via globalThis). */
export function getDb(): DatabaseSync {
  const g = globalThis as GlobalWithDb;
  const p = dbPath();
  if (g.__meshDb && g.__meshDb.path === p && g.__meshDb.schema === SCHEMA_ID) return g.__meshDb.db;
  if (g.__meshDb) g.__meshDb.db.close();

  mkdirSync(path.dirname(p), { recursive: true });
  const db = new DatabaseSync(p);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  migrate(db);
  g.__meshDb = { path: p, schema: SCHEMA_ID, db };
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
