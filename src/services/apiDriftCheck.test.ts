import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./http.js", () => ({
  fetchJson: vi.fn(),
}));

import { checkApiDrift } from "./apiDriftCheck.js";
import { diff, resolveResponseFields } from "./apiDriftCheckUtils.js";
import { fetchJson } from "./http.js";

const mockFetchJson = vi.mocked(fetchJson);

describe("resolveResponseFields", () => {
  it("returns object kind with field names for an inline object schema", () => {
    const result = resolveResponseFields(
      { type: "object", properties: { foo: { type: "string" }, bar: { type: "number" } } },
      undefined,
    );
    expect(result).toEqual({ kind: "object", fields: ["foo", "bar"] });
  });

  it("resolves a $ref to the referenced component's fields", () => {
    const components = {
      Pet: { type: "object", properties: { name: { type: "string" }, age: { type: "number" } } },
    };
    const result = resolveResponseFields({ $ref: "#/components/schemas/Pet" }, components);
    expect(result).toEqual({ kind: "object", fields: ["name", "age"] });
  });

  it("descends into array items to expose item fields", () => {
    const result = resolveResponseFields(
      {
        type: "array",
        items: { type: "object", properties: { id: { type: "string" } } },
      },
      undefined,
    );
    expect(result).toEqual({ kind: "object", fields: ["id"] });
  });

  it("returns primitive kind for primitive schemas", () => {
    expect(resolveResponseFields({ type: "string" }, undefined)).toEqual({ kind: "primitive" });
    expect(resolveResponseFields({ type: "number" }, undefined)).toEqual({ kind: "primitive" });
  });

  it("returns map kind for objects with additionalProperties (dynamic maps)", () => {
    const result = resolveResponseFields({ type: "object", additionalProperties: { type: "string" } }, undefined);
    expect(result).toEqual({ kind: "map" });
  });

  it("returns unknown kind for undefined or unrecognized schemas", () => {
    expect(resolveResponseFields(undefined, undefined)).toEqual({ kind: "unknown" });
    expect(resolveResponseFields({}, undefined)).toEqual({ kind: "unknown" });
  });
});

describe("diff", () => {
  it("returns missing for items in actual but not expected", () => {
    expect(diff(["a", "b"], ["a", "b", "c"])).toEqual({ missing: ["c"], extra: [] });
  });

  it("returns extra for items in expected but not actual", () => {
    expect(diff(["a", "b", "c"], ["a"])).toEqual({ missing: [], extra: ["b", "c"] });
  });

  it("returns both missing and extra when sets diverge in both directions", () => {
    expect(diff(["a", "b"], ["b", "c"])).toEqual({ missing: ["c"], extra: ["a"] });
  });

  it("returns empty arrays when sets match", () => {
    expect(diff(["a", "b"], ["a", "b"])).toEqual({ missing: [], extra: [] });
  });
});

describe("checkApiDrift", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    mockFetchJson.mockReset();
  });

  it("returns hasDrift: true when the spec exposes an endpoint not in TOOL_CONTRACT", async () => {
    mockFetchJson.mockResolvedValueOnce({
      paths: {
        "/some/unknown/endpoint": { get: {} },
      },
    });

    const report = await checkApiDrift();

    expect(report.hasDrift).toBe(true);
    expect(report.summary.endpointGaps).toBe(1);
  });

  it("returns hasDrift: true when spec params disagree with the tool contract", async () => {
    // `/config/all` is in TOOL_CONTRACT with params: []; injecting a param triggers drift.
    mockFetchJson.mockResolvedValueOnce({
      paths: {
        "/config/all": {
          get: {
            parameters: [{ name: "rogueParam", in: "query", required: false }],
          },
        },
      },
    });

    const report = await checkApiDrift();

    expect(report.hasDrift).toBe(true);
    expect(report.summary.paramGaps).toBeGreaterThanOrEqual(1);
  });

  it("returns hasDrift: false when fetching the spec fails (fire-and-forget contract)", async () => {
    mockFetchJson.mockRejectedValueOnce(new Error("network down"));

    const report = await checkApiDrift();

    expect(report.hasDrift).toBe(false);
    expect(report.summary.totalEndpoints).toBe(0);
  });

  it("suppresses param-extra issues for params listed in allowToolExtra", async () => {
    // `/config/hub/assets` has params: ["chainId"] and allowToolExtra: ["chainId"].
    // Spec declaring no params would normally flag chainId as an extra — allowToolExtra suppresses that.
    mockFetchJson.mockResolvedValueOnce({
      paths: {
        "/config/hub/assets": {
          get: { parameters: [] },
        },
      },
    });

    const report = await checkApiDrift();

    expect(report.hasDrift).toBe(false);
    expect(report.summary.paramGaps).toBe(0);
  });

  it("still flags param-extra on endpoints without allowToolExtra (control case)", async () => {
    // `/config/hub/:chainId/assets` declares chainId as a param with no allowToolExtra.
    // Spec without that param should flag drift, confirming the suppression is targeted.
    mockFetchJson.mockResolvedValueOnce({
      paths: {
        "/config/hub/{chainId}/assets": {
          get: { parameters: [] },
        },
      },
    });

    const report = await checkApiDrift();

    expect(report.hasDrift).toBe(true);
    expect(report.summary.paramGaps).toBeGreaterThanOrEqual(1);
  });
});
