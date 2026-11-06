import { describe, expect, it } from "vitest";
import { pollWithin } from "./poll-budget";

describe("pollWithin", () => {
  it("stops when the budget is spent instead of repeating a fixed 40 times", async () => {
    let t = 0;
    let calls = 0;
    const result = await pollWithin(
      12_000,
      async () => {
        calls += 1;
        return undefined;
      },
      { intervalMs: 2_000, now: () => t, sleep: async (ms) => { t += ms; } },
    );
    expect(result).toBeUndefined();
    expect(t).toBe(12_000);
    expect(calls).toBe(6);
    expect(calls).toBeLessThan(40);
  });

  it("does not start another try after a slow check has already used the budget", async () => {
    let t = 0;
    let calls = 0;
    await pollWithin(
      12_000,
      async () => {
        calls += 1;
        t += 100_000;
        return undefined;
      },
      { now: () => t, sleep: async () => { throw new Error("slept after the budget"); } },
    );
    expect(calls).toBe(1);
  });
});
