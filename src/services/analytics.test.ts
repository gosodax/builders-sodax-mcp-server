import { createHash, createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

// The secret is read at module load, so each test imports a fresh module.
async function loadHashClientIp(secret: string | undefined) {
  vi.resetModules();
  vi.stubEnv("POSTHOG_CLIENT_ID_SECRET", secret);
  return (await import("./analytics.js")).hashClientIp;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("hashClientIp", () => {
  it("is an HMAC keyed by POSTHOG_CLIENT_ID_SECRET when set", async () => {
    const hashClientIp = await loadHashClientIp("test-secret");
    const expected = createHmac("sha256", "test-secret").update("sodax-mcp:203.0.113.7").digest("hex").slice(0, 16);

    expect(hashClientIp("203.0.113.7")).toBe(expected);
    expect(hashClientIp("203.0.113.7")).not.toBe(
      createHash("sha256").update("sodax-mcp:203.0.113.7").digest("hex").slice(0, 16),
    );
  });

  it("keeps the unkeyed salted hash when the secret is unset", async () => {
    const hashClientIp = await loadHashClientIp(undefined);

    expect(hashClientIp("203.0.113.7")).toBe(
      createHash("sha256").update("sodax-mcp:203.0.113.7").digest("hex").slice(0, 16),
    );
  });

  it("maps the same IP to the same id and different IPs to different ids", async () => {
    const hashClientIp = await loadHashClientIp("test-secret");

    expect(hashClientIp("203.0.113.7")).toBe(hashClientIp("203.0.113.7"));
    expect(hashClientIp("203.0.113.7")).not.toBe(hashClientIp("203.0.113.8"));
  });
});
