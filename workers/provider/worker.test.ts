import { describe, expect, it } from "vitest";
import { classifyFailure, configureProviderCli } from "./worker";

describe("provider worker helpers", () => {
  it("maps worker failures to the API's agreed enum", () => {
    expect(classifyFailure(new Error("Task timed out after 10s"))).toBe(
      "timeout",
    );
    expect(classifyFailure(new Error("Input hash mismatch"))).toBe(
      "hash_mismatch",
    );
    expect(classifyFailure(new Error("Process cancelled"), true)).toBe(
      "killed",
    );
    expect(classifyFailure(new Error("Docker daemon unavailable"))).toBe(
      "crash",
    );
  });

  it("accepts the documented API override and tamper flag", () => {
    const previousApiUrl = process.env.API_PUBLIC_URL;
    const previousTamper = process.env.MESH_TAMPER;
    try {
      expect(
        configureProviderCli(["--api", "http://127.0.0.1:3000", "--tamper"]),
      ).toBe(true);
      expect(process.env.API_PUBLIC_URL).toBe("http://127.0.0.1:3000");
      expect(process.env.MESH_TAMPER).toBe("true");
    } finally {
      if (previousApiUrl === undefined) delete process.env.API_PUBLIC_URL;
      else process.env.API_PUBLIC_URL = previousApiUrl;
      if (previousTamper === undefined) delete process.env.MESH_TAMPER;
      else process.env.MESH_TAMPER = previousTamper;
    }
  });
});
