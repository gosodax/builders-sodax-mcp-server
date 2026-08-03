import { afterEach, describe, expect, it, vi } from "vitest";

import { isDiscordConfigured, notifyError, notifyServerStarted, postToDiscord } from "./discord.js";

const WEBHOOK = "https://discord.test/webhook";
const originalWebhook = process.env.DISCORD_WEBHOOK_URL;

function stubFetch(impl?: () => unknown) {
  const spy = vi.fn(impl ?? (() => Promise.resolve({ ok: true, status: 204 })));
  vi.stubGlobal("fetch", spy);
  return spy;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (originalWebhook === undefined) delete process.env.DISCORD_WEBHOOK_URL;
  else process.env.DISCORD_WEBHOOK_URL = originalWebhook;
});

describe("isDiscordConfigured", () => {
  it("is false when DISCORD_WEBHOOK_URL is unset or blank", () => {
    delete process.env.DISCORD_WEBHOOK_URL;
    expect(isDiscordConfigured()).toBe(false);
    process.env.DISCORD_WEBHOOK_URL = "   ";
    expect(isDiscordConfigured()).toBe(false);
  });

  it("is true when DISCORD_WEBHOOK_URL is non-empty", () => {
    process.env.DISCORD_WEBHOOK_URL = WEBHOOK;
    expect(isDiscordConfigured()).toBe(true);
  });
});

describe("postToDiscord", () => {
  it("does not call fetch and returns false when no webhook is configured", async () => {
    delete process.env.DISCORD_WEBHOOK_URL;
    const fetchSpy = stubFetch();
    const ok = await postToDiscord({ content: "hi" });
    expect(ok).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("POSTs to the webhook with the default username and returns true on 2xx", async () => {
    process.env.DISCORD_WEBHOOK_URL = WEBHOOK;
    const fetchSpy = stubFetch();
    const ok = await postToDiscord({ content: "hello" });
    expect(ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe(WEBHOOK);
    expect(init.method).toBe("POST");
    const payload = JSON.parse(init.body as string);
    expect(payload.username).toBe("SODAX MCP Server");
    expect(payload.content).toBe("hello");
  });

  it("always sends allowed_mentions: { parse: [] } so @everyone/@here never pings", async () => {
    process.env.DISCORD_WEBHOOK_URL = WEBHOOK;
    const fetchSpy = stubFetch();
    await postToDiscord({ content: "@everyone @here <@123> deploy failed" });
    const payload = JSON.parse(fetchSpy.mock.calls[0][1].body as string);
    expect(payload.allowed_mentions).toEqual({ parse: [] });
  });

  it("does not let a caller re-enable mention parsing", async () => {
    process.env.DISCORD_WEBHOOK_URL = WEBHOOK;
    const fetchSpy = stubFetch();
    await postToDiscord({ content: "x", ...{ allowed_mentions: { parse: ["everyone"] } } } as never);
    const payload = JSON.parse(fetchSpy.mock.calls[0][1].body as string);
    expect(payload.allowed_mentions).toEqual({ parse: [] });
  });

  it("lets the caller override the username (e.g. the drift notifier)", async () => {
    process.env.DISCORD_WEBHOOK_URL = WEBHOOK;
    const fetchSpy = stubFetch();
    await postToDiscord({ username: "Drift Watcher", content: "x" });
    const payload = JSON.parse(fetchSpy.mock.calls[0][1].body as string);
    expect(payload.username).toBe("Drift Watcher");
  });

  it("returns false on a non-2xx response", async () => {
    process.env.DISCORD_WEBHOOK_URL = WEBHOOK;
    stubFetch(() => Promise.resolve({ ok: false, status: 404 }));
    expect(await postToDiscord({ content: "x" })).toBe(false);
  });

  it("swallows a network error and returns false (never throws)", async () => {
    process.env.DISCORD_WEBHOOK_URL = WEBHOOK;
    stubFetch(() => Promise.reject(new Error("network down")));
    await expect(postToDiscord({ content: "x" })).resolves.toBe(false);
  });
});

describe("notifyServerStarted", () => {
  it("posts a green 'Server started' embed with version/env/transport/port", async () => {
    process.env.DISCORD_WEBHOOK_URL = WEBHOOK;
    const fetchSpy = stubFetch();
    await notifyServerStarted({ version: "1.2.3", transport: "http", env: "production", port: 3000 });
    const payload = JSON.parse(fetchSpy.mock.calls[0][1].body as string);
    const embed = payload.embeds[0];
    expect(embed.title).toContain("Server started");
    expect(embed.color).toBe(0x2ecc71);
    const fieldValues = embed.fields.map((f: { value: string }) => f.value);
    expect(fieldValues).toEqual(expect.arrayContaining(["1.2.3", "production", "http", "3000"]));
  });

  it("is silent when no webhook is configured", async () => {
    delete process.env.DISCORD_WEBHOOK_URL;
    const fetchSpy = stubFetch();
    await notifyServerStarted({ version: "1.2.3", transport: "http", env: "production" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("notifyError", () => {
  it("posts a red embed with the error message and a fenced stack block", async () => {
    process.env.DISCORD_WEBHOOK_URL = WEBHOOK;
    const fetchSpy = stubFetch();
    await notifyError("Uncaught exception", new Error("boom"));
    const payload = JSON.parse(fetchSpy.mock.calls[0][1].body as string);
    const embed = payload.embeds[0];
    expect(embed.title).toContain("Uncaught exception");
    expect(embed.color).toBe(0xe74c3c);
    expect(embed.description).toContain("boom");
    expect(payload.content).toContain("```");
  });
});
