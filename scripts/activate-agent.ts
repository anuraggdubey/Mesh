// A wallet funded by an EVM-address transfer is a "hollow" Hedera account: it has no public key on the network until it signs
// one Hedera-native transaction. The x402 facilitator looks that key up to verify a payment, so the agent wallet needs this once.
// Usage: npm run agent:activate     (sends 0.1 HBAR from the agent wallet to the treasury; needs AGENT_PRIVATE_KEY)
import "dotenv/config";
import { AccountId, Client, Hbar, PrivateKey, TransferTransaction } from "@hiero-ledger/sdk";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";

const mirror = (process.env.MIRROR_NODE_URL || "https://testnet.mirrornode.hedera.com").replace(/\/$/, "");

async function account(evm: string): Promise<{ account: string; key: unknown }> {
  const res = await fetch(`${mirror}/api/v1/accounts/${evm}`);
  if (!res.ok) throw new Error(`no Hedera account for ${evm} yet; send it some HBAR first`);
  return (await res.json()) as { account: string; key: unknown };
}

async function main() {
  const raw = process.env.AGENT_PRIVATE_KEY?.trim();
  if (!raw) throw new Error("set AGENT_PRIVATE_KEY in .env");
  const hex = (raw.startsWith("0x") ? raw : `0x${raw}`) as Hex;
  const me = await account(privateKeyToAccount(hex).address.toLowerCase());
  if (me.key) {
    console.log(`account ${me.account} already has a public key on Hedera: nothing to do`);
    return;
  }
  const to = process.env.X402_PAY_TO || (process.env.API_PRIVATE_KEY ? (await account(privateKeyToAccount(process.env.API_PRIVATE_KEY as Hex).address.toLowerCase())).account : "");
  if (!to) throw new Error("set X402_PAY_TO or API_PRIVATE_KEY so there is somewhere to send 0.1 HBAR");

  const client = Client.forTestnet().setOperator(AccountId.fromString(me.account), PrivateKey.fromStringECDSA(hex.slice(2)));
  const resp = await new TransferTransaction().addHbarTransfer(me.account, new Hbar(-0.1)).addHbarTransfer(to, new Hbar(0.1)).execute(client);
  await resp.getReceipt(client);
  console.log(`sent 0.1 HBAR ${me.account} -> ${to}; transaction ${resp.transactionId.toString()}`);
  client.close();
  const after = await account(privateKeyToAccount(hex).address.toLowerCase());
  console.log(after.key ? "the account now has its public key on Hedera" : "the mirror node has not shown the key yet; wait a few seconds and run the agent");
}

main().catch((e) => {
  console.error("activate-agent:", e instanceof Error ? e.message : e);
  process.exit(1);
});
