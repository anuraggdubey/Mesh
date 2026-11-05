// Test helper: a local x402 facilitator (and mirror node) so payment flows can be tested without Hedera.
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeFacilitator {
  url: string;
  supported: boolean;
  verify: "valid" | "invalid";
  settle: "ok" | "fail" | "error";
  calls: { verify: number; settle: number };
  mirror: "ok" | "missing";
  stop: () => Promise<void>;
}

export async function startFakeFacilitator(): Promise<FakeFacilitator> {
  const f = { supported: true, verify: "valid", settle: "ok", calls: { verify: 0, settle: 0 }, mirror: "ok", url: "" } as FakeFacilitator;
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    const send = (status: number, b: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(b));
    };
    if (req.url === "/supported") {
      if (!f.supported) return send(503, { error: "down" });
      return send(200, { kinds: [{ x402Version: 2, scheme: "exact", network: "hedera:testnet", extra: { feePayer: "0.0.9185802" } }], extensions: [], signers: {} });
    }
    if (req.url === "/verify") {
      f.calls.verify += 1;
      return send(200, f.verify === "valid" ? { isValid: true, payer: "0.0.5555" } : { isValid: false, invalidReason: "invalid_exact_hedera_payload_signature_invalid", invalidMessage: "payer signature is invalid" });
    }
    if (req.url === "/settle") {
      f.calls.settle += 1;
      if (f.settle === "error") return send(500, { error: "boom" });
      if (f.settle === "fail") return send(200, { success: false, errorReason: "insufficient_funds", errorMessage: "payer has too little balance", transaction: "", network: body.paymentRequirements?.network ?? "hedera:testnet" });
      return send(200, { success: true, transaction: "0.0.9185802@1793900000.123456789", network: "hedera:testnet", payer: "0.0.5555" });
    }
    if (req.url?.startsWith("/api/v1/accounts/")) {
      if (f.mirror === "missing") return send(404, { _status: { messages: [{ message: "Not found" }] } });
      return send(200, { account: "0.0.777" });
    }
    send(404, {});
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  f.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  f.stop = () => new Promise<void>((r) => server.close(() => r()));
  return f;
}
