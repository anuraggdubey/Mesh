import { connection } from "next/server";
import { json } from "@/lib/api";
import { listProviders, publicProvider } from "@/lib/providers";

/** GET /api/providers: registered providers (public fields only). */
export async function GET() {
  await connection();
  return json({ providers: listProviders().map(publicProvider) });
}
