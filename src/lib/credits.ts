import { randomBytes } from "node:crypto";
import { getDb, transaction } from "./db";

/**
 * Prepaid credit, in tinybars (1 HBAR = 100,000,000). A user deposits HBAR to the agent wallet; the agent then pays x402 for their
 * jobs. Every change is a ledger row, every row is unique per (kind, ref) so a deposit, a hold, a refund or a spend can only happen
 * once, and the balance can never go below zero (also enforced by a CHECK in the table). Every ledger row has a receipt id.
 */

export class CreditError extends Error {
  constructor(
    public readonly code: "insufficient_credit" | "already_recorded" | "invalid_amount",
    message: string,
  ) {
    super(message);
    this.name = "CreditError";
  }
}

const now = () => Math.floor(Date.now() / 1000);
const lc = (a: string) => a.toLowerCase();

export const newReceiptId = (): string => `rcpt_${randomBytes(8).toString("hex")}`;

export function getBalance(address: string): number {
  const row = getDb().prepare("SELECT balance_tinybars AS b FROM credits WHERE address = ?").get(lc(address)) as { b: number } | undefined;
  return row?.b ?? 0;
}

function checkAmount(amount: number): void {
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new CreditError("invalid_amount", "the amount must be a positive whole number of tinybars");
}

/** Insert a ledger row and return its receipt id. A second row with the same (kind, ref) is refused. */
function addLedger(address: string, kind: string, amount: number, ref: string): string {
  const receiptId = newReceiptId();
  try {
    getDb().prepare("INSERT INTO ledger (address, kind, amount, ref, ts, receipt_id) VALUES (?, ?, ?, ?, ?, ?)").run(lc(address), kind, amount, ref, now(), receiptId);
  } catch {
    throw new CreditError("already_recorded", `${kind} ${ref} was already recorded`);
  }
  return receiptId;
}

/** Credit a verified deposit. `txHash` is the unique reference: the same deposit can be credited only once. */
export function creditDeposit(address: string, amount: number, txHash: string): { balance: number; receiptId: string } {
  checkAmount(amount);
  return transaction((db) => {
    const receiptId = addLedger(address, "deposit", amount, txHash.toLowerCase());
    db.prepare("INSERT INTO credits (address, balance_tinybars) VALUES (?, ?) ON CONFLICT(address) DO UPDATE SET balance_tinybars = balance_tinybars + excluded.balance_tinybars").run(lc(address), amount);
    return { balance: getBalance(address), receiptId };
  });
}

/** Take `amount` out of the balance for a run. Throws insufficient_credit (and changes nothing) if it is not all there. */
export function holdCredit(address: string, amount: number, runId: string): { balance: number; receiptId: string } {
  checkAmount(amount);
  return transaction((db) => {
    // the WHERE clause makes the debit conditional, so two runs at once cannot both spend the same credit
    const res = db.prepare("UPDATE credits SET balance_tinybars = balance_tinybars - ? WHERE address = ? AND balance_tinybars >= ?").run(amount, lc(address), amount);
    if (Number(res.changes) !== 1) throw new CreditError("insufficient_credit", "not enough prepaid credit for this job: deposit more HBAR first");
    const receiptId = addLedger(address, "job_hold", amount, runId);
    return { balance: getBalance(address), receiptId };
  });
}

/** Give a held amount back (the run failed). Idempotent: a second call for the same run does nothing. Returns the receipt id, or null if it was already refunded. */
export function refundHold(address: string, amount: number, runId: string): string | null {
  return transaction((db) => {
    let receiptId: string;
    try {
      receiptId = addLedger(address, "job_refund", amount, runId);
    } catch (e) {
      if (e instanceof CreditError && e.code === "already_recorded") return null;
      throw e;
    }
    db.prepare("INSERT INTO credits (address, balance_tinybars) VALUES (?, ?) ON CONFLICT(address) DO UPDATE SET balance_tinybars = balance_tinybars + excluded.balance_tinybars").run(lc(address), amount);
    return receiptId;
  });
}

/** Mark a hold as really spent (the payment settled). Records the fact; the balance already went down when the hold was taken. */
export function markSpent(address: string, amount: number, runId: string): void {
  try {
    addLedger(address, "job_spent", amount, runId);
  } catch (e) {
    if (!(e instanceof CreditError && e.code === "already_recorded")) throw e;
  }
}

export interface LedgerRow {
  id: number;
  address: string;
  kind: "deposit" | "job_hold" | "job_refund" | "job_spent";
  amount: number;
  ref: string;
  ts: number;
  receipt_id: string;
}

export function getLedgerByReceipt(receiptId: string): LedgerRow | null {
  return (getDb().prepare("SELECT * FROM ledger WHERE receipt_id = ?").get(receiptId) as LedgerRow | undefined) ?? null;
}

/** The user's visible history: deposits, job payments and refunds (the internal "spent" marker is not a receipt of its own), newest first. */
export function listLedger(address: string, limit = 50): LedgerRow[] {
  return getDb().prepare("SELECT * FROM ledger WHERE address = ? AND kind != 'job_spent' ORDER BY id DESC LIMIT ?").all(lc(address), limit) as unknown as LedgerRow[];
}

export const tinybarsToHbar = (t: number): string => {
  const whole = Math.floor(t / 1e8);
  const frac = String(t % 1e8).padStart(8, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : String(whole);
};
