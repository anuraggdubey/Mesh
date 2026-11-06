import { randomUUID } from "node:crypto";
import { getDb, transaction } from "./db";

/**
 * A lease so that only ONE process works the chain at a time when several share the same database (for example `npm run dev` and
 * `npm start` side by side). Two loops racing would both try to lock the same escrow and the loser's transaction reverts.
 * The holder renews the lease on every pass; if it dies, the lease expires and another process takes over.
 */

export const PROCESS_ID = `${process.pid}-${randomUUID().slice(0, 8)}`;

const now = () => Math.floor(Date.now() / 1000);

/** Take or renew the named lease for `holder`. Returns false if someone else holds an unexpired lease. */
export function acquireLease(name: string, holder: string = PROCESS_ID, ttlSeconds = 20): boolean {
  return transaction((db) => {
    const t = now();
    const row = db.prepare("SELECT holder, expires_at FROM leases WHERE name = ?").get(name) as { holder: string; expires_at: number } | undefined;
    if (row && row.holder !== holder && row.expires_at > t) return false;
    db.prepare("INSERT INTO leases (name, holder, expires_at) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET holder = excluded.holder, expires_at = excluded.expires_at").run(name, holder, t + ttlSeconds);
    return true;
  });
}

export function releaseLease(name: string, holder: string = PROCESS_ID): void {
  getDb().prepare("DELETE FROM leases WHERE name = ? AND holder = ?").run(name, holder);
}
