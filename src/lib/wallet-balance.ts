import { getEnv } from "./env";

/** App-side cap for a balance read. The mirror node usually answers in well under a second; the JSON-RPC relay is only a fallback. */
export const WALLET_BALANCE_BUDGET_MS = 12_000;
const MIRROR_ATTEMPT_MS = 4_000;
const WEIBAR_PER_TINYBAR = 10n ** 10n;

/** Same four-decimal display the JSON-RPC path used: truncate, then drop trailing zeros. */
export function formatWalletHbar(tinybars: bigint): string {
  const whole = tinybars / 100_000_000n;
  const frac = (tinybars % 100_000_000n).toString().padStart(8, "0").slice(0, 4).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

/**
 * The wallet's own HBAR on Hedera testnet, shortened for display.
 * Reads the mirror node first (tinybars, one short request). Falls back to a single aborted eth_getBalance.
 * Null when neither source answers inside `timeoutMs`. An unknown account is 0, not an error.
 */
export async function walletHbar(address: string, timeoutMs = WALLET_BALANCE_BUDGET_MS): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  const left = () => Math.max(0, deadline - Date.now());
  const fromMirror = await mirrorTinybars(address, Math.min(left(), MIRROR_ATTEMPT_MS));
  if (fromMirror !== null) return formatWalletHbar(fromMirror);
  if (left() < 50) return null;
  const wei = await rpcWei(address, left());
  if (wei === null) return null;
  return formatWalletHbar(wei / WEIBAR_PER_TINYBAR);
}

/** bigint balance, or null when the mirror node did not give one and the caller should try the relay. */
async function mirrorTinybars(address: string, timeoutMs: number): Promise<bigint | null> {
  if (timeoutMs < 50) return null;
  let res: Response;
  try {
    res = await fetch(`${getEnv().MIRROR_NODE_URL.replace(/\/$/, "")}/api/v1/accounts/${address.toLowerCase()}`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return null;
  }
  // 404 means the mirror has not indexed this account yet. Fall through to the relay instead of showing a false 0.
  if (res.status === 404 || !res.ok) return null;
  const match = /"balance"\s*:\s*\{\s*"balance"\s*:\s*(\d+)/.exec(await res.text());
  return match ? BigInt(match[1]) : null;
}

/** One eth_getBalance. No retry loop: a 502 from the relay must not be multiplied into minutes. */
async function rpcWei(address: string, timeoutMs: number): Promise<bigint | null> {
  try {
    const res = await fetch(getEnv().HEDERA_RPC_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getBalance", params: [address, "latest"] }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { result?: string; error?: unknown };
    if (body.error || typeof body.result !== "string" || !/^0x[0-9a-fA-F]+$/.test(body.result)) return null;
    return BigInt(body.result);
  } catch {
    return null;
  }
}
