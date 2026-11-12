import { defineConfig } from "vitest/config";

// Live contract tests, kept out of `pnpm test`: `pnpm test:contract` runs them against canary,
// `SODAX_ENV=production pnpm test:contract` against production.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.contract.test.ts"],
    env: { LOG_LEVEL: "silent", SODAX_ENV: process.env.SODAX_ENV || "canary" },
    testTimeout: 30_000,
  },
});
