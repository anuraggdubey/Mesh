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
