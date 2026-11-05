import { connection } from "next/server";
import { json, jsonError, readJson } from "@/lib/api";
import { registerBodySchema, registerProvider, RegistrationError } from "@/lib/providers";

/**
 * POST /api/providers/register (docs/job-spec.md section 10.2). The caller signs "mesh-register:<nonce>" with
 * personal_sign. Returns a bearer token that is shown once.
 */
export async function POST(req: Request) {
  await connection();
  const read = await readJson(req, 16 * 1024);
  if ("error" in read) return read.error;

  const parsed = registerBodySchema.safeParse(read.value);
  if (!parsed.success) {
    return json({ error: "invalid_body", issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) }, 400);
  }
  try {
    return json(await registerProvider(parsed.data));
  } catch (err) {
    if (err instanceof RegistrationError) {
      const status = err.code === "nonce_replayed" ? 409 : 401;
      return jsonError(status, err.code, err.message);
    }
    throw err;
  }
}
