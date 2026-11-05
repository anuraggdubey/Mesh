// Deployed Mesh contracts on Hedera testnet (chain 296). Addresses are public. Deployed 2026-11-05.
import { meshStakeAbi } from "./abi/MeshStake";
import { meshEscrowAbi } from "./abi/MeshEscrow";
import { meshReceiptAbi } from "./abi/MeshReceipt";
import { mockStableAbi } from "./abi/MockStable";

export const HEDERA_TESTNET_CHAIN_ID = 296;

export const contracts = {
  token: { address: "0x9009A5B2070a97aAa81c6EB77A2507273Ba46Ee3", abi: mockStableAbi },
  stake: { address: "0x522C2eef0EF65d1f9eA9dfe12b88ba24565245f8", abi: meshStakeAbi },
  escrow: { address: "0x16eFE46De1CdA06Be455607A63514319aE130010", abi: meshEscrowAbi },
  receipt: { address: "0x0118652ea87a8616Cb51979F5F121FC598bf3e7E", abi: meshReceiptAbi },
} as const;

export const hashscanUrl = (kind: "tx" | "address" | "contract", id: string) =>
  `https://hashscan.io/testnet/${kind}/${id}`;
