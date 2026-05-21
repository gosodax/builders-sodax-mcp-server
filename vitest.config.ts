import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Tests deliberately exercise logger.warn / logger.error paths; silence
    // the production logger so passing runs aren't visually noisy.
    env: { LOG_LEVEL: "silent" },
  },
});
