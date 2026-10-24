import { defineConfig } from "vitest/config";

// Two-process tests: start the independent Python agent, then drive it from ZeroBug.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/e2e/**/*.test.ts", ...(process.env.ZB_LIVE === "1" ? ["tests/live/**/*.test.ts"] : [])],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
