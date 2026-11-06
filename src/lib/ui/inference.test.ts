import { describe, expect, it } from "vitest";
import { initialViewState, reduceJobView } from "./job-view";

describe("job view: AI review event", () => {
  it("logs the 0G request id and quality, good in green and anything else as a warning", () => {
    const good = reduceJobView(initialViewState, { type: "event", id: 1, name: "inference", data: { requestId: "req_0g_123456789", quality: "good" } });
    expect(good.log[0]).toMatchObject({ kind: "good" });
    expect(good.log[0].text).toContain("req_0g_12345");
    const bad = reduceJobView(good, { type: "event", id: 2, name: "inference", data: { requestId: "r2", quality: "suspicious" } });
    expect(bad.log[0].kind).toBe("bad");
  });

  it("applies a replayed event only once", () => {
    const once = reduceJobView(initialViewState, { type: "event", id: 5, name: "inference", data: { requestId: "r", quality: "good" } });
    expect(reduceJobView(once, { type: "event", id: 5, name: "inference", data: { requestId: "r", quality: "good" } })).toBe(once);
  });
});
