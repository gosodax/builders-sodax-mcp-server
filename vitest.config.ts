import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "scripts/**/*.test.ts"],
    // Live contract tests have their own config (vitest.contract.config.ts).
    exclude: [...configDefaults.exclude, "src/**/*.contract.test.ts"],
    // Tests deliberately exercise logger.warn / logger.error paths; silence
    // the production logger so passing runs aren't visually noisy.
    // Pin the SODAX API host so tests don't follow the shell's SODAX_ENV.
    env: { LOG_LEVEL: "silent", SODAX_ENV: "production" },
    // Each test starts from the mocks' own implementations: restoreAllMocks now restores vi.spyOn spies only, so
    // without this a mockResolvedValue set on a vi.mock function in one test reaches the next.
    mockReset: true,
  },
});
