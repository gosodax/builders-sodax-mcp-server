import { describe, expect, it } from "vitest";
import { parseSodaxEnv } from "./constants.js";

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
