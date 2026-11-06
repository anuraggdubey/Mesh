import { connection } from "next/server";
import { json, jsonError } from "@/lib/api";
import { buildReceipt, canRead, shareToken } from "@/lib/receipt";
import { readSession } from "@/lib/session";

/**
 * GET /api/receipts/by-id/:receiptId[?share=token]: one receipt as JSON. Readable by the wallet that owns it (signed in) or by
 * anyone holding the share token. The owner also gets `shareToken` back, to build a link to hand to someone else.
 */
export async function GET(req: Request, ctx: { params: Promise<{ receiptId: string }> }) {
  await connection();
  const { receiptId } = await ctx.params;
  if (!/^rcpt_[0-9a-f]{16}$/.test(receiptId)) return jsonError(400, "invalid_receipt_id");
  const receipt = buildReceipt(receiptId);
  const session = await readSession(req);
  const share = new URL(req.url).searchParams.get("share");
  // not found and not allowed look the same, so receipt ids cannot be probed
  if (!receipt || !canRead(receipt, session, share)) return jsonError(404, "receipt_not_found", "no such receipt, or you do not have access to it");
  const owner = session?.toLowerCase() === receipt.wallet.toLowerCase();
  return json({ ...receipt, ...(owner ? { shareToken: shareToken(receiptId) } : {}) });
}
