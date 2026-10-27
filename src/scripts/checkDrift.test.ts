import { afterEach, describe, expect, it, vi } from "vitest";

const checkApiDrift = vi.hoisted(() => vi.fn(async () => ({ hasDrift: false })));
vi.mock("../services/apiDriftCheck.js", () => ({ checkApiDrift }));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("check:drift", () => {
  it("fails on a bad SODAX_ENV before checking anything", async () => {
    vi.stubEnv("SODAX_ENV", "staging");
    vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    await expect(import("./checkDrift.js")).rejects.toThrow("SODAX_ENV must be one of");
    expect(checkApiDrift).not.toHaveBeenCalled();
  });
});
