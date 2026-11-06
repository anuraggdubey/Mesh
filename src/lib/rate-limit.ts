/**
 * A small in-memory limiter: at most `limit` hits per `windowSeconds` for each key. Enough to stop a loop or a click-storm on the
 * endpoints that cost money (the 0G plan call) or hit the chain (deposit checks). One process, so no shared store is needed.
 */
type Bucket = { count: number; resetAt: number };
const buckets = new Map<string, Bucket>();

export function rateLimit(key: string, limit: number, windowSeconds: number): { ok: true } | { ok: false; retryAfter: number } {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || now >= b.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + windowSeconds * 1000 });
    if (buckets.size > 5000) for (const [k, v] of buckets) if (now >= v.resetAt) buckets.delete(k);
    return { ok: true };
  }
  if (b.count >= limit) return { ok: false, retryAfter: Math.max(1, Math.ceil((b.resetAt - now) / 1000)) };
  b.count += 1;
  return { ok: true };
}

export function resetRateLimits(): void {
  buckets.clear();
}
