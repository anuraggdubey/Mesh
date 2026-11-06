import { connection } from "next/server";
import { getAddress } from "viem";
import { expireStaleRuns } from "@/lib/agent-runner";
import { json } from "@/lib/api";
import { getBalance, tinybarsToHbar } from "@/lib/credits";
import { depositAddress } from "@/lib/deposits";
import { getEnv } from "@/lib/env";
import { readSession } from "@/lib/session";

/** GET /api/wallet: who is signed in, their prepaid balance, and where to send a deposit. Works without a session (authenticated: false). */
export async function GET(req: Request) {
  await connection();
  const env = getEnv();
  const address = await readSession(req);
  if (address) await expireStaleRuns();
  const balance = address ? getBalance(address) : 0;
  return json({
    authenticated: Boolean(address),
    address: address ? getAddress(address) : null,
    balanceTinybars: balance,
    balanceHbar: tinybarsToHbar(balance),
    depositAddress: depositAddress(),
    chainId: env.HEDERA_CHAIN_ID,
    rpcUrl: env.HEDERA_RPC_URL,
    payments: { x402: env.X402_ENABLED, devSkip: env.MESH_DEV_SKIP_PAYMENT },
  });
}
