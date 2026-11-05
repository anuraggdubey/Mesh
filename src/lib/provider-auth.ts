import { jsonError } from "./api";
import { authenticateProvider } from "./providers";
import type { ProviderRow } from "./providers";

/** Require a valid provider bearer token. Returns the provider or a 401 Response. */
export function requireProvider(req: Request): { provider: ProviderRow } | { error: Response } {
  const provider = authenticateProvider(req);
  if (!provider) return { error: jsonError(401, "unauthorized", "missing or invalid provider token") };
  return { provider };
}
