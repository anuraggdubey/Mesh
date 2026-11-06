import { formatEther } from "viem";
import type { Address } from "viem";
import { publicClient } from "./chain";

/** The wallet's own HBAR balance on chain (JSON-RPC side: 18 decimals), shortened for display. Null if the RPC does not answer in time. */
export async function walletHbar(address: string, timeoutMs = 6000): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const wei = await Promise.race([
      publicClient().getBalance({ address: address as Address }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
      }),
    ]);
    const [whole, frac = ""] = formatEther(wei).split(".");
    const short = frac.slice(0, 4).replace(/0+$/, "");
    return short ? `${whole}.${short}` : whole;
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
