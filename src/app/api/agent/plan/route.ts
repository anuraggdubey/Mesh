import { connection } from "next/server";
import { z } from "zod";
import { json, parseBody } from "@/lib/api";
import { RENDER_PRESET_NAMES } from "@/lib/constants";
import { OgError, planJob } from "@/lib/og";
import { createPlan } from "@/lib/plans";
import { planResponse } from "@/lib/plan-view";
import { rateLimit } from "@/lib/rate-limit";
import { requireSession } from "@/lib/session";

const MANUAL = { presets: [...RENDER_PRESET_NAMES] };

/**
 * POST /api/agent/plan: choose the job size for the signed-in user.
 *  - {prompt}: a 0G model reads the user's words and picks a size (request id and verification level are returned and kept).
 *    If 0G cannot answer (no credit, rate limit, outage, a bad answer) the response says so and offers `manual` presets. We never
 *    substitute our own guess and call it 0G.
 *  - {preset}: the user picks a size by hand. The plan is labelled `manual`.
 */
export async function POST(req: Request) {
  await connection();
  const session = await requireSession(req);
  if ("error" in session) return session.error;
  const body = await parseBody(req, z.union([z.object({ prompt: z.string().trim().min(3).max(600) }), z.object({ preset: z.enum(RENDER_PRESET_NAMES) })]), 4 * 1024);
  if ("error" in body) return body.error;

  if ("preset" in body.data) {
    return json({ plan: planResponse(createPlan({ address: session.address, preset: body.data.preset, reason: null, prompt: null, og: null })) });
  }

  const limit = rateLimit(`plan:${session.address}`, 10, 60);
  if (!limit.ok) return json({ error: "rate_limited", message: `the agent can plan ${10} requests a minute: wait ${limit.retryAfter}s or pick a size yourself`, manual: MANUAL }, 429, { "retry-after": String(limit.retryAfter) });

  try {
    const call = await planJob(body.data.prompt);
    return json({ plan: planResponse(createPlan({ address: session.address, preset: call.plan.preset, reason: call.plan.reason, prompt: body.data.prompt, og: call })) });
  } catch (e) {
    if (e instanceof OgError) {
      const status = e.code === "rate_limited" ? 429 : e.code === "timeout" ? 504 : e.code === "bad_response" ? 502 : 503;
      return json({ error: `og_${e.code}`, message: `${e.message}. You can pick a size yourself instead.`, manual: MANUAL }, status);
    }
    throw e;
  }
}
