// Test helper: a local 0G Router (OpenAI-compatible chat endpoint) and provider signature endpoint.
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";

export const FAKE_OG_KEY = "sk-test-0g-secret-key-123";
const SIGNER_KEY = ("0x" + "5a".repeat(32)) as Hex;
const OTHER_KEY = ("0x" + "7b".repeat(32)) as Hex;
export const FAKE_OG_SIGNER = privateKeyToAccount(SIGNER_KEY).address;

export interface FakeOg {
  url: string; // router base, ends with /v1
  origin: string; // provider origin for the signature endpoint
  mode: "ok" | "rate-limit-once" | "rate-limit-always" | "error" | "html" | "hang";
  tee: boolean | "missing";
  noRequestId: boolean;
  signature: "none" | "good" | "bad-signer" | "unbound" | "http-error";
  answer: string;
  requests: { path: string; auth: string | null; body: Record<string, unknown> | null }[];
  stop: () => Promise<void>;
}

export async function startFakeOg(): Promise<FakeOg> {
  const f = { mode: "ok", tee: true, noRequestId: false, signature: "good", answer: JSON.stringify({ description: "A clean Mandelbrot set with fine spiral detail.", quality: "good", notes: null }), requests: [], url: "", origin: "" } as unknown as FakeOg;
  let limited = 0;
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString();
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
    f.requests.push({ path: req.url ?? "", auth: (req.headers.authorization as string | undefined) ?? null, body });
    const send = (status: number, b: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(b));
    };

    if (req.url === "/v1/chat/completions" && req.method === "POST") {
      if (f.mode === "hang") return; // never answers
      if (f.mode === "rate-limit-always") return send(429, { error: "slow down" }, { "retry-after": "1" });
      if (f.mode === "rate-limit-once" && limited++ === 0) return send(429, { error: "slow down" }, { "retry-after": "1" });
      if (f.mode === "error") return send(503, { error: "down" });
      if (f.mode === "html") {
        res.writeHead(200, { "content-type": "text/html" });
        return res.end("<html>nope</html>");
      }
      const trace: Record<string, unknown> = { provider: "0x" + "ab".repeat(20), billing: { total: "1" } };
      if (!f.noRequestId) trace.request_id = "req_0g_123456";
      if (f.tee !== "missing") trace.tee_verified = f.tee;
      return send(200, { id: "chatcmpl-0g-abc", choices: [{ message: { role: "assistant", content: f.answer } }], x_0g_trace: trace });
    }

    const m = /^\/v1\/proxy\/signature\/([^?]+)/.exec(req.url ?? "");
    if (m) {
      if (f.signature === "none" || f.signature === "http-error") return send(f.signature === "none" ? 404 : 500, { error: "no" });
      const chatId = decodeURIComponent(m[1]);
      const text = f.signature === "unbound" ? "totally unrelated text" : `chat:${chatId}:${f.answer}`;
      const key = f.signature === "bad-signer" ? OTHER_KEY : SIGNER_KEY;
      const signature = await privateKeyToAccount(key).signMessage({ message: text });
      return send(200, { text, signature });
    }
    send(404, {});
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  f.origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  f.url = `${f.origin}/v1`;
  f.stop = () =>
    new Promise<void>((r) => {
      server.closeAllConnections();
      server.close(() => r());
    });
  return f;
}
