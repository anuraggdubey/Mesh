import type { ApiError } from "./types";

/** JSON response helper. */
export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers });
}

/** Error response in the shape documented in docs/job-spec.md section 10: { error, message?, reason? }. */
export function jsonError(status: number, error: string, message?: string, extra: Partial<ApiError> = {}): Response {
  const body: ApiError = { error, ...(message ? { message } : {}), ...extra };
  return Response.json(body, { status });
}

/** Read and parse a JSON request body with a size cap. Returns the value or an error Response. */
export async function readJson(req: Request, maxBytes: number): Promise<{ value: unknown } | { error: Response }> {
  let text: string;
  try {
    text = await req.text();
  } catch {
    return { error: jsonError(400, "invalid_body", "could not read request body") };
  }
  if (Buffer.byteLength(text) > maxBytes) {
    return { error: jsonError(413, "body_too_large", `body exceeds ${maxBytes} bytes`) };
  }
  try {
    return { value: JSON.parse(text) };
  } catch {
    return { error: jsonError(400, "invalid_json", "body is not valid JSON") };
  }
}

/** Read a JSON body and validate it with a zod schema. Returns the data, or an error Response in the standard shape. */
export async function parseBody<T>(req: Request, schema: import("zod").ZodType<T>, maxBytes = 8 * 1024): Promise<{ data: T } | { error: Response }> {
  const read = await readJson(req, maxBytes);
  if ("error" in read) return { error: read.error };
  const parsed = schema.safeParse(read.value);
  if (!parsed.success) {
    return { error: Response.json({ error: "invalid_body", issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) }, { status: 400 }) };
  }
  return { data: parsed.data };
}
