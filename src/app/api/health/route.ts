import { connection } from "next/server";
import { json } from "@/lib/api";
import { getEnv } from "@/lib/env";

export async function GET() {
  await connection(); // always answer at request time, never prerender
  const env = getEnv();
  return json({ ok: true, version: "0.1.0", chainId: env.HEDERA_CHAIN_ID });
}
