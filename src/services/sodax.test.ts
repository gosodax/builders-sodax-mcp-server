import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("getSdk", () => {
  it("refuses to run before initSodax", async () => {
    const { getSdk } = await import("./sodax.js");
    expect(() => getSdk()).toThrow("initSodax");
  });

  it("loads the SDK once, with the pinned contracts", async () => {
    const { getSdk, initSodax } = await import("./sodax.js");
    const first = await initSodax();
    expect(await initSodax()).toBe(first);
    expect(getSdk()).toBe(first);
    expect(first.intentsContract).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(first.hubChainKey).toBe("sonic");
  });
});

describe("sdkLogger", () => {
  it("passes on only the SDK's message, never its error or data", async () => {
    // A fresh module graph each test: take the logger sodax.js itself imports.
    const [{ sdkLogger }, { logger }] = await Promise.all([import("./sodax.js"), import("./logger.js")]);
    const warn = vi.spyOn(logger, "warn");
    const error = vi.spyOn(logger, "error");
    sdkLogger.debug();
    sdkLogger.info();
    sdkLogger.warn("balance read failed");
    sdkLogger.error("rpc failed");
    expect(warn).toHaveBeenCalledWith({ source: "sodax-sdk" }, "balance read failed");
    expect(error).toHaveBeenCalledWith({ source: "sodax-sdk" }, "rpc failed");
  });
});
