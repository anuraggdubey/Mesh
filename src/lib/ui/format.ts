export function shortAddr(addr: string | null | undefined): string {
  if (!addr) return "unassigned";
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function shortHash(h: string | null | undefined, n = 8): string {
  if (!h) return "-";
  const s = h.startsWith("0x") ? h.slice(2) : h;
  return `${s.slice(0, n)}…`;
}

/** Format a token amount held in its smallest unit (`decimals` digits), trimming trailing zeros. */
export function formatToken(amount: string, decimals = 6, symbol = "mUSD"): string {
  if (!/^\d+$/.test(amount)) return `${amount} ${symbol}`;
  const padded = amount.padStart(decimals + 1, "0");
  const whole = padded.slice(0, padded.length - decimals);
  const frac = padded.slice(padded.length - decimals).replace(/0+$/, "");
  return `${whole}${frac ? `.${frac}` : ""} ${symbol}`;
}

export const hashscan = {
  tx: (hash: string) => `https://hashscan.io/testnet/transaction/${hash}`,
  address: (addr: string) => `https://hashscan.io/testnet/account/${addr}`,
  contract: (addr: string) => `https://hashscan.io/testnet/contract/${addr}`,
};

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
