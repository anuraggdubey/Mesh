import { chainLoopConfigured, isProviderEligible, onChainMinStake } from "./chain";
import { getEnv } from "./env";
import { tryAssignPending } from "./matcher";
import { listOnlineProviders } from "./providers";

const ELIGIBILITY_TTL_MS = 15_000;
const cache = new Map<string, { eligible: boolean; at: number }>();

export function resetEligibilityCache(): void {
  cache.clear();
}

/**
 * Assign paid jobs to online providers. With the chain loop on, only providers that are registered AND staked on
 * chain are eligible (the claim contract rejects anyone else, so assigning them would waste a whole job).
 * Eligibility reads are cached for 15 s so the long-poll loop does not hammer the RPC.
 */
export async function assignPending(): Promise<number> {
  if (!getEnv().MESH_CHAIN_LOOP || !chainLoopConfigured()) return tryAssignPending();

  const online = listOnlineProviders();
  if (online.length === 0) return 0;
  const minStake = await onChainMinStake();
  const allowed = new Set<string>();
  await Promise.all(
    online.map(async (p) => {
      const key = p.address.toLowerCase();
      const hit = cache.get(key);
      if (hit && Date.now() - hit.at < ELIGIBILITY_TTL_MS) {
        if (hit.eligible) allowed.add(key);
        return;
      }
      let eligible = false;
      try {
        eligible = await isProviderEligible(p.address, minStake);
      } catch {
        // RPC hiccup: treat as not eligible this round (it is retried after the cache expires)
      }
      cache.set(key, { eligible, at: Date.now() });
      if (eligible) allowed.add(key);
    }),
  );
  return tryAssignPending(allowed);
}
