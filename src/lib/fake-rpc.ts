// Test helper: a local Hedera JSON-RPC relay that answers eth_getTransactionReceipt and eth_getTransactionByHash.
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeTx {
  from: string;
  to: string | null;
  /** hex weibars (1 HBAR = 1e18 weibar) */
  value: string;
  chainId?: string;
  status?: "0x1" | "0x0";
  /** false = known to the node but not mined yet (no receipt) */
  mined?: boolean;
}

export interface FakeRpc {
  url: string;
  txs: Map<string, FakeTx>;
  mode: "ok" | "down" | "error";
  calls: string[];
  stop: () => Promise<void>;
}

export const hbarToWeibarHex = (hbar: number): string => "0x" + (BigInt(Math.round(hbar * 1e8)) * 10n ** 10n).toString(16);

export async function startFakeRpc(): Promise<FakeRpc> {
  const f = { txs: new Map<string, FakeTx>(), mode: "ok", calls: [], url: "" } as unknown as FakeRpc;
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString() || "{}") as { id?: number; method?: string; params?: string[] };
    f.calls.push(String(body.method));
    const reply = (status: number, b: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(b));
    };
    if (f.mode === "down") return reply(503, { error: "down" });
    if (f.mode === "error") return reply(200, { jsonrpc: "2.0", id: body.id, error: { code: -32000, message: "boom" } });
    const hash = (body.params?.[0] ?? "").toLowerCase();
    const tx = f.txs.get(hash);
    if (body.method === "eth_getTransactionReceipt") {
      if (!tx || tx.mined === false) return reply(200, { jsonrpc: "2.0", id: body.id, result: null });
      return reply(200, { jsonrpc: "2.0", id: body.id, result: { status: tx.status ?? "0x1", from: tx.from, to: tx.to } });
    }
    if (body.method === "eth_getTransactionByHash") {
      if (!tx) return reply(200, { jsonrpc: "2.0", id: body.id, result: null });
      return reply(200, { jsonrpc: "2.0", id: body.id, result: { from: tx.from, to: tx.to, value: tx.value, chainId: tx.chainId ?? "0x128" } });
    }
    reply(200, { jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "method not found" } });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  f.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  f.stop = () =>
    new Promise<void>((r) => {
      server.closeAllConnections();
      server.close(() => r());
    });
  return f;
}
