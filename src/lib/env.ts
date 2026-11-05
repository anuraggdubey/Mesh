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

  MIN_STAKE_WEI: z.preprocess(blank, z.string().regex(/^\d+$/).default("500000000000000000")),
  JOB_TIMEOUT_SECONDS: z.preprocess(blank, z.coerce.number().int().positive().default(120)),
  UNPAID_JOB_TTL_SECONDS: z.preprocess(blank, z.coerce.number().int().positive().default(300)),

  // Image the providers must run for `render` jobs. Misbah sets the real digest once the image is built.
  RENDER_IMAGE_REF: z.preprocess(blank, z.string().default("mesh/render:dev")),
  RENDER_IMAGE_DIGEST: z.preprocess(blank, z.string().regex(/^sha256:[0-9a-f]{64}$/).default(`sha256:${"0".repeat(64)}`)),

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
