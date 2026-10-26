import { describe, expect, it } from "vitest";
import { partnerFeeFromEnv, partnerFeeFromRequest } from "./partnerFee.js";
import { ConnectionError } from "./profiles.js";

const ADDRESS = "0x000000000000000000000000000000000000dEaD";
const OTHER = "0x1111111111111111111111111111111111111111";

const request = (query: Record<string, unknown>, headers: Record<string, string> = {}) => ({
  query,
  get: (name: string) => headers[name],
});

describe("partnerFeeFromRequest", () => {
  it("reads the query pair, else the header pair, else nothing", () => {
    expect(partnerFeeFromRequest(request({ partnerAddress: ADDRESS, partnerFeeBps: "25" }))).toEqual({
      address: ADDRESS,
      bps: 25,
    });
    const headers = { "x-sodax-partner-address": OTHER, "x-sodax-partner-fee-bps": " 100 " };
    expect(partnerFeeFromRequest(request({}, headers))).toEqual({ address: OTHER, bps: 100 });
    expect(partnerFeeFromRequest(request({}))).toBeUndefined();
  });

  it("takes the query as a pair when it has either half", () => {
    const headers = { "x-sodax-partner-address": OTHER, "x-sodax-partner-fee-bps": "10" };
    expect(() => partnerFeeFromRequest(request({ partnerFeeBps: "10" }, headers))).toThrow(ConnectionError);
  });

  it.each([
    ["one half only", { partnerAddress: ADDRESS }],
    ["a bad address", { partnerAddress: "0x123", partnerFeeBps: "10" }],
    ["the zero address", { partnerAddress: `0x${"0".repeat(40)}`, partnerFeeBps: "10" }],
    ["zero bps", { partnerAddress: ADDRESS, partnerFeeBps: "0" }],
    ["101 bps", { partnerAddress: ADDRESS, partnerFeeBps: "101" }],
    ["a fraction", { partnerAddress: ADDRESS, partnerFeeBps: "1.5" }],
    ["text", { partnerAddress: ADDRESS, partnerFeeBps: "abc" }],
    ["a repeated parameter", { partnerAddress: [ADDRESS, OTHER], partnerFeeBps: "10" }],
  ])("refuses %s with 400, without echoing it", (_case, query) => {
    let error: unknown;
    try {
      partnerFeeFromRequest(request(query));
    } catch (thrown) {
      error = thrown;
    }
    expect(error).toBeInstanceOf(ConnectionError);
    expect((error as ConnectionError).httpStatus).toBe(400);
    expect((error as ConnectionError).message).not.toContain("0x");
  });
});

describe("partnerFeeFromEnv", () => {
  it("reads both variables, or none", () => {
    expect(partnerFeeFromEnv({ SODAX_PARTNER_FEE_ADDRESS: ADDRESS, SODAX_PARTNER_FEE_BPS: "5" })).toEqual({
      address: ADDRESS,
      bps: 5,
    });
    expect(partnerFeeFromEnv({})).toBeUndefined();
    expect(() => partnerFeeFromEnv({ SODAX_PARTNER_FEE_BPS: "5" })).toThrow(ConnectionError);
  });
});
