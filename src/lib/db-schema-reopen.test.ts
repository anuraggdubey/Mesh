import { afterEach, describe, expect, it } from "vitest";
import { getDb } from "./db";
import { setupTestEnv } from "./testing";

type Cache = { __meshDb?: { path: string; schema: string; db: unknown } };

describe("database handle cache", () => {
  let cleanup: () => void;
  afterEach(() => cleanup());

  it("reopens a handle that was opened before the schema changed, so new tables exist", () => {
    cleanup = setupTestEnv();
    const first = getDb();
    expect(getDb() === first).toBe(true); // normal case: the same handle is reused

    // simulate a server that opened the database under an older schema
    (globalThis as Cache).__meshDb!.schema = "an-older-schema";
    const second = getDb();
    expect(second === first).toBe(false);
    expect(() => second.prepare("SELECT COUNT(*) FROM auth_nonces").get()).not.toThrow();
  });
});
