import { connection } from "next/server";
import { json, jsonError, readJson } from "@/lib/api";
import { requireProvider } from "@/lib/provider-auth";
import { heartbeatBodySchema, touchProvider } from "@/lib/providers";

/** POST /api/providers/heartbeat: {load?, currentTask?}. Providers send this every few seconds. */
export async function POST(req: Request) {
  await connection();
  const auth = requireProvider(req);
  if ("error" in auth) return auth.error;

  const read = await readJson(req, 4 * 1024);
  if ("error" in read) return read.error;
  const parsed = heartbeatBodySchema.safeParse(read.value);
  if (!parsed.success) return jsonError(400, "invalid_body", parsed.error.issues[0]?.message);

  touchProvider(auth.provider.address, { load: parsed.data.load ?? null, currentTask: parsed.data.currentTask ?? null });
  return json({ ok: true });
}
