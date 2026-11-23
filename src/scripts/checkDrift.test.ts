import { afterEach, describe, expect, it, vi } from "vitest";

const checkApiDrift = vi.hoisted(() =>
  vi.fn(
    async (): Promise<{ checked: boolean; hasDrift: boolean; details?: string }> => ({
      checked: true,
      hasDrift: false,
    }),
  ),
);
vi.mock("../services/apiDriftCheck.js", () => ({ checkApiDrift }));
const writeSync = vi.hoisted(() => vi.fn());
vi.mock("node:fs", async importOriginal => ({ ...(await importOriginal<typeof import("node:fs")>()), writeSync }));

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

  it("prints the issues a line each and exits 1 on drift", async () => {
    vi.resetModules();
    vi.stubEnv("SODAX_ENV", "production");
    checkApiDrift.mockResolvedValueOnce({
      checked: true,
      hasDrift: true,
      details: "Param drift — 1 issue(s):\n  - GET /x: y",
    });
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    await import("./checkDrift.js");
    expect(writeSync).toHaveBeenCalledWith(2, "Param drift — 1 issue(s):\n  - GET /x: y\n");
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("exits 1 when the spec can't be read", async () => {
    vi.resetModules();
    vi.stubEnv("SODAX_ENV", "production");
    checkApiDrift.mockResolvedValueOnce({ checked: false, hasDrift: false });
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    await import("./checkDrift.js");
    expect(writeSync).toHaveBeenCalledWith(2, "The OpenAPI spec couldn't be read, so nothing was checked.\n");
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("exits 0 when the spec matches", async () => {
    vi.resetModules();
    vi.stubEnv("SODAX_ENV", "production");
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    await import("./checkDrift.js");
    expect(exit).toHaveBeenCalledWith(0);
  });
});
