import { connection } from "next/server";
import { json } from "@/lib/api";
import { cookieHeader } from "@/lib/session";

/** POST /api/auth/logout: clears the session cookie. */
export async function POST() {
  await connection();
  return json({ ok: true }, 200, { "set-cookie": cookieHeader(null) });
}
