import { connection } from "next/server";
import { z } from "zod";
import { json, jsonError, parseBody } from "@/lib/api";
import { tinybarsToHbar } from "@/lib/credits";
import { DepositError, recordDeposit } from "@/lib/deposits";
import { rateLimit } from "@/lib/rate-limit";
import { requireSession } from "@/lib/session";
import { hashscan } from "@/lib/ui/format";

/**
 * POST /api/wallet/deposit {txHash}: credit a deposit. The server reads the transaction from the Hedera JSON-RPC relay and checks
 * it paid the agent wallet from the signed-in address; the amount comes from the chain, never from the client. Safe to repeat:
 * 409 `pending` means "not confirmed yet, ask again"; 409 `already_credited` means it was counted before.
 */
export async function POST(req: Request) {
  await connection();
  const session = await requireSession(req);
  if ("error" in session) return session.error;
  const body = await parseBody(req, z.object({ txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/, "a transaction hash is 0x followed by 64 hex characters") }), 1024);
  if ("error" in body) return body.error;
  const limit = rateLimit(`deposit:${session.address}`, 30, 60);
  if (!limit.ok) return jsonError(429, "rate_limited", "too many deposit checks: wait a moment", { reason: `retry in ${limit.retryAfter}s` });
  try {
    const r = await recordDeposit(session.address, body.data.txHash);
    return json({ credited: true, creditedTinybars: r.credited, creditedHbar: tinybarsToHbar(r.credited), balanceTinybars: r.balance, balanceHbar: tinybarsToHbar(r.balance), receiptId: r.receiptId, receiptUrl: `/receipts/${r.receiptId}`, hashscan: hashscan.tx(r.txHash) });
  } catch (e) {
    if (e instanceof DepositError) return jsonError(e.status, e.code, e.message);
    throw e;
  }
}
