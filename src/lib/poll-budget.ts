/**
 * Retry a check until it returns a value or the time budget runs out.
 * The gap between tries is capped, and a new try is not started once the budget has passed.
 * A check that has already started is allowed to finish: its own timeout has to be short.
 */
export async function pollWithin<T>(
  budgetMs: number,
  check: () => Promise<T | undefined>,
  opts?: { intervalMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number },
): Promise<T | undefined> {
  const intervalMs = opts?.intervalMs ?? 1_500;
  const now = opts?.now ?? Date.now;
  const sleep = opts?.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const start = now();
  while (now() - start < budgetMs) {
    const value = await check();
    if (value !== undefined) return value;
    const left = budgetMs - (now() - start);
    if (left <= 0) return undefined;
    await sleep(Math.min(intervalMs, left));
  }
  return undefined;
}
