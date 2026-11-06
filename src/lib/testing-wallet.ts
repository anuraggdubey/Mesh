// Test helper: sign a wallet in through the real route handlers and return the session cookie.
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { POST as noncePost } from "@/app/api/auth/nonce/route";
import { POST as verifyPost } from "@/app/api/auth/verify/route";

export const USER_KEY = ("0x" + "21".repeat(32)) as Hex;
export const OTHER_KEY = ("0x" + "32".repeat(32)) as Hex;
export const user = privateKeyToAccount(USER_KEY);
export const other = privateKeyToAccount(OTHER_KEY);

export const post = (url: string, body: unknown, cookie?: string) =>
  new Request(`http://localhost:3000${url}`, { method: "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });

export const get = (url: string, cookie?: string) => new Request(`http://localhost:3000${url}`, { headers: cookie ? { cookie } : {} });

/** The `name=value` part of a Set-Cookie header, ready to send back as a Cookie header. */
export const cookiePair = (res: Response): string => (res.headers.get("set-cookie") ?? "").split(";")[0];

export async function signIn(account = user): Promise<string> {
  const n = await (await noncePost(post("/api/auth/nonce", { address: account.address }))).json();
  const signature = await account.signMessage({ message: n.message });
  const res = await verifyPost(post("/api/auth/verify", { address: account.address, nonce: n.nonce, signature }));
  if (res.status !== 200) throw new Error(`sign-in failed: ${res.status} ${await res.text()}`);
  return cookiePair(res);
}
