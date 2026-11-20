import { defineConfig } from "vitest/config";

// Live contract tests, kept out of `pnpm test`: `pnpm test:contract` runs them against production,
// `SODAX_ENV=canary pnpm test:contract` against canary.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.contract.test.ts"],
    env: { LOG_LEVEL: "silent", SODAX_ENV: process.env.SODAX_ENV || "production" },
    testTimeout: 30_000,
  },
});
