// Test helpers (used only by *.test.ts files).
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { closeDb } from "./db";
import { resetEnvCache } from "./env";

const KEYS = [
  "DATA_DIR",
  "MESH_DEV_SKIP_PAYMENT",
  "ESCROW_ADDRESS",
  "PAYMENT_TOKEN_ADDRESS",
  "API_PUBLIC_URL",
  "UNPAID_JOB_TTL_SECONDS",
] as const;

export const TEST_ESCROW = "0x16eFE46De1CdA06Be455607A63514319aE130010";
export const TEST_TOKEN = "0x9009A5B2070a97aAa81c6EB77A2507273Ba46Ee3";
export const TEST_REQUESTER = "0x6834228cb6F180C05fA2154a2B2670d92c4FDf59";

/** Point the app at a fresh temp database and a known environment. Returns a cleanup function. */
export function useTempEnv(overrides: Partial<Record<(typeof KEYS)[number], string>> = {}): () => void {
  const saved: Record<string, string | undefined> = {};
  for (const k of KEYS) saved[k] = process.env[k];

  const dir = mkdtempSync(path.join(os.tmpdir(), "mesh-test-"));
  process.env.DATA_DIR = dir;
  process.env.MESH_DEV_SKIP_PAYMENT = "false";
  process.env.ESCROW_ADDRESS = TEST_ESCROW;
  process.env.PAYMENT_TOKEN_ADDRESS = TEST_TOKEN;
  process.env.API_PUBLIC_URL = "http://localhost:3000";
  process.env.UNPAID_JOB_TTL_SECONDS = "300";
  for (const [k, v] of Object.entries(overrides)) process.env[k] = v;
  resetEnvCache();
  closeDb();

  return () => {
    closeDb();
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    resetEnvCache();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows can briefly hold the SQLite files; the OS temp cleaner removes leftovers.
    }
  };
}
