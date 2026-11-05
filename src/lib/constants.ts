// Shared constants. Must match docs/job-spec.md (sections 4, 13).

export const JOB_TYPES = ["render", "matmul", "infer", "echo"] as const;
export type JobType = (typeof JOB_TYPES)[number];

export const JOB_MODES = ["deterministic", "attested"] as const;
export type JobMode = (typeof JOB_MODES)[number];

export const JOB_STATUSES = [
  "created",
  "paid",
  "assigned",
  "running",
  "pending",
  "final",
  "challenged", // reserved, unused in v1
  "rejected",
  "slashed",
  "refunded",
  "expired",
  "failed",
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const TILE_COUNT_DEFAULT = 64;
export const SAMPLE_RATE = 0.25;
export const CHALLENGE_WINDOW_SECONDS = 45;
export const HEARTBEAT_SECONDS = 5;
export const PROVIDER_OFFLINE_AFTER_SECONDS = 20;
export const MAX_TILE_UPLOAD_BYTES = 1024 * 1024;
export const MAX_INPUT_BYTES = 64 * 1024;

/** Render parameters shared by every preset. Q31.32 fixed-point decimal strings (value * 2^32). */
export const RENDER_X0 = "-8589934592"; // -2.0
export const RENDER_Y0 = "-6442450944"; // -1.5

export const RENDER_PRESETS = {
  tiny: { width: 64, height: 64, gridCols: 2, gridRows: 2, maxIter: 500, step: "201326592" },
  small: { width: 2048, height: 2048, gridCols: 8, gridRows: 8, maxIter: 6000, step: "6291456" },
  // Measured by Misbah (docs/QA.md): small ~4 s, full ~29 s for all 64 tiles on the provider machine
  full: { width: 2048, height: 2048, gridCols: 8, gridRows: 8, maxIter: 48000, step: "6291456" },
} as const;
export type RenderPreset = keyof typeof RENDER_PRESETS;
export const RENDER_PRESET_NAMES = Object.keys(RENDER_PRESETS) as [RenderPreset, ...RenderPreset[]];

/** Price per preset in the payment token's smallest unit (MockStable has 6 decimals). */
export const RENDER_PRICE: Record<RenderPreset, string> = {
  tiny: "100000", // 0.1
  small: "500000", // 0.5
  full: "1000000", // 1.0
};

export const GENESIS_ADDRESS = "0x0000000000000000000000000000000000000000";
