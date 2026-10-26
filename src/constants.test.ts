import { afterEach, describe, expect, it, vi } from "vitest";
import { parseSodaxEnv, parseSwapUsdWarn } from "./constants.js";

describe("parseSodaxEnv", () => {
  it("defaults to production when unset or blank", () => {
    expect(parseSodaxEnv(undefined)).toBe("production");
    expect(parseSodaxEnv("")).toBe("production");
  });

  it("accepts canary, ignoring case and spaces", () => {
    expect(parseSodaxEnv("canary")).toBe("canary");
    expect(parseSodaxEnv(" Canary ")).toBe("canary");
  });

  it("returns undefined for anything else, including object prototype keys", () => {
    expect(parseSodaxEnv("staging")).toBeUndefined();
    expect(parseSodaxEnv("constructor")).toBeUndefined();
  });
});

describe("base URLs on SODAX_ENV=canary", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("use the canary host, except the relay, which stays on production", async () => {
    vi.stubEnv("SODAX_ENV", "canary");
    vi.resetModules();
    const constants = await import("./constants.js");
    expect(constants.SODAX_ENV_ERROR).toBeUndefined();
    expect({
      api: constants.SODAX_API_BASE_URL,
      solver: constants.SODAX_SOLVER_BASE_URL,
      relay: constants.SODAX_RELAY_BASE_URL,
    }).toEqual({
      api: "https://canary-api.sodax.com/v1/be",
      solver: "https://canary-api.sodax.com/v1/intent",
      relay: "https://api.sodax.com/v1/relay",
    });
  });
});

describe("parseSwapUsdWarn", () => {
  it.each([
    [undefined, 10_000],
    ["", 10_000],
    [" 2500 ", 2_500],
    ["0.5", 0.5],
  ])("reads %j as %d", (value, level) => {
    expect(parseSwapUsdWarn(value)).toBe(level);
  });

  it.each(["0", "-5", "1e6", "10,000", "abc"])("refuses %j", value => {
    expect(parseSwapUsdWarn(value)).toBeUndefined();
  });
});
