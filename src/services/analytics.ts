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
import { CHAIN_KEY_PATTERN, ERROR_CODE_PATTERN } from "../constants.js";
import { errorName, logger } from "./logger.js";
import { callerKeyTag, getRequestContext, runWithRequestContext } from "./requestContext.js";
import { SERVER_SIDE_CODES, type ToolFailure, classifyFailure, failureOf } from "./toolFailure.js";
import { getToolModule, toolGroup } from "./toolRegistry.js";

// ── Configuration ────────────────────────────────────────────────────
const POSTHOG_API_KEY = process.env.POSTHOG_API_KEY || "";
const POSTHOG_HOST = process.env.POSTHOG_HOST || "https://eu.i.posthog.com";
const DISTINCT_ID = process.env.POSTHOG_DISTINCT_ID || "sodax-builders-mcp";
const SERVER_NAME = process.env.POSTHOG_SERVER_NAME || "builders-mcp";
const CLIENT_ID_SECRET = process.env.POSTHOG_CLIENT_ID_SECRET || "";
export const POSTHOG_ENABLED = POSTHOG_API_KEY !== "";
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
 * A data tool's failure code rides on the result object (toolFailure.ts), outside what the agent gets.
 * Undefined fields are dropped when the event is serialized.
 */
function resultOutcome(toolName: string, result: unknown): Outcome {
  const { isError, structuredContent } = (result ?? {}) as { isError?: boolean; structuredContent?: SwapOutput };
  const out = structuredContent ?? {};
  return {
    success: isError !== true,
    error_code: matching(out.error?.code ?? failureOf(result)?.code, ERROR_CODE_PATTERN),
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
 * tool, the ids its records are followed by. Nothing from the arguments. The level says whose failure it is:
 * error for a bug (with where it broke), warn for SODAX's side, info for the caller's.
 */
function logToolCall(
  toolName: string,
  durationMs: number,
  outcome: Outcome,
  result: unknown,
  failure: ToolFailure | undefined = failureOf(result),
): void {
  const out = ((result ?? {}) as { structuredContent?: Record<string, unknown> }).structuredContent ?? {};
  const str = (value: unknown) => (typeof value === "string" ? value : undefined);
  // By the key, not the value: a bug may throw undefined.
  const bug = failure !== undefined && "thrown" in failure;
  const code = str(outcome.error_code);
  const level = bug ? "error" : code && SERVER_SIDE_CODES.has(code) ? "warn" : "info";
  logger[level](
    {
      err: bug ? whereThrown(failure.thrown) : undefined,
      "gen_ai.tool.name": toolName,
      "duration.ms": durationMs,
      "tool.outcome": outcome.success ? "ok" : "error",
      "error.type": outcome.error_code,
      // Not `api_key.*`: the gateway's redaction masks values under any key that names an API key.
      "caller.key_hash": callerKeyTag(),
      ...(resolveToolGroup(toolName) === "swap" && {
        "swap.status": str(out.status),
        "quote.id": str(out.quoteId),
        "tx.hash": str(out.txHash),
        "hub_tx.hash": str(out.hubTxHash),
        "intent.hash": str(out.intentHash),
        "chain.key": outcome.src_chain,
        "dst_chain.key": outcome.dst_chain,
        "swap.usd_bucket": outcome.usd_bucket,
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
  // A refused call is named only when its tool exists: registered here, or in the registry (a swap tool called without
  // a key). `handled` holds the calls that reached a handler, so only the SDK's own refusals are logged below.
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
            // Named as a returned failure would be, but logged as a bug whatever its cause: tools return their failures.
            const { code } = classifyFailure(err);
            logToolCall(toolName, durationMs, { success: false, error_code: code }, undefined, { code, thrown: err });
            trackToolCall(
              toolName,
              durationMs,
              { success: false, error_code: code, error_message: String(err) },
              clientId,
            );
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
            registered.has(name) || getToolModule(name) ? name : "other",
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
