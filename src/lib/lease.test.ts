import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireLease, releaseLease } from "./lease";
import { getDb } from "./db";
import { setupTestEnv } from "./testing";

describe("lease", () => {
  let cleanup: () => void;
  beforeEach(() => {
    cleanup = setupTestEnv();
  });
  afterEach(() => cleanup());

  it("lets one holder work at a time and renews for the same holder", () => {
    expect(acquireLease("chain", "a")).toBe(true);
    expect(acquireLease("chain", "b")).toBe(false);
    expect(acquireLease("chain", "a")).toBe(true); // renewal
  });

  it("hands over once the lease expired, or when the holder released it", () => {
    expect(acquireLease("chain", "a", 20)).toBe(true);
    getDb().prepare("UPDATE leases SET expires_at = ? WHERE name = 'chain'").run(Math.floor(Date.now() / 1000) - 1);
    expect(acquireLease("chain", "b")).toBe(true);
    releaseLease("chain", "b");
    expect(acquireLease("chain", "a")).toBe(true);
  });

  it("keeps separate names independent, and a stranger cannot release someone else's lease", () => {
    expect(acquireLease("x", "a")).toBe(true);
    expect(acquireLease("y", "b")).toBe(true);
    releaseLease("x", "b");
    expect(acquireLease("x", "b")).toBe(false);
  });
});
