import { connection } from "next/server";
import { jsonError } from "@/lib/api";
import { getJob, listEvents } from "@/lib/jobs";
import { isTerminal } from "@/lib/state-machine";
import { jobIdSchema } from "@/lib/types";

const POLL_MS = 500;
const HEARTBEAT_MS = 15_000;

/**
 * GET /api/jobs/:id/events (docs/job-spec.md section 10.4): Server-Sent Events. Replays every past event on connect
 * (or after `Last-Event-ID` / `?after=`), then streams new ones. A comment heartbeat goes out every 15 s.
 * The stream ends once the job reaches a terminal status and its events are flushed.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  await connection();
  const { id } = await ctx.params;
  if (!jobIdSchema.safeParse(id).success) return jsonError(400, "invalid_job_id");
  if (!getJob(id)) return jsonError(404, "job_not_found");

  let lastId = Number(req.headers.get("last-event-id") ?? new URL(req.url).searchParams.get("after") ?? "0") || 0;
  const enc = new TextEncoder();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (chunk: string) => {
        if (!closed) controller.enqueue(enc.encode(chunk));
      };
      const close = () => {
        if (closed) return;
        closed = true;
        if (timer) clearTimeout(timer);
        try {
          controller.close();
        } catch {
          // already closed
        }
      };
      let lastBeat = Date.now();

      const tick = () => {
        if (closed) return;
        try {
          for (const e of listEvents(id, lastId)) {
            lastId = e.id;
            send(`id: ${e.id}\nevent: ${e.type}\ndata: ${JSON.stringify(e.data)}\n\n`);
            lastBeat = Date.now();
          }
          const job = getJob(id);
          if (job && isTerminal(job.status) && listEvents(id, lastId).length === 0) {
            close();
            return;
          }
          if (Date.now() - lastBeat >= HEARTBEAT_MS) {
            send(": heartbeat\n\n");
            lastBeat = Date.now();
          }
        } catch {
          close();
          return;
        }
        timer = setTimeout(tick, POLL_MS);
      };

      req.signal.addEventListener("abort", close);
      tick();
    },
    cancel() {
      closed = true;
      if (timer) clearTimeout(timer);
    },
  });

  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-store, no-transform", connection: "keep-alive" },
  });
}
