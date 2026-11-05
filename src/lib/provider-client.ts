import { createHash } from "node:crypto";
import type { Hex } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import {
  computeTilesDigest,
  imageDigestToBytes32,
  registerMessage,
  tileClaimTypedData,
  with0x,
} from "./claim";

/**
 * HTTP client for the provider side of the API (docs/job-spec.md section 10.2). Used by the mock provider and by
 * the real provider worker, so both speak exactly the same protocol.
 */

export interface ClientTask {
  taskId: string;
  jobId: string;
  type: string;
  imageRef: string;
  imageDigest: string;
  inputHash: string;
  tiles: number[];
  timeoutSeconds: number;
}

export class ApiRequestError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
    message: string,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

export interface ProviderClientOptions {
  baseUrl: string;
  account: PrivateKeyAccount;
  chainId: number;
  receiptAddress: Hex;
  hardware?: { cores: number; memoryGb: number; os: string; arch: string };
  agentVersion?: string;
}

export class ProviderClient {
  private token: string | null = null;

  constructor(private readonly opts: ProviderClientOptions) {}

  get address(): string {
    return this.opts.account.address;
  }

  private url(path: string) {
    return `${this.opts.baseUrl.replace(/\/$/, "")}/api${path}`;
  }

  private async request(
    path: string,
    init: RequestInit & { auth?: boolean } = {},
  ): Promise<Response> {
    const { auth, ...requestInit } = init;
    const headers = new Headers(init.headers);
    if (auth !== false && this.token)
      headers.set("authorization", `Bearer ${this.token}`);
    const timeoutSignal = AbortSignal.timeout(
      path.startsWith("/providers/tasks?") ? 30_000 : 15_000,
    );
    const signal = requestInit.signal
      ? AbortSignal.any([requestInit.signal, timeoutSignal])
      : timeoutSignal;
    const res = await fetch(this.url(path), {
      ...requestInit,
      headers,
      signal,
    });
    if (!res.ok) {
      let body: unknown = null;
      try {
        body = await res.json();
      } catch {
        // not JSON
      }
      const code =
        body && typeof body === "object" && "error" in body
          ? String((body as { error: unknown }).error)
          : res.statusText;
      throw new ApiRequestError(
        res.status,
        body,
        `${init.method ?? "GET"} ${path} -> ${res.status} ${code}`,
      );
    }
    return res;
  }

  private async json<T>(
    path: string,
    init: RequestInit & { auth?: boolean } = {},
  ): Promise<T> {
    return (await this.request(path, init)).json() as Promise<T>;
  }

  /** Register (or re-register) this wallet and keep the bearer token. */
  async register(signal?: AbortSignal): Promise<{ providerId: string }> {
    const nonce = `${Date.now()}-${createHash("sha256").update(String(Math.random())).digest("hex").slice(0, 16)}`;
    const signature = await this.opts.account.signMessage({
      message: registerMessage(nonce),
    });
    const hw = this.opts.hardware ?? {
      cores: 1,
      memoryGb: 1,
      os: process.platform,
      arch: process.arch,
    };
    const res = await this.json<{ providerId: string; token: string }>(
      "/providers/register",
      {
        method: "POST",
        auth: false,
        signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          address: this.opts.account.address,
          signature,
          nonce,
          cores: hw.cores,
          memoryGb: hw.memoryGb,
          os: hw.os,
          arch: hw.arch,
          agentVersion: this.opts.agentVersion ?? "client-0.1.0",
        }),
      },
    );
    this.token = res.token;
    return { providerId: res.providerId };
  }

  async heartbeat(
    load?: number,
    currentTask?: string | null,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.request("/providers/heartbeat", {
      method: "POST",
      signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ load, currentTask }),
    });
  }

  async pollTasks(
    waitSeconds = 0,
    signal?: AbortSignal,
  ): Promise<ClientTask[]> {
    return (
      await this.json<{ tasks: ClientTask[] }>(
        `/providers/tasks?wait=${waitSeconds}`,
        { signal },
      )
    ).tasks;
  }

  /** The exact job.json bytes (as text) for this provider's tiles of a job. */
  async getInput(jobId: string, signal?: AbortSignal): Promise<string> {
    return (await this.request(`/jobs/${jobId}/input`, { signal })).text();
  }

  async putTile(
    jobId: string,
    index: number,
    bytes: Uint8Array,
    signal?: AbortSignal,
  ): Promise<{ done: number; total: number }> {
    const hash = createHash("sha256").update(bytes).digest("hex");
    return this.json(`/jobs/${jobId}/tiles/${index}`, {
      method: "PUT",
      signal,
      headers: {
        "content-type": "application/octet-stream",
        "x-tile-hash": hash,
      },
      body: Buffer.from(bytes),
    });
  }

  /** Sign and submit the EIP-712 TileClaim over this provider's tiles. */
  async submitClaim(
    task: Pick<ClientTask, "jobId" | "imageDigest" | "inputHash">,
    tiles: { index: number; tileHash: string }[],
    signal?: AbortSignal,
  ) {
    const tilesDigest = computeTilesDigest(tiles);
    const signature = await this.opts.account.signTypedData(
      tileClaimTypedData(
        {
          jobId: task.jobId as Hex,
          imageDigest: imageDigestToBytes32(task.imageDigest),
          inputHash: with0x(task.inputHash),
          provider: this.opts.account.address,
          tilesDigest,
        },
        this.opts.chainId,
        this.opts.receiptAddress,
      ),
    );
    return this.json<{
      ok: boolean;
      claimed: number;
      of: number;
      merkleRoot: string | null;
    }>(`/jobs/${task.jobId}/claim`, {
      method: "POST",
      signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: this.opts.account.address,
        tilesDigest,
        signature,
        tiles,
      }),
    });
  }

  async reportFailure(
    jobId: string,
    reason: string,
    logTail?: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.request(`/jobs/${jobId}/failure`, {
      method: "POST",
      signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: this.opts.account.address,
        reason,
        logTail,
      }),
    });
  }
}
