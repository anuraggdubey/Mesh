import { connection } from "next/server";
import { json, jsonError } from "@/lib/api";
import { getTileBytes, ProtocolError, storeTile } from "@/lib/claims";
import { MAX_TILE_UPLOAD_BYTES } from "@/lib/constants";
import { requireProvider } from "@/lib/provider-auth";
import { jobIdSchema } from "@/lib/types";

type Ctx = { params: Promise<{ id: string; index: string }> };

function parseIndex(raw: string): number | null {
  return /^\d{1,5}$/.test(raw) ? Number(raw) : null;
}

/** GET /api/jobs/:id/tiles/:index: raw tile bytes (public, so the UI can draw the image). */
export async function GET(_req: Request, ctx: Ctx) {
  await connection();
  const { id, index } = await ctx.params;
  const idx = parseIndex(index);
  if (!jobIdSchema.safeParse(id).success || idx === null) return jsonError(400, "invalid_request");
  const bytes = getTileBytes(id, idx);
  if (!bytes) return jsonError(404, "tile_not_found");
  return new Response(new Uint8Array(bytes), {
    headers: { "content-type": "application/octet-stream", "cache-control": "no-store" },
  });
}

/** PUT /api/jobs/:id/tiles/:index (provider only): raw bytes with header X-Tile-Hash = sha256 hex. */
export async function PUT(req: Request, ctx: Ctx) {
  await connection();
  const auth = requireProvider(req);
  if ("error" in auth) return auth.error;
  const { id, index } = await ctx.params;
  const idx = parseIndex(index);
  if (!jobIdSchema.safeParse(id).success || idx === null) return jsonError(400, "invalid_request");

  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > MAX_TILE_UPLOAD_BYTES) return jsonError(413, "bad_tile_size", "tile too large");
  const bytes = Buffer.from(await req.arrayBuffer());

  try {
    const progress = storeTile(id, auth.provider.address, idx, bytes, req.headers.get("x-tile-hash") ?? "");
    return json({ ok: true, ...progress });
  } catch (err) {
    if (err instanceof ProtocolError) return jsonError(err.status, err.code, err.message);
    throw err;
  }
}
