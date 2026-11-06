import { connection } from "next/server";
import { json } from "@/lib/api";
import { getEnv } from "@/lib/env";

/** GET /api/config: public, non-secret settings the UI needs to build explorer links. */
export async function GET() {
  await connection();
  const env = getEnv();
  return json({
    chainId: env.HEDERA_CHAIN_ID,
    network: env.HEDERA_CHAIN_ID === 295 ? "mainnet" : "testnet",
    hcsTopicId: env.HCS_TOPIC_ID ?? null,
    contracts: { receipt: env.RECEIPT_ADDRESS ?? null, stake: env.STAKE_ADDRESS ?? null, escrow: env.ESCROW_ADDRESS ?? null },
    x402: { enabled: env.X402_ENABLED, network: env.X402_NETWORK, asset: env.X402_ASSET },
  });
}
