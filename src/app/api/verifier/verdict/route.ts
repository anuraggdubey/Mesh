import { connection } from "next/server";
import { ZodError } from "zod";
import { json, jsonError, readJson } from "@/lib/api";
import { applyVerdict, VerdictError } from "@/lib/verifier";

/**
 * POST /api/verifier/verdict: the verifier reports its verdict for a pending job (docs/job-spec.md section 10.3).
 * Body: {jobId, result: "ok"|"fraud", timestamp, signature, sample?, fraud?, finalizeTx?, fraudTx?}
 * `signature` is the verifier key's personal_sign over `mesh-verdict:<jobId>:<result>:<timestamp>`.
 */
export async function POST(req: Request) {
  await connection();
  const read = await readJson(req, 16 * 1024);
  if ("error" in read) return read.error;
  try {
    const job = await applyVerdict(read.value);
    return json({ jobId: job.jobId, status: job.status, verdict: job.verdict });
  } catch (e) {
    if (e instanceof ZodError) return json({ error: "invalid_body", issues: e.issues.map((i) => ({ path: i.path.join("."), message: i.message })) }, 400);
    if (e instanceof VerdictError) return jsonError(e.status, e.code, e.message);
    throw e;
  }
}
