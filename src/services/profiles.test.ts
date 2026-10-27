import { describe, expect, it } from "vitest";
import {
  type ApiKeyStatus,
  ConnectionError,
  apiKeyStatus,
  profileFromArgs,
  profileFromRequest,
  selectToolsets,
} from "./profiles.js";

const DOCS_URL = "https://docs.sodax.com/developers/how-to/api-keys";
const NOT_A_SODAX_KEY = "isn't a SODAX API key (a sodax_… key alone, at most 128 characters)";

function refusal(requested: unknown, apiKey: ApiKeyStatus): ConnectionError {
  try {
    selectToolsets(requested, apiKey);
  } catch (error) {
    if (error instanceof ConnectionError) return error;
    throw error;
  }
  throw new Error("expected a ConnectionError");
}

describe("selectToolsets", () => {
  it.each([undefined, "all", " ALL "])("serves both to a keyed default connection (%j)", profile => {
    expect(selectToolsets(profile, "valid")).toEqual({ builder: true, swap: true });
  });

  it("gives a keyless default connection the builder tools only, and says the swap tools need a key", () => {
    const selection = selectToolsets(undefined, "missing");
    expect(selection).toEqual({ builder: true, swap: false, keyHint: expect.any(String) });
    expect(selection.keyHint).toContain("x-api-key header");
    expect(selection.keyHint).toContain(DOCS_URL);
  });

  it("tells a default connection with a malformed key that the value isn't a SODAX key", () => {
    const selection = selectToolsets("all", "malformed");
    expect([selection.builder, selection.swap]).toEqual([true, false]);
    expect(selection.keyHint).toBe(
      `This connection has no swap tools: they need a SODAX API key. The x-api-key value (SODAX_API_KEY on stdio) ${NOT_A_SODAX_KEY}, so calls go out without one: ${DOCS_URL}`,
    );
  });

  it("tells a builder connection its malformed key is dropped", () => {
    const selection = selectToolsets("builder", "malformed");
    expect([selection.builder, selection.swap]).toEqual([true, false]);
    expect(selection.keyHint).toBe(
      `The x-api-key value (SODAX_API_KEY on stdio) ${NOT_A_SODAX_KEY}, so calls go out without one: ${DOCS_URL}`,
    );
  });

  it.each(["valid", "missing"] as const)(
    "never gives a builder connection (key %s) the swap tools or a hint",
    apiKey => {
      expect(selectToolsets("builder", apiKey)).toEqual({ builder: true, swap: false });
    },
  );

  it("serves only the swap tools to a keyed swap connection", () => {
    expect(selectToolsets(" Swap ", "valid")).toEqual({ builder: false, swap: true });
  });

  it.each(["bogus", ["swap", "all"], { swap: "1" }])("refuses an unknown profile (%j) without echoing it", profile => {
    const error = refusal(profile, "valid");
    expect([error.httpStatus, error.rpcCode]).toEqual([400, -32602]);
    expect(error.message).toBe("Unknown profile. Use builder, swap, all.");
  });

  it("refuses a keyless swap connection with 403 and where to get a key", () => {
    const error = refusal("swap", "missing");
    expect([error.httpStatus, error.rpcCode]).toEqual([403, -32000]);
    expect(error.message).toMatch(/^API key required for the swap profile\. Send it in the x-api-key header/);
    expect(error.message).toContain(DOCS_URL);
  });

  it("refuses a swap connection whose key isn't a SODAX key, saying so", () => {
    const error = refusal("swap", "malformed");
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
