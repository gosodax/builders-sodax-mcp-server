/**
 * Analytics Service — PostHog integration
 *
 * Tracks every MCP tool call automatically via a server.tool() wrapper.
 * Events are sent asynchronously and never block tool responses.
 *
 * Set POSTHOG_API_KEY in your environment to enable tracking.
 * When unset, all tracking is silently skipped.
 */

import { createHash, createHmac } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PostHog } from "posthog-node";
import { getToolModule } from "./toolRegistry.js";

// ── Configuration ────────────────────────────────────────────────────
const POSTHOG_API_KEY = process.env.POSTHOG_API_KEY || "";
const POSTHOG_HOST = process.env.POSTHOG_HOST || "https://eu.i.posthog.com";
const DISTINCT_ID = process.env.POSTHOG_DISTINCT_ID || "sodax-builders-mcp";
const SERVER_NAME = process.env.POSTHOG_SERVER_NAME || "builders-mcp";
const CLIENT_ID_SECRET = process.env.POSTHOG_CLIENT_ID_SECRET || "";

/**
 * Resolve tool group for PostHog filtering — derived from the tool registry,
 * with a prefix-based fallback for dynamically registered SDK docs proxy tools
 * (docs_*) which are not in the registry.
 */
function resolveToolGroup(toolName: string): string {
  const module = getToolModule(toolName);
  if (module === "relay") return "relay";
  if (module === "sdkDocs") return "sdk-docs";
  if (module) return "api";
  if (toolName.startsWith("docs_")) return "sdk-docs";
  return "unknown";
}

// ── PostHog client (lazy singleton) ──────────────────────────────────
let client: PostHog | null = null;

function getClient(): PostHog | null {
  if (!POSTHOG_API_KEY) return null;
  if (!client) {
    client = new PostHog(POSTHOG_API_KEY, { host: POSTHOG_HOST });
  }
  return client;
}

// ── Client identification ────────────────────────────────────────────

/**
 * Hash an IP address to a privacy-safe client identifier, so the same IP
 * always maps to the same distinctId without storing raw IPs. With
 * POSTHOG_CLIENT_ID_SECRET set it is an HMAC, which can't be reversed by
 * hashing every IPv4 address; unset keeps the unkeyed salted SHA-256.
 */
export function hashClientIp(ip: string): string {
  const hash = CLIENT_ID_SECRET ? createHmac("sha256", CLIENT_ID_SECRET) : createHash("sha256");
  return hash.update(`sodax-mcp:${ip}`).digest("hex").slice(0, 16);
}

// ── Core tracking function ───────────────────────────────────────────
function trackToolCall(
  toolName: string,
  durationMs: number,
  success: boolean,
  clientId?: string,
  error?: string,
): void {
  const ph = getClient();
  if (!ph) return;

  ph.capture({
    distinctId: clientId || DISTINCT_ID,
    event: "tool_called",
    properties: {
      server: SERVER_NAME,
      tool_name: toolName,
      tool_group: resolveToolGroup(toolName),
      duration_ms: durationMs,
      success,
      ...(error && { error_message: error }),
      transport: process.env.TRANSPORT || "http",
    },
  });
}

// ── Server wrapper ───────────────────────────────────────────────────

/**
 * Monkey-patches server.tool() so every registered tool is
 * automatically wrapped with PostHog event tracking.
 *
 * Call this BEFORE registering any tools.
 *
 * @param clientId — optional hashed client identifier for unique-user tracking.
 *                   Pass hashClientIp(req.ip) from the request handler.
 */
export function withAnalytics(server: McpServer, clientId?: string): void {
  const originalTool = server.tool.bind(server);

  (server as unknown as { tool: (...args: unknown[]) => unknown }).tool = (...allArgs: unknown[]) => {
    const toolName = allArgs[0] as string;
    const lastIdx = allArgs.length - 1;
    const handler = allArgs[lastIdx];

    if (typeof handler === "function") {
      allArgs[lastIdx] = async (...handlerArgs: unknown[]) => {
        const start = Date.now();
        try {
          const result = await (handler as (...args: unknown[]) => unknown)(...handlerArgs);
          trackToolCall(toolName, Date.now() - start, true, clientId);
          return result;
        } catch (err) {
          trackToolCall(toolName, Date.now() - start, false, clientId, String(err));
          throw err;
        }
      };
    }

    return (originalTool as unknown as (...args: unknown[]) => unknown)(...allArgs);
  };
}

// ── Graceful shutdown ────────────────────────────────────────────────

/**
 * Flushes any pending events and closes the PostHog client.
 * Call on server shutdown to avoid losing the last batch of events.
 */
export async function shutdownAnalytics(): Promise<void> {
  if (client) {
    await client.shutdown();
    client = null;
  }
}
