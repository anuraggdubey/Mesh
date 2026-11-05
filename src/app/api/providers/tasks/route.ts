import { connection } from "next/server";
import { json } from "@/lib/api";
import { assignPending } from "@/lib/assign";
import { deliverTasks } from "@/lib/matcher";
import { requireProvider } from "@/lib/provider-auth";
import { touchProvider } from "@/lib/providers";

const MAX_WAIT_SECONDS = 25;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * GET /api/providers/tasks?wait=20: long-poll for work. Returns {tasks: Task[]}, empty after `wait` seconds
 * (default 0, max 25). Polling also counts as a heartbeat and triggers assignment of waiting jobs.
 */
export async function GET(req: Request) {
  await connection();
  const auth = requireProvider(req);
  if ("error" in auth) return auth.error;

  const raw = Number(new URL(req.url).searchParams.get("wait") ?? "0");
  const waitMs = Math.min(Math.max(Number.isFinite(raw) ? raw : 0, 0), MAX_WAIT_SECONDS) * 1000;
  const deadline = Date.now() + waitMs;

  for (;;) {
    touchProvider(auth.provider.address);
    await assignPending();
    const tasks = deliverTasks(auth.provider.address);
    if (tasks.length > 0 || Date.now() >= deadline || req.signal.aborted) return json({ tasks });
    await sleep(500);
  }
}
