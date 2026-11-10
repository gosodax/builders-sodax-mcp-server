/**
 * Analytics Service — PostHog integration, and the per-call records for unified logging (#110).
 *
 * Wraps every MCP tool call through server.tool(): each call runs under its own `request.id`, gets one
 * "Tool call" log record (outcome, duration, the ids a swap is followed by), and one PostHog event.
 * Events are sent asynchronously and never block tool responses.
 *
 * Set POSTHOG_API_KEY in your environment to enable tracking.
 * When unset, all tracking is silently skipped.
 */

import { createHash, createHmac, randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { PostHog } from "posthog-node";
import { CHAIN_KEY_PATTERN } from "../constants.js";
import { errorName, logger } from "./logger.js";
import { callerKeyHash, getRequestContext, runWithRequestContext } from "./requestContext.js";
import { getToolModule, toolGroup } from "./toolRegistry.js";

// ── Configuration ────────────────────────────────────────────────────
const POSTHOG_API_KEY = process.env.POSTHOG_API_KEY || "";
const POSTHOG_HOST = process.env.POSTHOG_HOST || "https://eu.i.posthog.com";
const DISTINCT_ID = process.env.POSTHOG_DISTINCT_ID || "sodax-builders-mcp";
const SERVER_NAME = process.env.POSTHOG_SERVER_NAME || "builders-mcp";
const CLIENT_ID_SECRET = process.env.POSTHOG_CLIENT_ID_SECRET || "";
/** With the secret the id is an HMAC, so it can be stored in logs; the plain hash could be brute-forced back to the IP. */
export const CLIENT_ID_KEYED = CLIENT_ID_SECRET !== "";

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

/**
 * One log record per tool call (#110): the outcome, who called (a key hash, never the key) and, for a swap
 * tool, the ids its records are followed by. Nothing from the arguments.
 */
function logToolCall(toolName: string, durationMs: number, outcome: Outcome, result: unknown, thrown?: unknown): void {
  const out = ((result ?? {}) as { structuredContent?: Record<string, unknown> }).structuredContent ?? {};
  const str = (value: unknown) => (typeof value === "string" ? value : undefined);
  // Tools return their failures as `isError`; a throw is a bug, so where it broke goes with the record.
  logger[thrown === undefined ? "info" : "error"](
    {
      err: thrown,
      "tool.name": toolName,
      "duration.ms": durationMs,
      "tool.outcome": outcome.success ? "ok" : "error",
      "error.code": outcome.error_code,
      // Not `api_key.*`: the gateway's redaction masks values under any key that names an API key.
      "caller.key_hash": getRequestContext().apiKey ? callerKeyHash().slice(0, 16) : undefined,
      ...(resolveToolGroup(toolName) === "swap" && {
        "swap.status": str(out.status),
        "quote.id": str(out.quoteId),
        "tx.hash": str(out.txHash),
        "hub_tx.hash": str(out.hubTxHash),
        "intent.hash": str(out.intentHash),
        "chain.key": outcome.src_chain,
      }),
    },
    "Tool call",
  );
}

/** A thrown error's class and frames, without its message: the text may echo what the agent sent. */
function whereThrown(error: unknown): { type: string; stack?: string } {
  const frames = error instanceof Error ? error.stack?.split("\n").filter(line => line.startsWith("    at ")) : [];
  return { type: errorName(error), ...(frames?.length && { stack: frames.join("\n") }) };
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
  // The names registered here, so a refused call is named only when its tool exists; and the calls that reached a
  // handler, so the SDK's own refusals (unknown tool, invalid arguments) are the only ones logged below.
  const registered = new Set<string>();
  const handled = new WeakSet<object>();

  (server as unknown as { tool: (...args: unknown[]) => unknown }).tool = (...allArgs: unknown[]) => {
    const toolName = allArgs[0] as string;
    registered.add(toolName);
    const lastIdx = allArgs.length - 1;
    const handler = allArgs[lastIdx];

    if (typeof handler === "function") {
      const run = handler as (...args: unknown[]) => unknown;
      // Every record of one call carries a `request.id` (#110): the HTTP request's when there is one, else its own (stdio).
      allArgs[lastIdx] = (...handlerArgs: unknown[]) => {
        const extra = handlerArgs.at(-1);
        if (extra && typeof extra === "object") handled.add(extra);
        const context = getRequestContext();
        return runWithRequestContext({ ...context, requestId: context.requestId ?? randomUUID() }, async () => {
          const start = Date.now();
          try {
            const result = await run(...handlerArgs);
            const outcome = resultOutcome(toolName, result);
            const durationMs = Date.now() - start;
            logToolCall(toolName, durationMs, outcome, result);
            trackToolCall(toolName, durationMs, outcome, clientId);
            return result;
          } catch (err) {
            const durationMs = Date.now() - start;
            logToolCall(
              toolName,
              durationMs,
              { success: false, error_code: errorName(err) },
              undefined,
              whereThrown(err),
            );
            trackToolCall(toolName, durationMs, { success: false, error_message: String(err) }, clientId);
            throw err;
          }
        });
      };
    }

    return (originalTool as unknown as (...args: unknown[]) => unknown)(...allArgs);
  };

  // The SDK answers an unknown tool or invalid arguments itself, as `isError`, before any handler runs (#110): that
  // call gets its record here. `server.server` is the protocol layer McpServer installs its tools/call handler on.
  const protocol = server.server as unknown as {
    setRequestHandler: (schema: unknown, handler: CallToolHandler) => void;
  };
  const originalSetRequestHandler = protocol.setRequestHandler.bind(protocol);
  protocol.setRequestHandler = (schema, handler) =>
    originalSetRequestHandler(schema, schema === CallToolRequestSchema ? withRefusalRecords(handler) : handler);

  function withRefusalRecords(handler: CallToolHandler): CallToolHandler {
    return async (request, extra) => {
      const start = Date.now();
      const result = (await handler(request, extra)) as
        | { isError?: boolean; content?: { text?: unknown }[] }
        | undefined;
      if (result?.isError && !handled.has(extra)) {
        const name = request.params.name;
        const context = getRequestContext();
        runWithRequestContext({ ...context, requestId: context.requestId ?? randomUUID() }, () =>
          logToolCall(
            registered.has(name) ? name : "other",
            Date.now() - start,
            { success: false, error_code: refusalCode(result) },
            undefined,
          ),
        );
      }
      return result;
    };
  }
}

type CallToolHandler = (request: { params: { name: string } }, extra: object) => unknown;

/** The SDK's refusal, by its message's shape (an McpError's, "MCP error -32602: " first); anything else is a code too. */
function refusalCode(result: { content?: { text?: unknown }[] }): string {
  const raw = typeof result.content?.[0]?.text === "string" ? result.content[0].text : "";
  const text = raw.replace(/^MCP error -?\d+: /, "");
  if (text.endsWith(" not found")) return "TOOL_NOT_FOUND";
  if (text.startsWith("Input validation error")) return "INVALID_ARGUMENTS";
  if (text.endsWith(" disabled")) return "TOOL_DISABLED";
  return "TOOL_CALL_REFUSED";
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
