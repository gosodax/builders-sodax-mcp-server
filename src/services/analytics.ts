/**
 * Analytics Service — PostHog integration
 *
 * Tracks every MCP tool call automatically via a server.tool() wrapper.
 * Events are sent asynchronously and never block tool responses.
 *
 * Set POSTHOG_API_KEY in your environment to enable tracking.
 * When unset, all tracking is silently skipped.
 */

import { createHash } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PostHog } from "posthog-node";
import { CHAIN_KEY_PATTERN } from "../constants.js";
import { getToolModule, toolGroup } from "./toolRegistry.js";

// ── Configuration ────────────────────────────────────────────────────
const POSTHOG_API_KEY = process.env.POSTHOG_API_KEY || "";
const POSTHOG_HOST = process.env.POSTHOG_HOST || "https://eu.i.posthog.com";
const DISTINCT_ID = process.env.POSTHOG_DISTINCT_ID || "sodax-builders-mcp";
const SERVER_NAME = process.env.POSTHOG_SERVER_NAME || "builders-mcp";

/**
 * Resolve tool group for PostHog filtering — derived from the tool registry,
 * with a prefix-based fallback for dynamically registered SDK docs proxy tools
 * (docs_*) which are not in the registry.
 */
function resolveToolGroup(toolName: string): string {
  const module = getToolModule(toolName);
  const group = module ? toolGroup(module) : toolName.startsWith("docs_") ? "sdkDocs" : "unknown";
  return group === "sdkDocs" ? "sdk-docs" : group;
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
 * Hash an IP address to a privacy-safe client identifier.
 * Uses SHA-256 with a static salt so the same IP always maps to the
 * same distinctId, enabling unique-user counts in PostHog without
 * storing raw IPs.
 */
export function hashClientIp(ip: string): string {
  return createHash("sha256").update(`sodax-mcp:${ip}`).digest("hex").slice(0, 16);
}

// ── Core tracking function ───────────────────────────────────────────
function trackToolCall(toolName: string, durationMs: number, outcome: Outcome, clientId?: string): void {
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
      ...outcome,
      transport: process.env.TRANSPORT || "http",
    },
  });
}

// ── What a returned result may tell PostHog ──────────────────────────
type Outcome = Record<string, unknown> & { success: boolean };

const ERROR_CODE = /^[A-Z_]{1,40}$/;
const STATUS = /^[a-z_]{1,40}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const matching = (value: unknown, pattern: RegExp) =>
  typeof value === "string" && pattern.test(value) ? value : undefined;

/** The fields of a swap tool's output analytics may read; anything else is never looked at. */
interface SwapOutput {
  status?: unknown;
  quoteId?: unknown;
  usdValue?: unknown;
  chain?: { key?: unknown };
  from?: { chain?: { key?: unknown } };
  to?: { chain?: { key?: unknown } };
  error?: { code?: unknown };
}

/**
 * A returned result's outcome: tools report failures as `isError`, not by throwing. Swap tools add a
 * whitelist of fields, so a new output field never leaks: no addresses, amounts, tx hashes or queries.
 * Undefined fields are dropped when the event is serialized.
 */
function resultOutcome(toolName: string, result: unknown): Outcome {
  const { isError, structuredContent } = (result ?? {}) as { isError?: boolean; structuredContent?: SwapOutput };
  const out = structuredContent ?? {};
  return {
    success: isError !== true,
    error_code: matching(out.error?.code, ERROR_CODE),
    ...(resolveToolGroup(toolName) === "swap" && {
      status: matching(out.status, STATUS),
      quote_id: matching(out.quoteId, UUID),
      src_chain: matching(out.from?.chain?.key ?? out.chain?.key, CHAIN_KEY_PATTERN),
      dst_chain: matching(out.to?.chain?.key, CHAIN_KEY_PATTERN),
      usd_bucket: usdBucket(out.usdValue),
    }),
  };
}

function usdBucket(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const usd = typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(usd)) return "unknown";
  if (usd < 100) return "<100";
  if (usd < 1_000) return "100-1k";
  if (usd < 10_000) return "1k-10k";
  return usd < 100_000 ? "10k-100k" : "100k+";
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
          trackToolCall(toolName, Date.now() - start, resultOutcome(toolName, result), clientId);
          return result;
        } catch (err) {
          trackToolCall(toolName, Date.now() - start, { success: false, error_message: String(err) }, clientId);
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
