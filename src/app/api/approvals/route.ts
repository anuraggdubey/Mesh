import { connection } from "next/server";
import { json, jsonError, readJson } from "@/lib/api";
import { AgentPassError } from "@/lib/agentpass";
import { ApprovalError, createApproval, priceFor } from "@/lib/approvals";
import { createJobBodySchema } from "@/lib/types";

/**
 * POST /api/approvals {type, preset, requester}: ask for a human approval of one specific job (World Agent Pass, device
 * grant). The response carries the code and URL the human uses to approve in the World app. Then poll
 * GET /api/approvals/:id and send the approval id as `X-Mesh-Approval` on POST /api/jobs.
 */
export async function POST(req: Request) {
  await connection();
  const read = await readJson(req, 4 * 1024);
  if ("error" in read) return read.error;
  const parsed = createJobBodySchema.safeParse(read.value);
  if (!parsed.success) {
    return json({ error: "invalid_body", issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) }, 400);
  }
  if (parsed.data.type !== "render") return jsonError(501, "unsupported_job_type", `job type "${parsed.data.type}" is not available yet`);

  try {
    const a = await createApproval({
      purpose: "create-job",
      requester: parsed.data.requester,
      type: "render",
      preset: parsed.data.preset,
      price: priceFor(parsed.data.preset),
    });
    return json(a, 201);
  } catch (e) {
    if (e instanceof ApprovalError) return jsonError(e.code === "not_configured" ? 503 : 400, e.code, e.message);
    if (e instanceof AgentPassError) return jsonError(502, e.code, e.message);
    throw e;
  }
}
