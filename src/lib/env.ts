import { z } from "zod";
import { isAddress } from "viem";

// Treat empty strings (".env" lines like `FOO=`) as "not set".
const blank = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);

const address = z.preprocess(
  blank,
  z
    .string()
    .refine((v) => isAddress(v), "must be an EVM address")
    .optional(),
);

const schema = z.object({
  DATA_DIR: z.preprocess(blank, z.string().default("./data")),
  API_PUBLIC_URL: z.preprocess(blank, z.string().url().default("http://localhost:3000")),

  HEDERA_RPC_URL: z.preprocess(blank, z.string().url().default("https://testnet.hashio.io/api")),
  HEDERA_CHAIN_ID: z.preprocess(blank, z.coerce.number().int().positive().default(296)),

  RECEIPT_ADDRESS: address,
  STAKE_ADDRESS: address,
  ESCROW_ADDRESS: address,
  PAYMENT_TOKEN_ADDRESS: address,

  // Backend wallet that calls the contracts' onlyApi functions (registerProvider, lock, postClaim, ...). SECRET.
  API_PRIVATE_KEY: z.preprocess(
    (v) => {
      const s = blank(v);
      return typeof s === "string" && /^[0-9a-fA-F]{64}$/.test(s) ? `0x${s}` : s;
    },
    z
      .string()
      .regex(/^0x[0-9a-fA-F]{64}$/, "must be a 32-byte hex private key")
      .optional(),
  ),

  MIN_STAKE_WEI: z.preprocess(blank, z.string().regex(/^\d+$/).default("500000000000000000")),
  JOB_TIMEOUT_SECONDS: z.preprocess(blank, z.coerce.number().int().positive().default(120)),
  UNPAID_JOB_TTL_SECONDS: z.preprocess(blank, z.coerce.number().int().positive().default(300)),

  // Image the providers must run for `render` jobs. Misbah sets the real digest once the image is built.
  RENDER_IMAGE_REF: z.preprocess(blank, z.string().default("mesh/render:dev")),
  RENDER_IMAGE_DIGEST: z.preprocess(blank, z.string().regex(/^sha256:[0-9a-f]{64}$/).default(`sha256:${"0".repeat(64)}`)),

  // ── World ID (IDKit): provider uniqueness. Portal: developer.world.org ──
  NEXT_PUBLIC_WORLD_APP_ID: z.preprocess(blank, z.string().optional()),
  WORLD_RP_ID: z.preprocess(blank, z.string().optional()),
  WORLD_SIGNING_KEY: z.preprocess(blank, z.string().regex(/^(0x)?[0-9a-fA-F]{64}$/, "must be a 32-byte hex key").optional()), // SECRET
  // Pinned on the server so a client cannot pick "staging"/"sandbox" (which accept test proofs). Use "staging" with the simulator.
  WORLD_ENVIRONMENT: z.preprocess(blank, z.enum(["production", "staging"]).default("production")),
  WORLD_VERIFY_BASE_URL: z.preprocess(blank, z.string().url().default("https://developer.world.org")),

  // ── World IdP "Agent Pass" (human checkpoint / device grant). Portal: auth.world.org/portal ──
  WORLD_IDP_ISSUER: z.preprocess(blank, z.string().url().default("https://auth.world.org")),
  WORLD_IDP_CLIENT_ID: z.preprocess(blank, z.string().optional()),
  WORLD_IDP_CLIENT_SECRET: z.preprocess(blank, z.string().optional()), // SECRET
  WORLD_IDP_ALLOWED_ACR: z.preprocess(blank, z.string().default("https://world.org/oidc/acr/orb")), // comma separated
  // A job priced above this (smallest token unit) needs a fresh human approval. Empty = no approval required.
  AGENT_APPROVAL_THRESHOLD: z.preprocess(blank, z.string().regex(/^[0-9]+$/).optional()),
  // The approval's World authentication must be at most this old (seconds)
  AGENT_APPROVAL_MAX_AGE_SECONDS: z.preprocess(blank, z.coerce.number().int().positive().default(300)),

  // Dev only: register providers on chain WITHOUT a World ID proof (a derived placeholder nullifier is used).
  // NEVER enable in the demo or production: it defeats the one-human-one-provider rule.
  MESH_DEV_SKIP_WORLD: z.preprocess(blank, z.enum(["true", "false"]).default("false")).transform((v) => v === "true"),

  // Turn on the chain loop (lock escrow, post claims, finalize) and make assignment eligibility-aware. Off by default so the
  // mock provider and unit tests work without a chain.
  MESH_CHAIN_LOOP: z.preprocess(blank, z.enum(["true", "false"]).default("false")).transform((v) => v === "true"),
  CHAIN_TICK_SECONDS: z.preprocess(blank, z.coerce.number().int().min(1).max(60).default(3)),
  // Dev only: finalize without a verifier verdict. NEVER enable in the demo: it pays out without any spot-check.
  MESH_DEV_AUTO_APPROVE: z.preprocess(blank, z.enum(["true", "false"]).default("false")).transform((v) => v === "true"),

  // Dev only: skip the x402 payment step and mark new jobs as paid. NEVER enable in the demo or in production.
  MESH_DEV_SKIP_PAYMENT: z.preprocess(blank, z.enum(["true", "false"]).default("false")).transform((v) => v === "true"),
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

/** Parse and validate environment variables once. Throws a readable error listing every bad variable. */
export function getEnv(): Env {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`);
    throw new Error(`Invalid environment configuration:\n${lines.join("\n")}`);
  }
  cached = parsed.data;
  return cached;
}

/** For tests: drop the cached value so changed process.env is re-read. */
export function resetEnvCache(): void {
  cached = undefined;
}
