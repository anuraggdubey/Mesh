import "dotenv/config";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  formatEther,
  http,
  isAddress,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { meshReceiptAbi } from "@/lib/abi/MeshReceipt";
import { meshStakeAbi } from "@/lib/abi/MeshStake";

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} must be set in .env`);
  return value;
}

async function main(): Promise<void> {
  const rpcUrl = requiredEnv("HEDERA_RPC_URL");
  const chainId = Number(process.env.HEDERA_CHAIN_ID ?? "296");
  if (chainId !== 296)
    throw new Error("This helper only supports Hedera testnet (chain ID 296)");

  const privateKeyValue = requiredEnv("PROVIDER_PRIVATE_KEY");
  const privateKey = (
    privateKeyValue.startsWith("0x") ? privateKeyValue : `0x${privateKeyValue}`
  ) as Hex;
  if (!/^0x[a-fA-F0-9]{64}$/.test(privateKey)) {
    throw new Error("PROVIDER_PRIVATE_KEY must be a 32-byte hex key");
  }

  const stakeAddressValue = requiredEnv("STAKE_ADDRESS");
  const receiptAddressValue = requiredEnv("RECEIPT_ADDRESS");
  if (!isAddress(stakeAddressValue) || !isAddress(receiptAddressValue)) {
    throw new Error(
      "STAKE_ADDRESS and RECEIPT_ADDRESS must be valid EVM addresses",
    );
  }
  const stakeAddress = stakeAddressValue as Address;
  const receiptAddress = receiptAddressValue as Address;
  const chain = defineChain({
    id: chainId,
    name: "Hedera Testnet",
    nativeCurrency: { name: "HBAR", symbol: "HBAR", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  const account = privateKeyToAccount(privateKey);
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });

  const [registered, currentStake, requiredStake, balance] = await Promise.all([
    publicClient.readContract({
      address: stakeAddress,
      abi: meshStakeAbi,
      functionName: "isRegistered",
      args: [account.address],
    }),
    publicClient.readContract({
      address: stakeAddress,
      abi: meshStakeAbi,
      functionName: "stakeOf",
      args: [account.address],
    }),
    publicClient.readContract({
      address: receiptAddress,
      abi: meshReceiptAbi,
      functionName: "minStake",
    }),
    publicClient.getBalance({ address: account.address }),
  ]);

  console.log(`Provider: ${account.address}`);
  console.log(`Wallet balance: ${formatEther(balance)} HBAR`);
  console.log(`Current stake: ${formatEther(currentStake)} HBAR`);
  console.log(`Required stake: ${formatEther(requiredStake)} HBAR`);
  if (!registered) {
    throw new Error(
      "Provider is not registered on-chain. Complete verified World ID registration through the API before staking; no HBAR was sent.",
    );
  }
  if (currentStake >= requiredStake) {
    console.log(
      "Provider already meets the minimum stake; no transaction needed.",
    );
    return;
  }

  const amount = requiredStake - currentStake;
  if (balance < amount) {
    throw new Error(
      `Insufficient HBAR: need ${formatEther(amount)} HBAR to meet the minimum stake`,
    );
  }

  const walletClient = createWalletClient({
    account,
    chain,
    transport: http(rpcUrl),
  });
  const hash = await walletClient.writeContract({
    address: stakeAddress,
    abi: meshStakeAbi,
    functionName: "stake",
    value: amount,
  });
  console.log(`Stake transaction submitted: ${hash}`);

  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success")
    throw new Error(`Stake transaction failed: ${hash}`);

  const updatedStake = await publicClient.readContract({
    address: stakeAddress,
    abi: meshStakeAbi,
    functionName: "stakeOf",
    args: [account.address],
  });
  console.log(`Stake confirmed: ${formatEther(updatedStake)} HBAR`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Provider stake setup failed: ${message}`);
  process.exitCode = 1;
});
