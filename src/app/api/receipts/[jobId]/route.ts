import { connection } from "next/server";
import { json, jsonError } from "@/lib/api";
import { chainLoopConfigured, readOnChainReceipt } from "@/lib/chain";
import { getEnv } from "@/lib/env";
import { hashscanTopicUrl } from "@/lib/hcs";
import { getJob } from "@/lib/jobs";
import { hashscanTxUrl } from "@/lib/x402";
import { jobIdSchema } from "@/lib/types";

/**
 * GET /api/receipts/:jobId (docs/job-spec.md section 10.1): the job's hashes and transactions, plus the receipt as the
 * contract holds it (read straight from the chain, so it does not depend on our database).
 */
export async function GET(_req: Request, ctx: { params: Promise<{ jobId: string }> }) {
  await connection();
  const { jobId } = await ctx.params;
  if (!jobIdSchema.safeParse(jobId).success) return jsonError(400, "invalid_job_id", "jobId must be 0x + 64 lowercase hex");
  const job = getJob(jobId);
  if (!job) return jsonError(404, "job_not_found");

  let onChain: Awaited<ReturnType<typeof readOnChainReceipt>> | null = null;
  let onChainError: string | undefined;
  if (chainLoopConfigured()) {
    try {
      onChain = await readOnChainReceipt(jobId);
    } catch (e) {
      onChainError = e instanceof Error ? e.message.split("\n")[0].slice(0, 200) : "chain read failed";
    }
  }

  return json({
    jobId: job.jobId,
    status: job.status,
    type: job.type,
    requester: job.requester,
    providers: job.providers,
    imageDigest: job.imageDigest,
    inputHash: job.inputHash,
    merkleRoot: job.merkleRoot,
    verdict: job.verdict,
    windowEnd: job.windowEnd,
    payment: job.payment ? { ...job.payment, hashscan: hashscanTxUrl(job.payment.transaction, job.payment.network) } : null,
    inference: job.inference
      ? { requestId: job.inference.requestId, provider: job.inference.provider, model: job.inference.model, verification: job.inference.verification, teeVerified: job.inference.teeVerified, signer: job.inference.signer, quality: job.inference.output.quality, digest: job.inference.digest }
      : null,
    hcs: { topicId: getEnv().HCS_TOPIC_ID ?? null, sequences: job.hcsSequence, ...(getEnv().HCS_TOPIC_ID ? { hashscan: hashscanTopicUrl(getEnv().HCS_TOPIC_ID as string) } : {}) },
    transactions: { lock: job.lockTx, claim: job.claimTx, finalize: job.finalTx, release: job.releaseTx, refund: job.refundTx },
    onChain,
    ...(onChainError ? { onChainError } : {}),
  });
}
