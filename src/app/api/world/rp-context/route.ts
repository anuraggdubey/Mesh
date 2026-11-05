import { connection } from "next/server";
import { json, jsonError, readJson } from "@/lib/api";
import { createRpContext, isWorldAction, WorldDeniedError } from "@/lib/world";

/** POST /api/world/rp-context {action}: the values the browser needs for the IDKit widget (signature made server-side). */
export async function POST(req: Request) {
  await connection();
  const read = await readJson(req, 2 * 1024);
  if ("error" in read) return read.error;
  const action = (read.value as { action?: unknown } | null)?.action;
  if (!isWorldAction(action)) return jsonError(400, "unsupported_action", "action must be one of: register-provider");
  try {
    return json(createRpContext(action));
  } catch (e) {
    if (e instanceof WorldDeniedError) return jsonError(e.reason === "not_configured" ? 503 : 400, e.reason, e.message);
    throw e;
  }
}
