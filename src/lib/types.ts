import { z } from "zod";
import { isAddress } from "viem";
import { JOB_MODES, JOB_STATUSES, JOB_TYPES, RENDER_PRESET_NAMES } from "./constants";
import type { JobMode, JobStatus, JobType, RenderPreset } from "./constants";

export type { JobMode, JobStatus, JobType, RenderPreset };

export const addressSchema = z.string().refine((v) => isAddress(v), "invalid EVM address");
export const jobIdSchema = z.string().regex(/^0x[0-9a-f]{64}$/, "jobId must be 0x + 64 lowercase hex");

/** Body of POST /api/jobs (docs/job-spec.md section 10.1). */
export const createJobBodySchema = z.object({
  type: z.enum(JOB_TYPES).default("render"),
  preset: z.enum(RENDER_PRESET_NAMES).default("small"),
  requester: addressSchema,
  // World ID proof for the `create-job` action. Verified server-side in a later step; accepted but ignored for now.
  worldProof: z.record(z.string(), z.unknown()).optional(),
});
export type CreateJobBody = z.infer<typeof createJobBodySchema>;

export const tileStatusSchema = z.enum(["pending", "assigned", "uploaded", "verified", "failed"]);
export type TileStatus = z.infer<typeof tileStatusSchema>;

export interface Tile {
  index: number;
  owner: string | null;
  status: TileStatus;
  tileHash: string | null;
}

export interface SampleInfo {
  beacon: string;
  seed: string;
  k: number;
  indices: number[];
}

/** The job object from docs/job-spec.md section 2. */
export interface Job {
  jobId: string;
  type: JobType;
  mode: JobMode;
  status: JobStatus;
  requester: string;
  worldNullifier: string | null;
  imageRef: string;
  imageDigest: string;
  inputHash: string;
  params: Record<string, unknown>;
  tileCount: number;
  providers: string[];
  tiles: Tile[];
  merkleRoot: string | null;
  price: string;
  asset: string | null;
  stakeRequired: string;
  timeoutSeconds: number;
  createdAt: number;
  claimTx: string | null;
  finalTx: string | null;
  fraudTx: string | null;
  slashTx: string | null;
  refundTx: string | null;
  releaseTx: string | null;
  receiptTx: string | null;
  hcsSequence: number[];
  sample: SampleInfo | null;
  verdict: "ok" | "fraud" | null;
  inference: { requestId: string; signer: string; digest: string } | null;
}

export const jobStatusSchema = z.enum(JOB_STATUSES);
export const jobModeSchema = z.enum(JOB_MODES);

export type ApiError = { error: string; message?: string; reason?: string };
