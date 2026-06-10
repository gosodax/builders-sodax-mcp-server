/**
 * Discord webhook notifier.
 *
 * A single entry point for posting to `DISCORD_WEBHOOK_URL` — used by the API
 * drift check (issue #16) and for server status + significant-error alerts
 * (issue #38).
 *
 * Every send is gated on `DISCORD_WEBHOOK_URL` being non-empty (so staging /
 * local stay silent), uses a 5s timeout, and swallows its own errors. A
 * notification must NEVER crash or meaningfully block the server, so callers
 * fire-and-forget (or await the bounded promise on shutdown / crash paths).
 */

import { logger } from "./logger.js";

const DISCORD_TIMEOUT_MS = 5000;
const DISCORD_USERNAME = "SODAX MCP Server";

/** Discord caps message `content` at 2000 chars; stay under 1800 for headroom. */
export const DISCORD_CONTENT_LIMIT = 1800;

/** Embed accent colors (decimal RGB, as Discord expects). */
const COLOR = {
  green: 0x2ecc71,
  red: 0xe74c3c,
} as const;

interface DiscordEmbed {
  title?: string;
  description?: string;
  color?: number;
  fields?: { name: string; value: string; inline?: boolean }[];
  timestamp?: string;
}

interface DiscordMessage {
  username?: string;
  content?: string;
  embeds?: DiscordEmbed[];
}

/** True when a webhook URL is configured (non-empty after trim). */
export function isDiscordConfigured(): boolean {
  return Boolean(process.env.DISCORD_WEBHOOK_URL?.trim());
}

/** Truncate `text` to at most `max` chars, adding an ellipsis when cut. */
function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * POST a message to the Discord webhook. Returns true on 2xx delivery, false
 * otherwise (including when no webhook is configured). Never throws.
 */
export async function postToDiscord(message: DiscordMessage): Promise<boolean> {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL?.trim();
  if (!webhookUrl) return false;

  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: DISCORD_USERNAME, ...message }),
      signal: AbortSignal.timeout(DISCORD_TIMEOUT_MS),
    });
    if (!response.ok) {
      logger.warn({ status: response.status }, "⚠️  Discord notifier: webhook returned non-2xx");
      return false;
    }
    return true;
  } catch (err) {
    logger.warn({ err }, "⚠️  Discord notifier: POST failed (swallowed)");
    return false;
  }
}

/** Notify that the server has come online. */
export async function notifyServerStarted(info: {
  version: string;
  transport: string;
  env: string;
  port?: number;
}): Promise<void> {
  const fields = [
    { name: "Version", value: info.version, inline: true },
    { name: "Environment", value: info.env, inline: true },
    { name: "Transport", value: info.transport, inline: true },
  ];
  if (info.port !== undefined) fields.push({ name: "Port", value: String(info.port), inline: true });

  await postToDiscord({
    embeds: [{ title: "🟢 Server started", color: COLOR.green, fields, timestamp: new Date().toISOString() }],
  });
}

/** Notify that the server is shutting down (e.g. SIGTERM on a redeploy). */
export async function notifyServerStopping(signal: string): Promise<void> {
  await postToDiscord({
    embeds: [
      {
        title: "🔴 Server shutting down",
        description: `Received \`${signal}\``,
        color: COLOR.red,
        timestamp: new Date().toISOString(),
      },
    ],
  });
}

/** Notify a significant / unexpected error, with the stack in a fenced block. */
export async function notifyError(context: string, error: unknown): Promise<void> {
  const detail =
    error instanceof Error ? `${error.name}: ${error.message}` : typeof error === "string" ? error : String(error);
  const stack = error instanceof Error && error.stack ? error.stack : "";

  await postToDiscord({
    content: stack ? `\`\`\`\n${truncate(stack, DISCORD_CONTENT_LIMIT - 10)}\n\`\`\`` : undefined,
    embeds: [
      {
        title: truncate(`🚨 ${context}`, 240),
        description: truncate(detail, 1000),
        color: COLOR.red,
        timestamp: new Date().toISOString(),
      },
    ],
  });
}
