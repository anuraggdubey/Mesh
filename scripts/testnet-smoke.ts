// Hedera testnet smoke check for the API wallet's escrow transactions. It uses ONLY the API wallet's own gas:
// mint test tokens to the escrow, lock a throwaway job id, then refund it, and prints the HashScan links.
// No provider, no stake, no transfer from any other wallet.
//
//   npm run testnet:smoke
import "dotenv/config";
import { randomBytes } from "node:crypto";
import { getAddress } from "viem";
import { chainLoopConfigured, escrowStatus, lockEscrowOnChain, publicClient, refundOnChain } from "../src/lib/chain";
import { getEnv } from "../src/lib/env";

const scan = (tx: string | null) => (tx ? `https://hashscan.io/testnet/transaction/${tx}` : "(none)");

async function main() {
  const env = getEnv();
  if (!chainLoopConfigured()) throw new Error("API_PRIVATE_KEY and the contract addresses must be set in .env");
  if (env.HEDERA_CHAIN_ID !== 296) throw new Error(`refusing to run: chain id ${env.HEDERA_CHAIN_ID} is not Hedera testnet (296)`);

  const pc = publicClient();
  console.log(`chain ${await pc.getChainId()} block ${await pc.getBlockNumber()}`);

  const jobId = `0x${randomBytes(32).toString("hex")}` as const;
  const requester = getAddress("0x6834228cb6F180C05fA2154a2B2670d92c4FDf59");
  console.log(`throwaway job ${jobId}`);

  const lock = await lockEscrowOnChain({ jobId, requester, price: "100000" }, { devFund: true });
  console.log(`locked   status=${await escrowStatus(jobId)}  ${scan(lock.txHash)}`);

  const refund = await refundOnChain(jobId);
  console.log(`refunded status=${await escrowStatus(jobId)}  ${scan(refund)}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
