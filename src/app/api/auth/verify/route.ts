import { connection } from "next/server";
import { z } from "zod";
import { json, jsonError, parseBody } from "@/lib/api";
import { getBalance, tinybarsToHbar } from "@/lib/credits";
import { cookieHeader, issueSession, SessionError, verifySignIn } from "@/lib/session";
import { addressSchema } from "@/lib/types";

/** POST /api/auth/verify {address, nonce, signature}: checks the signature and sets the HttpOnly session cookie. */
export async function POST(req: Request) {
  await connection();
  const body = await parseBody(req, z.object({ address: addressSchema, nonce: z.string().regex(/^[0-9a-f]{32}$/), signature: z.string().regex(/^0x[0-9a-fA-F]{130,}$/) }), 2048);
  if ("error" in body) return body.error;
  try {
    const address = await verifySignIn(body.data);
    const token = await issueSession(address);
    const balance = getBalance(address);
    return json({ address, balanceTinybars: balance, balanceHbar: tinybarsToHbar(balance) }, 200, { "set-cookie": cookieHeader(token) });
  } catch (e) {
    if (e instanceof SessionError) return jsonError(e.status, e.code, e.message);
    throw e;
  }
}
