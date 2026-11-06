import { describe, expect, it } from "vitest";
import { verifyMessage } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { signVerdictReport } from "./verdict-client";

const account = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
);
const jobId = `0x${"ab".repeat(32)}` as `0x${string}`;
const sample = {
  beacon: `0x${"01".repeat(32)}`,
  seed: `0x${"02".repeat(32)}`,
  k: 1,
  indices: [0],
};

describe("verifier verdict signing", () => {
  it("signs the API's exact job/result/timestamp message", async () => {
    const report = await signVerdictReport(
      account,
      { jobId, result: "ok", sample },
      1_800_000_000,
    );
    expect(
      await verifyMessage({
        address: account.address,
        message: `mesh-verdict:${jobId}:ok:1800000000`,
        signature: report.signature,
      }),
    ).toBe(true);
    expect(report).toMatchObject({
      jobId,
      result: "ok",
      timestamp: 1_800_000_000,
      sample,
    });
  });

  it("binds fraud and success to separate signatures", async () => {
    const report = await signVerdictReport(
      account,
      { jobId, result: "fraud", sample },
      1_800_000_001,
    );
    expect(
      await verifyMessage({
        address: account.address,
        message: `mesh-verdict:${jobId}:fraud:1800000001`,
        signature: report.signature,
      }),
    ).toBe(true);
    expect(
      await verifyMessage({
        address: account.address,
        message: `mesh-verdict:${jobId}:ok:1800000001`,
        signature: report.signature,
      }),
    ).toBe(false);
  });
});
