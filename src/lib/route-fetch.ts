// Test helper: route fetch() calls straight into the Next.js route handlers (no network), so a ProviderClient can talk
// to the API in-process. Import it only from *.test.ts files that `vi.mock("next/server", ...)` first.
import { POST as jobsPost, GET as jobsList } from "@/app/api/jobs/route";
import { GET as jobGet } from "@/app/api/jobs/[id]/route";
import { GET as inputGet } from "@/app/api/jobs/[id]/input/route";
import { GET as tileGet, PUT as tilePut } from "@/app/api/jobs/[id]/tiles/[index]/route";
import { POST as claimPost } from "@/app/api/jobs/[id]/claim/route";
import { POST as failurePost } from "@/app/api/jobs/[id]/failure/route";
import { GET as eventsGet } from "@/app/api/jobs/[id]/events/route";
import { GET as receiptGet } from "@/app/api/receipts/[jobId]/route";
import { GET as providersList } from "@/app/api/providers/route";
import { POST as registerPost } from "@/app/api/providers/register/route";
import { POST as heartbeatPost } from "@/app/api/providers/heartbeat/route";
import { GET as tasksGet } from "@/app/api/providers/tasks/route";

export const BASE = "http://mesh.test";

export async function routeFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = new URL(typeof input === "string" || input instanceof URL ? input.toString() : input.url);
  const req = new Request(url, init);
  const p = url.pathname;
  const m = req.method;
  const id = (re: RegExp) => re.exec(p)?.slice(1) ?? null;
  const ctx = (params: Record<string, string>) => ({ params: Promise.resolve(params) }) as never;

  if (p === "/api/jobs") return m === "POST" ? jobsPost(req) : jobsList();
  if (p === "/api/providers") return providersList();
  if (p === "/api/providers/register") return registerPost(req);
  if (p === "/api/providers/heartbeat") return heartbeatPost(req);
  if (p === "/api/providers/tasks") return tasksGet(req);
  let g: string[] | null;
  if ((g = id(/^\/api\/receipts\/([^/]+)$/))) return receiptGet(req, ctx({ jobId: g[0] }));
  if ((g = id(/^\/api\/jobs\/(0x[0-9a-f]+)$/))) return jobGet(req, ctx({ id: g[0] }));
  if ((g = id(/^\/api\/jobs\/([^/]+)\/input$/))) return inputGet(req, ctx({ id: g[0] }));
  if ((g = id(/^\/api\/jobs\/([^/]+)\/claim$/))) return claimPost(req, ctx({ id: g[0] }));
  if ((g = id(/^\/api\/jobs\/([^/]+)\/failure$/))) return failurePost(req, ctx({ id: g[0] }));
  if ((g = id(/^\/api\/jobs\/([^/]+)\/events$/))) return eventsGet(req, ctx({ id: g[0] }));
  if ((g = id(/^\/api\/jobs\/([^/]+)\/tiles\/([^/]+)$/))) {
    return m === "PUT" ? tilePut(req, ctx({ id: g[0], index: g[1] })) : tileGet(req, ctx({ id: g[0], index: g[1] }));
  }
  return new Response(JSON.stringify({ error: "no_route", path: p }), { status: 404 });
}
