import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  test: { include: ["src/**/*.test.ts", "workers/**/*.test.ts", "scripts/**/*.test.ts"], passWithNoTests: true },
});
