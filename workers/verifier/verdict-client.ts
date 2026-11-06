import type { Hex } from "viem";
import { verdictMessage } from "@/lib/verifier";

export type VerifierSample = {
  beacon: string;
  seed: string;
  k: number;
  indices: number[];
};

export type FraudReport = {
  tileIndex: number;
  owner: string;
  expectedTileHash: Hex;
  claimedTileHash: Hex;
  proof: Hex[];
};

export type VerdictReport = {
  jobId: Hex;
  result: "ok" | "fraud";
  sample: VerifierSample;
  fraud?: FraudReport | null;
  finalizeTx?: Hex | null;
  fraudTx?: Hex | null;
};

export type VerdictSigner = {
  signMessage: (args: { message: string }) => Promise<Hex>;
};

export async function signVerdictReport(
  signer: VerdictSigner,
  report: VerdictReport,
  timestamp = Math.floor(Date.now() / 1000),
) {
  const signature = await signer.signMessage({
    message: verdictMessage(report.jobId, report.result, timestamp),
  });
  return { ...report, timestamp, signature };
}
