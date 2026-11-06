import type { Eip1193 } from "./wallet-discovery";
import { pollWithin } from "@/lib/poll-budget";

/** How long the page keeps asking the server about a deposit that the wallet has already sent. */
export const DEPOSIT_CONFIRM_BUDGET_MS = 12_000;

export interface WalletReply {
  ok: boolean;
  data: {
    error?: string;
    message?: string;
    nonce?: string;
    creditedHbar?: string;
    balanceHbar?: string;
    receiptId?: string;
    receiptUrl?: string;
  };
}

export interface WalletPost {
  (url: string, body: unknown): Promise<WalletReply>;
}

/** The account the wallet is willing to use. This request is the user's approval, not a chain call we can skip. */
export async function requestWalletAccount(eth: Eip1193): Promise<string> {
  const accounts = (await eth.request({ method: "eth_requestAccounts" })) as string[];
  const address = accounts?.[0];
  if (!address) throw new Error("the wallet returned no account");
  return address;
}

/**
 * Sign-in is a personal_sign of a server nonce. It is not a transaction, so it must not wait for
 * wallet_switchEthereumChain or wallet_addEthereumChain. Those calls make the wallet talk to the
 * JSON-RPC relay, and that relay is what makes connect and signing sit for minutes.
 */
export async function signWalletLogin(eth: Eip1193, address: string, post: WalletPost): Promise<void> {
  const n = await post("/api/auth/nonce", { address });
  if (!n.ok || !n.data.message || !n.data.nonce) throw new Error(n.data.message ?? n.data.error ?? "could not start sign-in");
  const signature = (await eth.request({ method: "personal_sign", params: [n.data.message, address] })) as string;
  const v = await post("/api/auth/verify", { address, nonce: n.data.nonce, signature });
  if (!v.ok) throw new Error(v.data.message ?? v.data.error ?? "sign-in failed");
}

async function readChainId(eth: Eip1193): Promise<string> {
  return ((await eth.request({ method: "eth_chainId" })) as string).toLowerCase();
}

/** Switch the wallet to Hedera before a value transfer. A login signature does not use this. Throws if the wallet is still on another chain, so nothing is sent there. */
export async function ensureHederaChain(eth: Eip1193, chainId: number, rpcUrl: string): Promise<void> {
  const want = `0x${chainId.toString(16)}`;
  if ((await readChainId(eth)) === want) return;
  try {
    await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: want }] });
  } catch (e) {
    const code = (e as { code?: number }).code;
    if (code !== 4902 && code !== -32603) throw e; // 4902: the wallet does not know this chain yet
    await eth.request({
      method: "wallet_addEthereumChain",
      params: [{ chainId: want, chainName: "Hedera Testnet", nativeCurrency: { name: "HBAR", symbol: "HBAR", decimals: 18 }, rpcUrls: [rpcUrl], blockExplorerUrls: ["https://hashscan.io/testnet"] }],
    });
  }
  if ((await readChainId(eth)) !== want) throw new Error(`The wallet is still not on chain ${chainId}. The transfer was not sent.`);
}

export interface ConfirmedDeposit {
  creditedHbar: string;
  balanceHbar: string;
  receiptId: string;
  receiptUrl: string;
}

/**
 * The app stopped waiting. This is not a statement that Hedera has confirmed or rejected the transfer.
 * The same hash can be checked again. Sending a new deposit would move more HBAR.
 */
export class DepositNotConfirmedError extends Error {
  readonly txHash: string;
  constructor(txHash: string) {
    super(`Mesh stopped waiting on ${txHash}. Nothing has been credited yet. The transfer may still confirm on Hedera. Check this same transaction again. Sending another deposit would move more HBAR.`);
    this.name = "DepositNotConfirmedError";
    this.txHash = txHash;
  }
}

/** The server read the transaction and refused to credit it. The hash is kept so the page does not send a second transfer. */
export class DepositRejectedError extends Error {
  readonly txHash: string;
  constructor(txHash: string, message: string) {
    super(message);
    this.name = "DepositRejectedError";
    this.txHash = txHash;
  }
}

/**
 * Ask the server about one transaction until it is credited or the app's own wait is used up.
 * Pending and not-yet-seen are retried. Any other answer stops immediately. This does not send a transaction.
 */
const RETRYABLE_DEPOSIT = new Set(["pending", "not_found", "rpc_unavailable"]);

export async function confirmDeposit(txHash: string, post: WalletPost, opts?: { budgetMs?: number; intervalMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number }): Promise<ConfirmedDeposit> {
  const found = await pollWithin(
    opts?.budgetMs ?? DEPOSIT_CONFIRM_BUDGET_MS,
    async () => {
      let r: WalletReply;
      try {
        r = await post("/api/wallet/deposit", { txHash });
      } catch {
        return undefined; // the request itself failed: try again until the app's wait is used up
      }
      if (r.ok && r.data.creditedHbar && r.data.balanceHbar && r.data.receiptId && r.data.receiptUrl) {
        return { creditedHbar: r.data.creditedHbar, balanceHbar: r.data.balanceHbar, receiptId: r.data.receiptId, receiptUrl: r.data.receiptUrl };
      }
      if (r.ok) throw new DepositRejectedError(txHash, "the deposit response was incomplete");
      if (r.data.error === "already_credited") throw new DepositRejectedError(txHash, "That deposit was already credited. It was not counted again.");
      if (r.data.error && RETRYABLE_DEPOSIT.has(r.data.error)) return undefined;
      throw new DepositRejectedError(txHash, r.data.message ?? r.data.error ?? "the deposit could not be verified");
    },
    opts,
  );
  if (!found) throw new DepositNotConfirmedError(txHash);
  return found;
}
