import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "../logger.js";
import { callerKeyHash, setFallbackRequestContext } from "../requestContext.js";
import { alertOperator, clearAlerts } from "./alerts.js";

const TX = `0x${"a".repeat(64)}`;
const FIELDS = { chainKey: "0xa4b1.arbitrum", txHash: TX, quoteId: "q-1" };

beforeEach(() => {
  clearAlerts();
  vi.spyOn(logger, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  setFallbackRequestContext({});
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("alertOperator", () => {
  it("posts once a day per kind and tx, with no address", async () => {
    vi.stubEnv("DISCORD_WEBHOOK_URL", "https://discord.example/webhook");
    vi.useFakeTimers({ now: Date.parse("2026-10-26T12:00:00Z"), toFake: ["Date"] });
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));

    alertOperator("unknown_quote", FIELDS);
    alertOperator("unknown_quote", FIELDS);
    alertOperator("quote_used", FIELDS);
    expect(fetch).toHaveBeenCalledTimes(2);
    const body = String(fetch.mock.calls[0][1]?.body);
    expect(body).toContain(TX);
    expect(body).not.toContain("dEaD");

    vi.setSystemTime(Date.parse("2026-10-27T12:00:01Z"));
    alertOperator("unknown_quote", FIELDS);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("names the caller by a short hash of their key, never the key", async () => {
    vi.stubEnv("DISCORD_WEBHOOK_URL", "https://discord.example/webhook");
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));
    setFallbackRequestContext({ apiKey: "sodax_secret_key" });
    alertOperator("unknown_quote", FIELDS);
    const keyHash = callerKeyHash().slice(0, 12);
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ keyHash }), expect.any(String));
    const body = String(fetch.mock.calls[0][1]?.body);
    expect(body).toContain(keyHash);
    expect(body).not.toContain(callerKeyHash());
    expect(body).not.toContain("sodax_secret_key");
  });

  it("posts at most 20 alerts an hour, logs the rest, and counts them in one post when the hour ends", async () => {
    vi.stubEnv("DISCORD_WEBHOOK_URL", "https://discord.example/webhook");
    vi.useFakeTimers({ now: Date.parse("2026-10-26T12:00:00Z"), toFake: ["Date", "setTimeout", "clearTimeout"] });
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));
    const flood = (from: number, count: number) => {
      for (let i = from; i < from + count; i++) alertOperator("unknown_quote", { ...FIELDS, txHash: `0x${i}` });
    };

    flood(0, 25);
    expect(fetch).toHaveBeenCalledTimes(20);
    expect(logger.error).toHaveBeenCalledTimes(25);

    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(fetch).toHaveBeenCalledTimes(21);
    expect(String(fetch.mock.calls[20][1]?.body)).toContain("5 more swap alerts in the last hour");

    flood(100, 1);
    expect(fetch).toHaveBeenCalledTimes(22);
  });

  it("only logs without a webhook", () => {
    vi.stubEnv("DISCORD_WEBHOOK_URL", "");
    const fetch = vi.spyOn(globalThis, "fetch");
    alertOperator("refund_relay_failed", { ...FIELDS, deadline: "1793001289" });
    expect(fetch).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ alert: "refund_relay_failed", deadline: "1793001289" }),
      expect.any(String),
    );
  });
});
