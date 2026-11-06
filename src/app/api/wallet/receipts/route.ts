import { connection } from "next/server";
import { json } from "@/lib/api";
import { listReceipts } from "@/lib/receipt";
import { requireSession } from "@/lib/session";

/** GET /api/wallet/receipts: the signed-in wallet's receipts (deposits, job payments, refunds), newest first. */
export async function GET(req: Request) {
  await connection();
  const session = await requireSession(req);
  if ("error" in session) return session.error;
  return json({ receipts: listReceipts(session.address) });
}
