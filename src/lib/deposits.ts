import { getAddress, isAddress } from "viem";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { creditDeposit, CreditError } from "./credits";
import { getEnv } from "./env";

/**
 * Deposits. The user sends HBAR from their wallet to the agent wallet with an ordinary EVM transfer. We read that transaction back
 * from the Hedera JSON-RPC relay and credit the sender once. We never take the client's word for an amount.
 *
 * UNITS: on the Hedera JSON-RPC relay a transaction's `value` is in weibars, 1 HBAR = 1e18 weibar. The network's own unit is the
 * tinybar, 1 HBAR = 1e8 tinybar, so tinybars = weibars / 1e10. A value that is not a whole number of tinybars is rounded DOWN.
 */

export const WEIBAR_PER_TINYBAR = 10n ** 10n;
export const MIN_DEPOSIT_TINYBARS = 1_000_000; // 0.01 HBAR: stops dust from filling the ledger

export class DepositError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: "not_configured" | "invalid_tx" | "pending" | "not_found" | "failed" | "wrong_recipient" | "wrong_sender" | "self_deposit" | "wrong_chain" | "too_small" | "already_credited" | "rpc_unavailable",
    message: string,
  ) {
    super(message);
    this.name = "DepositError";
  }
}

/** Where users send their HBAR: AGENT_DEPOSIT_ADDRESS, or the EVM address of the agent key. */
export function depositAddress(): string | null {
  const env = getEnv();
  if (env.AGENT_DEPOSIT_ADDRESS) return getAddress(env.AGENT_DEPOSIT_ADDRESS);
  if (env.AGENT_PRIVATE_KEY) return privateKeyToAccount(env.AGENT_PRIVATE_KEY as Hex).address;
  return null;
}

export function weibarToTinybar(weibar: bigint): number {
  return Number(weibar / WEIBAR_PER_TINYBAR);
}

async function rpc<T>(method: string, params: unknown[], fetchImpl: typeof fetch): Promise<T | null> {
  let res: Response;
  try {
    res = await fetchImpl(getEnv().HEDERA_RPC_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new DepositError(503, "rpc_unavailable", "could not reach the Hedera JSON-RPC relay: try again in a moment");
  }
  if (!res.ok) throw new DepositError(503, "rpc_unavailable", `the Hedera JSON-RPC relay answered ${res.status}`);
  const body = (await res.json().catch(() => null)) as { result?: T | null; error?: { message?: string } } | null;
  if (!body || body.error) throw new DepositError(503, "rpc_unavailable", `the Hedera JSON-RPC relay returned an error${body?.error?.message ? ` (${body.error.message.slice(0, 100)})` : ""}`);
  return body.result ?? null;
}

interface RpcReceipt {
  status?: string;
  to?: string | null;
  from?: string;
}
interface RpcTx {
  to?: string | null;
  from?: string;
  value?: string;
  chainId?: string;
}

/**
 * Verify a deposit transaction and credit `sender` for it. Idempotent per transaction hash: crediting the same hash twice is
 * refused with already_credited and changes nothing. Returns what was credited and the new balance.
 */
export async function recordDeposit(sender: string, txHash: string, fetchImpl: typeof fetch = fetch): Promise<{ credited: number; balance: number; txHash: string; receiptId: string }> {
  const to = depositAddress();
  if (!to) throw new DepositError(503, "not_configured", "no deposit address is configured on this server (AGENT_PRIVATE_KEY or AGENT_DEPOSIT_ADDRESS)");
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) throw new DepositError(400, "invalid_tx", "a transaction hash is 0x followed by 64 hex characters");
  if (!isAddress(sender)) throw new DepositError(400, "invalid_tx", "invalid sender");

  const receipt = await rpc<RpcReceipt>("eth_getTransactionReceipt", [txHash], fetchImpl);
  if (!receipt) {
    // not mined yet, or a hash that never existed: the caller may retry
    const known = await rpc<RpcTx>("eth_getTransactionByHash", [txHash], fetchImpl);
    throw known ? new DepositError(409, "pending", "the transaction is not confirmed yet: try again in a few seconds") : new DepositError(404, "not_found", "no such transaction on Hedera testnet (yet)");
  }
  if (receipt.status !== "0x1") throw new DepositError(422, "failed", "that transaction failed on chain, so nothing was credited");

  const tx = await rpc<RpcTx>("eth_getTransactionByHash", [txHash], fetchImpl);
  if (!tx || typeof tx.value !== "string" || !tx.to || !tx.from) throw new DepositError(404, "not_found", "the transaction could not be read back");
  if (tx.chainId && BigInt(tx.chainId) !== BigInt(getEnv().HEDERA_CHAIN_ID)) throw new DepositError(422, "wrong_chain", "that transaction is on a different network");
  if (tx.to.toLowerCase() !== to.toLowerCase()) throw new DepositError(422, "wrong_recipient", "that transaction did not pay the Mesh agent wallet");
  if (tx.from.toLowerCase() !== sender.toLowerCase()) throw new DepositError(403, "wrong_sender", "that transaction was sent from a different wallet than the one you signed in with");

  // sending HBAR from the agent wallet to itself moves no money, so it must never become credit
  if (sender.toLowerCase() === to.toLowerCase()) throw new DepositError(422, "self_deposit", "you are signed in with the Mesh agent wallet itself: sending HBAR to yourself moves no money. Connect a different account to deposit");

  const amount = weibarToTinybar(BigInt(tx.value));
  if (amount < MIN_DEPOSIT_TINYBARS) throw new DepositError(422, "too_small", "the minimum deposit is 0.01 HBAR");

  try {
    const { balance, receiptId } = creditDeposit(sender, amount, txHash);
    return { credited: amount, balance, txHash: txHash.toLowerCase(), receiptId };
  } catch (e) {
    if (e instanceof CreditError && e.code === "already_recorded") throw new DepositError(409, "already_credited", "that deposit was already credited");
    throw e;
  }
}
