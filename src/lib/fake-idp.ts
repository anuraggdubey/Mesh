// Test helper: a local World IdP (OIDC discovery, JWKS, device grant, token) that signs real RS256 ID tokens.
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import type { JWK } from "jose";

export type IdpMode = "pending" | "slow_down" | "denied" | "expired" | "invalid_grant" | "down" | "approved";
type PrivateKey = Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];

export const IDP_CLIENT_ID = "client_test";
export const IDP_CLIENT_SECRET = "worldidp_client_secret_test";

export interface FakeIdp {
  url: string;
  mode: IdpMode;
  claims: Record<string, unknown>;
  signWith: "good" | "other";
  tokenCalls: number;
  deviceCalls: number;
  stop: () => Promise<void>;
  issue: (over?: Record<string, unknown>, opts?: { key?: "good" | "other"; kid?: string }) => Promise<string>;
}

export async function startFakeIdp(): Promise<FakeIdp> {
  const good = await generateKeyPair("RS256");
  const other = await generateKeyPair("RS256");
  const jwk: JWK = { ...(await exportJWK(good.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  const idp = { mode: "approved" as IdpMode, claims: {} as Record<string, unknown>, tokenCalls: 0, deviceCalls: 0, url: "", signWith: "good" as const } as FakeIdp;

  const keyFor = (which: "good" | "other"): PrivateKey => (which === "good" ? good.privateKey : other.privateKey);
  idp.issue = async (over = {}, opts = {}) => {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ acr: "https://world.org/oidc/acr/orb", amr: ["pop"], auth_time: now - 5, ...idp.claims, ...over })
      .setProtectedHeader({ alg: "RS256", kid: opts.kid ?? "k1" })
      .setIssuer(idp.url)
      .setSubject("sub-human-1")
      .setAudience(IDP_CLIENT_ID)
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .sign(keyFor(opts.key ?? idp.signWith));
  };

  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const form = new URLSearchParams(Buffer.concat(chunks).toString());
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const authOk = form.get("client_id") === IDP_CLIENT_ID && form.get("client_secret") === IDP_CLIENT_SECRET;

    if (req.url === "/.well-known/openid-configuration") {
      return send(200, { issuer: idp.url, jwks_uri: `${idp.url}/jwks`, token_endpoint: `${idp.url}/token`, device_authorization_endpoint: `${idp.url}/device` });
    }
    if (req.url === "/jwks") return send(200, { keys: [jwk] });
    if (req.url === "/device") {
      idp.deviceCalls += 1;
      if (!authOk) return send(401, { error: "invalid_client" });
      return send(200, {
        device_code: `dev-${idp.deviceCalls}`,
        user_code: "ABCD-1234",
        verification_uri: "https://world.test/verify",
        verification_uri_complete: "https://world.test/verify?code=ABCD-1234",
        expires_in: 1200,
        interval: 1,
      });
    }
    if (req.url === "/token") {
      idp.tokenCalls += 1;
      if (!authOk) return send(401, { error: "invalid_client" });
      switch (idp.mode) {
        case "pending":
          return send(400, { error: "authorization_pending" });
        case "slow_down":
          return send(400, { error: "slow_down" });
        case "denied":
          return send(400, { error: "access_denied" });
        case "expired":
          return send(400, { error: "expired_token" });
        case "invalid_grant":
          return send(400, { error: "invalid_grant" });
        case "down":
          return send(503, { error: "temporarily_unavailable" });
        case "approved":
          return send(200, { id_token: await idp.issue(), access_token: "opaque", token_type: "Bearer", expires_in: 300 });
      }
    }
    send(404, {});
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  idp.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  idp.stop = () => new Promise<void>((r) => server.close(() => r()));
  return idp;
}
