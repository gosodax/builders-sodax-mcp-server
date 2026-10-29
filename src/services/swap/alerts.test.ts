import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "../logger.js";
import { callerKeyHash, setFallbackRequestContext } from "../requestContext.js";
import { type AlertKind, alertOperator, clearAlerts } from "./alerts.js";

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

  it("posts at most 20 alerts an hour, and 5 more for lost quotes, logs the rest, and counts them when the hour ends", async () => {
    vi.stubEnv("DISCORD_WEBHOOK_URL", "https://discord.example/webhook");
    vi.useFakeTimers({ now: Date.parse("2026-10-26T12:00:00Z"), toFake: ["Date", "setTimeout", "clearTimeout"] });
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));
    const flood = (kind: AlertKind, from: number, count: number) => {
      for (let i = from; i < from + count; i++) alertOperator(kind, { ...FIELDS, txHash: `0x${i}` });
    };

    // Made-up quoteIds can't hold back the alerts on checked deposits.
    flood("unknown_quote", 0, 25);
    expect(fetch).toHaveBeenCalledTimes(5);
    flood("quote_used", 0, 25);
    expect(fetch).toHaveBeenCalledTimes(25);
    expect(logger.error).toHaveBeenCalledTimes(50);

    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(fetch).toHaveBeenCalledTimes(26);
    expect(String(fetch.mock.calls[25][1]?.body)).toContain("25 more swap alerts in the last hour");

    flood("unknown_quote", 100, 1);
    expect(fetch).toHaveBeenCalledTimes(27);
  });

  it("puts another quote's deposit, which any key can name, on the lost quotes' budget", () => {
    vi.stubEnv("DISCORD_WEBHOOK_URL", "https://discord.example/webhook");
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));
    for (let i = 0; i < 3; i++) alertOperator("unknown_quote", { ...FIELDS, txHash: `0x${i}` });
    for (let i = 0; i < 3; i++) alertOperator("other_quote_deposit", { ...FIELDS, txHash: `0x${i}` });
    expect(fetch).toHaveBeenCalledTimes(5);
    alertOperator("other_sender_deposit", FIELDS);
    expect(fetch).toHaveBeenCalledTimes(6);
  });

  it("posts an alert the budget held back when it comes again, instead of muting it for a day", async () => {
    vi.stubEnv("DISCORD_WEBHOOK_URL", "https://discord.example/webhook");
    vi.useFakeTimers({ now: Date.parse("2026-10-26T12:00:00Z"), toFake: ["Date", "setTimeout", "clearTimeout"] });
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));
    for (let i = 0; i < 6; i++) alertOperator("unknown_quote", { ...FIELDS, txHash: `0x${i}` });
    expect(fetch).toHaveBeenCalledTimes(5);

    vi.advanceTimersByTime(60 * 60 * 1000);
    alertOperator("unknown_quote", { ...FIELDS, txHash: "0x5" });
    expect(fetch).toHaveBeenCalledTimes(7);
    expect(String(fetch.mock.calls[6][1]?.body)).toContain("0x5");
    alertOperator("unknown_quote", { ...FIELDS, txHash: "0x5" });
    expect(fetch).toHaveBeenCalledTimes(7);
  });

  it("counts tool errors toward the same hourly cap", () => {
    vi.stubEnv("DISCORD_WEBHOOK_URL", "https://discord.example/webhook");
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));
    for (let i = 0; i < 20; i++) alertOperator("submit_rejected", { ...FIELDS, txHash: `0x${i}` });
    alertOperator("swap_error", { tool: "sodax_swap_quote", code: "INTERNAL" });
    expect(fetch).toHaveBeenCalledTimes(20);
    expect(logger.error).toHaveBeenCalledTimes(21);
  });

  it("treats one stranded deposit as one alert whatever quoteId comes with it, and a tool error per tool and code", () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    alertOperator("unknown_quote", FIELDS);
    alertOperator("unknown_quote", { ...FIELDS, quoteId: "q-2" });
    alertOperator("swap_error", { tool: "sodax_swap_quote", code: "INTERNAL" });
    alertOperator("swap_error", { tool: "sodax_swap_quote", code: "INTERNAL" });
    alertOperator("swap_error", { tool: "sodax_swap_track", code: "INTERNAL" });
    expect(vi.mocked(logger.error)).toHaveBeenCalledTimes(3);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps a tool error on one chain apart from the same on another", () => {
    alertOperator("swap_error", { tool: "sodax_swap_quote", code: "SWAP_MISMATCH", reason: "r", chainKey: "sonic" });
    alertOperator("swap_error", { tool: "sodax_swap_quote", code: "SWAP_MISMATCH", reason: "r", chainKey: "hyper" });
    expect(vi.mocked(logger.error)).toHaveBeenCalledTimes(2);
  });

  it("posts field values without URLs and capped in length", () => {
    vi.stubEnv("DISCORD_WEBHOOK_URL", "https://discord.example/webhook");
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));
    alertOperator("swap_error", {
      tool: "sodax_swap_quote",
      reason: `from https://rpc.example/KEY ${"x".repeat(2000)}`,
    });
    const { embeds } = JSON.parse(String(fetch.mock.calls[0][1]?.body));
    const reason = embeds[0].fields.find((field: { name: string }) => field.name === "reason").value;
    expect(reason).toMatch(/^from <url> x+…$/);
    expect(reason.length).toBeLessThanOrEqual(256);
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
