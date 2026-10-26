import { describe, expect, it } from "vitest";
import { errWithoutUrls, withoutUrls } from "./logger.js";

describe("errWithoutUrls", () => {
  it("removes URLs from every field of an error, its own properties and cause included", () => {
    const cause = new Error("fetch https://rpc.example/KEY/cause failed");
    const error = Object.assign(new Error("HTTP request failed. URL: https://rpc.example/KEY"), {
      url: "https://rpc.example/KEY",
      metaMessages: ["Request body: {}", "URL: https://rpc.example/KEY"],
      cause,
    });
    const serialized = JSON.stringify(errWithoutUrls(error));
    expect(serialized).not.toContain("KEY");
    expect(serialized).toContain("HTTP request failed. URL: <url>");
  });

  it("leaves text without a URL alone, and stops at quotes", () => {
    expect(withoutUrls("no url here")).toBe("no url here");
    expect(withoutUrls('{"u":"https://a.example/x","n":1}')).toBe('{"u":"<url>","n":1}');
  });

  it("never throws: bigints, cycles, thrown strings and plain objects all come out without URLs", () => {
    const withBigint = Object.assign(new Error("call to HTTPS://rpc.example/KEY"), { amount: 10n });
    const circular: Record<string, unknown> = { message: "see https://rpc.example/KEY" };
    circular.self = circular;
    for (const thrown of [
      withBigint,
      circular,
      "request to https://rpc.example/KEY failed",
      { url: "https://x/KEY" },
    ]) {
      const serialized = JSON.stringify(errWithoutUrls(thrown));
      expect(serialized).not.toContain("KEY");
    }
    expect(errWithoutUrls(withBigint)).toMatchObject({ amount: "10" });
  });
});
