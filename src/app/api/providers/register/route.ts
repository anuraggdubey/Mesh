import { connection } from "next/server";
import { json, jsonError, readJson } from "@/lib/api";
import { chainWritesConfigured, devNullifier, registerProviderOnChain } from "@/lib/chain";
import { getEnv } from "@/lib/env";
import { registerBodySchema, registerProvider, RegistrationError, setProviderChainTx } from "@/lib/providers";

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

  const env = getEnv();
  const chain: { registered: boolean; txHash: string | null; error?: string; reason?: string } = { registered: false, txHash: null };
  if (!env.MESH_DEV_SKIP_WORLD) {
    chain.reason = "world_id_required"; // real on-chain registration arrives with the World ID step
  } else if (!chainWritesConfigured()) {
    chain.error = "chain_not_configured";
  } else {
    try {
      const r = await registerProviderOnChain(result.address, devNullifier(result.address));
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
