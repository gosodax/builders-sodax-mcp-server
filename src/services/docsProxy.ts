/**
 * SODAX Docs MCP Proxy Service
 *
 * Connects to the SODAX developer-docs MCP server at docs.sodax.com and proxies
 * its documentation tools through our builders server, so conceptual questions
 * ("is chain X supported?", "how does the bridge module work?") land on live
 * docs search instead of the model's stale training priors.
 *
 * History: docs.sodax.com migrated from GitBook to Mintlify. The old
 * `/~gitbook/mcp` endpoint now returns HTTP 405; this proxy targets the
 * Mintlify endpoint `/mcp` (MCP protocol 2025-06-18, SSE-framed HTTP).
 */

import { logger } from "./logger.js";

// SODAX docs MCP endpoint (Mintlify). The retired GitBook endpoint was
// `https://docs.sodax.com/~gitbook/mcp` and now 405s.
const DOCS_MCP_URL = "https://docs.sodax.com/mcp";
const DOCS_TIMEOUT_MS = 30_000;
const DOCS_PROTOCOL_VERSION = "2025-06-18";

/**
 * Only these upstream tools are proxied. The docs MCP is an untrusted,
 * third-party-operated surface whose tool set can change without notice, so we
 * register a fixed allowlist rather than whatever it happens to return: this
 * keeps the write-capable `submit_feedback` tool it also exposes out of our
 * read-only server, and stops a compromised/altered upstream from introducing
 * arbitrary attacker-named tools into clients. New read tools are added here
 * deliberately after review.
 */
const DOCS_TOOL_ALLOWLIST: ReadonlySet<string> = new Set(["search_sodax_docs", "query_docs_filesystem_sodax_docs"]);

// Cache for tools list (refresh every 10 minutes)
let cachedTools: DocsTool[] | null = null;
let toolsCacheTime = 0;
const TOOLS_CACHE_DURATION = 10 * 60 * 1000; // 10 minutes

// Negative cache. createServer() awaits fetchDocsTools() on EVERY /mcp and /sse
// request, so without a back-off a failed or empty fetch would make each request
// re-run the initialize + tools/list round-trips (up to 30s each when upstream
// hangs). After a failed or empty fetch we serve whatever is cached (possibly
// nothing) for this long before trying upstream again. Startup warm-up and
// docs_refresh bypass it via `force` / clearDocsCache().
const FAILED_FETCH_BACKOFF_MS = 60 * 1000;
let lastFailedFetchAt = 0;

// MCP session id, if the docs server issues one via the `Mcp-Session-Id`
// response header. Mintlify currently answers statelessly (no session), so this
// stays null; captured and echoed back defensively in case that changes.
let sessionId: string | null = null;

export interface DocsTool {
  name: string;
  description: string;
  inputSchema: {
    type: string;
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

export interface DocsToolResult {
  content: Array<{
    type: string;
    text?: string;
    [key: string]: unknown;
  }>;
  isError?: boolean;
}

/**
 * The docs MCP returns either plain JSON or SSE-framed JSON
 * (`event: message\ndata: {...}\n\n`). Pull the JSON out either way.
 * Returns the raw text if it parses as neither — notifications come back
 * with an empty body and shouldn't surface as errors.
 */
function parseDocsResponse(text: string): unknown {
  if (!text) return text;
  if (/^(event:|data:)/m.test(text)) {
    for (const line of text.split("\n")) {
      if (line.startsWith("data:")) {
        const jsonStr = line.slice(5).trim();
        try {
          return JSON.parse(jsonStr);
        } catch {
          // fall through to plain-JSON parse
        }
      }
    }
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function postDocs(body: unknown): Promise<unknown> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;

  const response = await fetch(DOCS_MCP_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(DOCS_TIMEOUT_MS),
  });

  // Capture a session id if the server starts issuing one.
  const issued = response.headers.get("mcp-session-id");
  if (issued) sessionId = issued;

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText} from SODAX docs MCP`);
  }

  const text = await response.text();
  return parseDocsResponse(text);
}

/**
 * Send a JSON-RPC request to the docs MCP
 */
async function sendMcpRequest(method: string, params?: unknown): Promise<unknown> {
  const raw = await postDocs({
    jsonrpc: "2.0",
    id: Date.now(),
    method,
    params: params || {},
  });

  if (typeof raw !== "object" || raw === null) {
    const preview = typeof raw === "string" ? raw.slice(0, 200) : String(raw);
    throw new Error(`MCP ${method}: expected JSON-RPC object, got ${typeof raw} (${preview})`);
  }

  const data = raw as { error?: { message?: string }; result?: unknown };
  if (data.error) {
    throw new Error(data.error.message || "MCP request failed");
  }

  return data.result;
}

/**
 * Initialize the MCP connection (required by some servers)
 */
async function initializeConnection(): Promise<void> {
  try {
    await sendMcpRequest("initialize", {
      protocolVersion: DOCS_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: {
        name: "builders-sodax-mcp-server",
        version: "1.0.0",
      },
    });

    // Send initialized notification (fire-and-forget; response is ignored)
    await postDocs({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
  } catch (error) {
    // Some servers don't require initialization, continue anyway
    logger.debug({ err: error }, "docs MCP init (optional) failed");
  }
}

/**
 * Fetch available (allowlisted) tools from the docs MCP server
 */
export async function fetchDocsTools(options: { force?: boolean } = {}): Promise<DocsTool[]> {
  // Return cached tools if still valid. An EMPTY cache is deliberately not
  // treated as a valid hit: caching `[]` (upstream up but no allowlisted tools,
  // e.g. a tool rename) would otherwise poison the cache for the full TTL, so an
  // empty result is only held for the short FAILED_FETCH_BACKOFF_MS window, and
  // warmDocsCache's startup retries pass `force` to skip even that.
  if (cachedTools && cachedTools.length > 0 && Date.now() - toolsCacheTime < TOOLS_CACHE_DURATION) {
    return cachedTools;
  }
  if (!options.force && Date.now() - lastFailedFetchAt < FAILED_FETCH_BACKOFF_MS) {
    return cachedTools || [];
  }

  try {
    // Initialize connection first
    await initializeConnection();

    // Fetch tools list
    const result = (await sendMcpRequest("tools/list")) as { tools: DocsTool[] };
    const upstream = result.tools || [];
    const allowed = upstream.filter(t => DOCS_TOOL_ALLOWLIST.has(t.name));

    const dropped = upstream.filter(t => !DOCS_TOOL_ALLOWLIST.has(t.name)).map(t => t.name);
    if (dropped.length > 0) {
      logger.debug({ dropped }, "docs MCP: ignoring non-allowlisted upstream tools");
    }

    cachedTools = allowed;
    toolsCacheTime = Date.now();

    if (cachedTools.length > 0) {
      lastFailedFetchAt = 0;
      logger.debug({ toolCount: cachedTools.length }, "Fetched tools from SODAX docs MCP");
    } else {
      lastFailedFetchAt = Date.now();
      logger.warn({ upstreamCount: upstream.length }, "SODAX docs MCP returned no allowlisted tools");
    }
    return cachedTools;
  } catch (error) {
    lastFailedFetchAt = Date.now();
    logger.error({ err: error }, "Failed to fetch SODAX docs tools");
    // Return cached tools even if expired, or empty array
    return cachedTools || [];
  }
}

/**
 * Call a tool on the docs MCP server
 */
export async function callDocsTool(toolName: string, args: Record<string, unknown>): Promise<DocsToolResult> {
  // Defence in depth: never forward a call to a non-allowlisted upstream tool,
  // even if a caller somehow constructs the name.
  if (!DOCS_TOOL_ALLOWLIST.has(toolName)) {
    return {
      content: [{ type: "text", text: `Unknown docs tool: ${toolName}` }],
      isError: true,
    };
  }

  try {
    // Ensure connection is initialized
    await initializeConnection();

    const result = (await sendMcpRequest("tools/call", {
      name: toolName,
      arguments: args,
    })) as DocsToolResult;

    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return {
      content: [{ type: "text", text: `Error calling SODAX docs tool: ${message}` }],
      isError: true,
    };
  }
}

/**
 * Check if the docs MCP is reachable
 */
export async function checkDocsHealth(): Promise<{ healthy: boolean; toolCount: number }> {
  try {
    await fetchDocsTools();
    return getCachedDocsHealth();
  } catch {
    return { healthy: false, toolCount: 0 };
  }
}

/**
 * Names of the currently cached docs tools WITHOUT triggering a network
 * fetch. Returns a fresh array of the cached tool names (even if expired), or an
 * empty array if nothing has been cached yet. Names are immutable strings and
 * the array is a copy, so callers cannot mutate the cache through it. Lets
 * display-count callers avoid blocking on a 30s docs request when the cache
 * is cold or expired.
 */
export function getCachedDocsToolNames(): string[] {
  return (cachedTools ?? []).map(t => t.name);
}

/**
 * Docs proxy health derived from the current cache WITHOUT a network fetch:
 * `healthy` is true only while tools are cached AND the most recent fetch
 * succeeded — a failed or empty refresh flips it to false even though the
 * stale tools stay cached and registered, so a docs endpoint that moves or
 * goes down after a good fetch is still reported. `toolCount` is the cached
 * proxy-tool count. Lets `/health` report proxy
 * status without blocking up to 30s on a live fetch when the docs MCP is
 * unreachable — unlike `checkDocsHealth()`, which awaits `fetchDocsTools()`.
 */
export function getCachedDocsHealth(): { healthy: boolean; toolCount: number } {
  const toolCount = cachedTools?.length ?? 0;
  return { healthy: toolCount > 0 && lastFailedFetchAt === 0, toolCount };
}

/**
 * Clear the tools cache to force a refresh
 */
export function clearDocsCache(): void {
  cachedTools = null;
  toolsCacheTime = 0;
  lastFailedFetchAt = 0;
}
