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
 *   used_nonces  x402 payment nonces already settled (replay protection, filled in a later step)
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

CREATE TABLE IF NOT EXISTS used_nonces (
  nonce   TEXT PRIMARY KEY,
  job_id  TEXT NOT NULL,
  ts      INTEGER NOT NULL
);
`;

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

/** Run `fn` inside a transaction; rolls back if it throws. */
export function transaction<T>(fn: (db: DatabaseSync) => T): T {
  const db = getDb();
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn(db);
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
