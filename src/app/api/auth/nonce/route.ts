import { connection } from "next/server";
import { z } from "zod";
import { json, jsonError, parseBody } from "@/lib/api";
import { rateLimit } from "@/lib/rate-limit";
import { issueNonce, SessionError } from "@/lib/session";
import { addressSchema } from "@/lib/types";

/** POST /api/auth/nonce {address}: the message a wallet signs to sign in. Single use, valid for 5 minutes. */
export async function POST(req: Request) {
  await connection();
  const body = await parseBody(req, z.object({ address: addressSchema }), 1024);
  if ("error" in body) return body.error;
  const limit = rateLimit(`nonce:${body.data.address.toLowerCase()}`, 20, 60);
  if (!limit.ok) return jsonError(429, "rate_limited", "too many sign-in requests: wait a moment", { reason: `retry in ${limit.retryAfter}s` });
  try {
    return json(issueNonce(body.data.address));
  } catch (e) {
    if (e instanceof SessionError) return jsonError(e.status, e.code, e.message);
    throw e;
  }
}
