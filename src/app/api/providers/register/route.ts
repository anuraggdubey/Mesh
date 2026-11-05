import { connection } from "next/server";
import { json, jsonError, readJson } from "@/lib/api";
import { chainWritesConfigured, devNullifier, registerProviderOnChain } from "@/lib/chain";
import { assertNullifierAvailable, consumeNullifier, nullifierToBytes32, verifyIdkitProof, WorldDeniedError, worldEnforced } from "@/lib/world";
import { getEnv } from "@/lib/env";
import { registerBodySchema, registerProvider, RegistrationError, setProviderChainTx, setProviderNullifier } from "@/lib/providers";

/**
 * POST /api/providers/register (docs/job-spec.md section 10.2). The caller signs "mesh-register:<nonce>" with
 * personal_sign. Returns a bearer token that is shown once, plus the on-chain registration status.
 *
 * On-chain registration (MeshStake.registerProvider) needs a verified World ID proof. World ID is not wired in yet, so
 * it only happens when the server runs with MESH_DEV_SKIP_WORLD=true (a derived placeholder nullifier is used).
 * Otherwise `chain.registered` is false and the provider cannot take jobs that need an on-chain claim.
 */
export async function POST(req: Request) {
  await connection();
  const read = await readJson(req, 16 * 1024);
  if ("error" in read) return read.error;

  const parsed = registerBodySchema.safeParse(read.value);
  if (!parsed.success) {
    return json({ error: "invalid_body", issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) }, 400);
  }

  // World ID gate: when IDKit is configured, registration requires a valid proof of a unique human. A missing,
  // invalid or reused proof means the provider is NOT registered at all (the protected action does not happen).
  let nullifier: string | null = null;
  const env = getEnv();
  if (worldEnforced() && !env.MESH_DEV_SKIP_WORLD) {
    try {
      nullifier = (await verifyIdkitProof("register-provider", parsed.data.worldProof)).nullifier;
      assertNullifierAvailable(nullifier, "register-provider", parsed.data.address); // read-only: spend it only after the wallet signature checks out
    } catch (e) {
      if (e instanceof WorldDeniedError) return jsonError(e.reason === "verify_unavailable" ? 503 : 401, "world_denied", e.message, { reason: e.reason });
      throw e;
    }
  }

  let result;
  try {
    result = await registerProvider(parsed.data);
  } catch (err) {
    if (err instanceof RegistrationError) {
      const status = err.code === "nonce_replayed" ? 409 : 401;
      return jsonError(status, err.code, err.message);
    }
    throw err;
  }

  if (nullifier) {
    try {
      consumeNullifier(nullifier, "register-provider", result.address); // now that the wallet signature is verified
    } catch (e) {
      if (e instanceof WorldDeniedError) return jsonError(401, "world_denied", e.message, { reason: e.reason });
      throw e;
    }
    setProviderNullifier(result.address, nullifier);
  }
  const chain: { registered: boolean; txHash: string | null; error?: string; reason?: string } = { registered: false, txHash: null };
  if (!env.MESH_DEV_SKIP_WORLD && !nullifier) {
    chain.reason = "world_id_required"; // World ID is not configured on this server, so no verified human to register
  } else if (!chainWritesConfigured()) {
    chain.error = "chain_not_configured";
  } else {
    try {
      // a verified human registers under their real nullifier; the dev skip uses a placeholder
      const r = await registerProviderOnChain(result.address, nullifier ? nullifierToBytes32(nullifier) : devNullifier(result.address));
      chain.registered = true;
      chain.txHash = r.txHash;
      // remember it is registered even when it already was (no new transaction): "already-registered" is a marker
      setProviderChainTx(result.address, r.txHash ?? "already-registered");
    } catch (e) {
      // registration with the API still succeeded; report why the chain step did not
      chain.error = e instanceof Error ? e.message.split("\n")[0].slice(0, 300) : "chain_error";
    }
  }

  return json({ ...result, chain });
}
