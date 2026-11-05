// Create the HCS audit topic once. Only the API wallet may post to it (submit key), so the log cannot be spammed.
// Usage: npm run hcs:create-topic     (needs API_PRIVATE_KEY, funded with a little HBAR)
import "dotenv/config";
import { Client, PrivateKey, TopicCreateTransaction } from "@hiero-ledger/sdk";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";

async function main() {
  const raw = process.env.API_PRIVATE_KEY?.trim();
  if (!raw) throw new Error("set API_PRIVATE_KEY in .env");
  const hex = (raw.startsWith("0x") ? raw : `0x${raw}`) as Hex;
  const mirror = (process.env.MIRROR_NODE_URL || "https://testnet.mirrornode.hedera.com").replace(/\/$/, "");
  const evm = privateKeyToAccount(hex).address.toLowerCase();
  const res = await fetch(`${mirror}/api/v1/accounts/${evm}`);
  if (!res.ok) throw new Error(`the API wallet ${evm} has no Hedera account yet; send it some HBAR first`);
  const accountId = ((await res.json()) as { account: string }).account;

  const key = PrivateKey.fromStringECDSA(hex.slice(2));
  const client = Client.forTestnet().setOperator(accountId, key);
  const tx = await new TopicCreateTransaction().setTopicMemo("Mesh audit log").setSubmitKey(key.publicKey).execute(client);
  const topicId = (await tx.getReceipt(client)).topicId;
  if (!topicId) throw new Error("no topic id in the receipt");
  console.log(`created topic ${topicId} (operator ${accountId})`);
  console.log(`add to .env:  HCS_TOPIC_ID=${topicId}`);
  console.log(`view:         https://hashscan.io/testnet/topic/${topicId}`);
  client.close();
}

main().catch((e) => {
  console.error("create-topic:", e instanceof Error ? e.message : e);
  process.exit(1);
});
