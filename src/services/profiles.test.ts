import { describe, expect, it } from "vitest";
import {
  ConnectionError,
  apiKeyStatus,
  describeProfiles,
  parseSwapToolsEnabled,
  profileFromArgs,
  profileFromRequest,
  selectToolsets,
} from "./profiles.js";

const on = { swapToolsEnabled: true };
const off = { swapToolsEnabled: false };
const keyed = { apiKey: "valid" } as const;
const keyless = { apiKey: "missing" } as const;
const malformed = { apiKey: "malformed" } as const;
const DOCS_URL = "https://docs.sodax.com/developers/how-to/api-keys";
const NOT_A_SODAX_KEY = "isn't a SODAX API key (a sodax_… key alone, at most 128 characters)";

function refusal(requested: unknown, opts: Parameters<typeof selectToolsets>[1]): ConnectionError {
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

  it("gives a keyless default connection the builder tools only, and says the swap tools need a key", () => {
    const selection = selectToolsets(undefined, { ...keyless, ...on });
    expect(selection).toEqual({ builder: true, swap: false, keyHint: expect.any(String) });
    expect(selection.keyHint).toContain("x-api-key header");
    expect(selection.keyHint).toContain(DOCS_URL);
  });

  it("tells a default connection with a malformed key that the value isn't a SODAX key", () => {
    const selection = selectToolsets("all", { ...malformed, ...on });
    expect([selection.builder, selection.swap]).toEqual([true, false]);
    expect(selection.keyHint).toBe(
      `This connection has no swap tools: they need a SODAX API key. The x-api-key value (SODAX_API_KEY on stdio) ${NOT_A_SODAX_KEY}, so calls go out without one: ${DOCS_URL}`,
    );
  });

  it.each([
    ["builder", on],
    ["builder", off],
    ["all", off],
  ] as const)("tells a %s connection (switch %j) its malformed key is dropped", (profile, switchOpts) => {
    const selection = selectToolsets(profile, { ...malformed, ...switchOpts });
    expect([selection.builder, selection.swap]).toEqual([true, false]);
    expect(selection.keyHint).toBe(
      `The x-api-key value (SODAX_API_KEY on stdio) ${NOT_A_SODAX_KEY}, so calls go out without one: ${DOCS_URL}`,
    );
  });

  it("adds no key hint where a key wouldn't bring the swap tools", () => {
    expect(selectToolsets("all", { ...keyed, ...on }).keyHint).toBeUndefined();
    expect(selectToolsets("builder", { ...keyless, ...on }).keyHint).toBeUndefined();
    expect(selectToolsets("all", { ...keyless, ...off }).keyHint).toBeUndefined();
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

  it("lists only the enabled profiles while the switch is off", () => {
    expect(refusal("bogus", { ...keyed, ...off }).message).toBe("Unknown profile. Use builder, all.");
  });

  it("refuses swap while the switch is off, before asking for a key", () => {
    const error = refusal("swap", { ...keyless, ...off });
    expect([error.httpStatus, error.rpcCode]).toEqual([400, -32602]);
    expect(error.message).toContain("not enabled");
  });

  it("refuses a keyless swap connection with 403 and where to get a key", () => {
    const error = refusal("swap", { ...keyless, ...on });
    expect([error.httpStatus, error.rpcCode]).toEqual([403, -32000]);
    expect(error.message).toMatch(/^API key required for the swap profile\. Send it in the x-api-key header/);
    expect(error.message).toContain(DOCS_URL);
  });

  it("refuses a swap connection whose key isn't a SODAX key, saying so", () => {
    const error = refusal("swap", { ...malformed, ...on });
    expect([error.httpStatus, error.rpcCode]).toEqual([403, -32000]);
    expect(error.message).toBe(
      `A SODAX API key is required for the swap profile. The x-api-key value (SODAX_API_KEY on stdio) ${NOT_A_SODAX_KEY}: ${DOCS_URL}`,
    );
  });
});

describe("apiKeyStatus", () => {
  it.each([
    [" sodax_test-key_1 ", "valid"],
    [`sodax_${"a".repeat(122)}`, "valid"],
    ["Bearer sodax_a", "malformed"],
    ["sodax_a, sodax_b", "malformed"],
    ["sodax_", "malformed"],
    ["sk-live-abc123", "malformed"],
    [`sodax_${"a".repeat(123)}`, "malformed"],
    [undefined, "missing"],
    ["", "missing"],
    ["  ", "missing"],
  ])("%j → %s", (value, expected) => {
    expect(apiKeyStatus(value)).toBe(expected);
  });
});

describe("describeProfiles", () => {
  it("describes swap as off while the switch is off", () => {
    expect(describeProfiles(false).swap).toBe("Not enabled on this server yet");
    expect(describeProfiles(true).swap).toContain("x-api-key");
  });

  it("offers the swap tools in all only while the switch is on", () => {
    expect(describeProfiles(false).all).toBe("The builder tools; swap tools aren't enabled yet");
    expect(describeProfiles(true).all).toContain("x-api-key");
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
