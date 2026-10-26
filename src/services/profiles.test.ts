import { describe, expect, it } from "vitest";
import {
  ConnectionError,
  parseSwapToolsEnabled,
  profileFromArgs,
  profileFromRequest,
  selectToolsets,
} from "./profiles.js";

const on = { swapToolsEnabled: true };
const off = { swapToolsEnabled: false };
const keyed = { hasApiKey: true };
const keyless = { hasApiKey: false };

function refusal(requested: unknown, opts: { hasApiKey: boolean; swapToolsEnabled: boolean }): ConnectionError {
  try {
    selectToolsets(requested, opts);
  } catch (error) {
    if (error instanceof ConnectionError) return error;
    throw error;
  }
  throw new Error("expected a ConnectionError");
}

describe("selectToolsets", () => {
  it.each([undefined, "all", " ALL "])("serves both to a keyed default connection (%j)", profile => {
    expect(selectToolsets(profile, { ...keyed, ...on })).toEqual({ builder: true, swap: true });
  });

  it("gives a keyless default connection the builder tools only", () => {
    expect(selectToolsets(undefined, { ...keyless, ...on })).toEqual({ builder: true, swap: false });
  });

  it("keeps the swap tools out of every profile while the switch is off", () => {
    expect(selectToolsets("all", { ...keyed, ...off })).toEqual({ builder: true, swap: false });
    expect(selectToolsets("builder", { ...keyed, ...off })).toEqual({ builder: true, swap: false });
  });

  it("never gives a builder connection the swap tools", () => {
    expect(selectToolsets("builder", { ...keyed, ...on })).toEqual({ builder: true, swap: false });
  });

  it("serves only the swap tools to a keyed swap connection", () => {
    expect(selectToolsets(" Swap ", { ...keyed, ...on })).toEqual({ builder: false, swap: true });
  });

  it.each(["bogus", ["swap", "all"], { swap: "1" }])("refuses an unknown profile (%j) without echoing it", profile => {
    const error = refusal(profile, { ...keyed, ...on });
    expect([error.httpStatus, error.rpcCode]).toEqual([400, -32602]);
    expect(error.message).toBe("Unknown profile. Use builder, swap, all.");
  });

  it("refuses swap while the switch is off, before asking for a key", () => {
    const error = refusal("swap", { ...keyless, ...off });
    expect([error.httpStatus, error.rpcCode]).toEqual([400, -32602]);
    expect(error.message).toContain("not enabled");
  });

  it("refuses a keyless swap connection with 403 and where to get a key", () => {
    const error = refusal("swap", { ...keyless, ...on });
    expect([error.httpStatus, error.rpcCode]).toEqual([403, -32000]);
    expect(error.message).toContain("API key required");
    expect(error.message).toContain("https://docs.sodax.com/developers/how-to/api-keys");
  });
});

describe("profileFromRequest", () => {
  const req = (query: { profile?: unknown }, header?: string) => ({ query, get: () => header });

  it("prefers the query over the header", () => {
    expect(profileFromRequest(req({ profile: "swap" }, "builder"))).toBe("swap");
    expect(profileFromRequest(req({}, "builder"))).toBe("builder");
    expect(profileFromRequest(req({}))).toBeUndefined();
  });

  it("treats a blank query as unset, so it can't override the header", () => {
    expect(profileFromRequest(req({ profile: "" }, "builder"))).toBe("builder");
    expect(profileFromRequest(req({ profile: " " }, "builder"))).toBe("builder");
  });
});

describe("profileFromArgs", () => {
  it("prefers --profile over MCP_PROFILE and ignores other arguments", () => {
    expect(profileFromArgs(["--profile", "swap"], {})).toBe("swap");
    expect(profileFromArgs(["--profile=builder", "--verbose", "x"], { MCP_PROFILE: "swap" })).toBe("builder");
    expect(profileFromArgs(["--verbose"], { MCP_PROFILE: "swap" })).toBe("swap");
    expect(profileFromArgs([], {})).toBeUndefined();
  });

  it("treats a blank --profile as unset", () => {
    expect(profileFromArgs(["--profile="], { MCP_PROFILE: "builder" })).toBe("builder");
  });
});

describe("parseSwapToolsEnabled", () => {
  it.each([
    [undefined, false],
    ["", false],
    ["false", false],
    ["true", true],
    [" TRUE ", true],
  ])("%j → %j", (value, expected) => {
    expect(parseSwapToolsEnabled(value)).toBe(expected);
  });

  it("stops on anything else, so a typo can't flip the gate", () => {
    expect(() => parseSwapToolsEnabled("yes")).toThrow("SODAX_SWAP_TOOLS_ENABLED");
  });
});
