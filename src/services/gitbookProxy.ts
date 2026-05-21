/**
 * GitBook MCP Proxy Service
 *
 * Connects to the SODAX SDK documentation MCP server (GitBook)
 * and proxies its tools through our builders server.
 *
 * This keeps SDK docs in sync as docs.sodax.com updates.
 */

import { logger } from "./logger.js";

// GitBook MCP endpoint
const GITBOOK_MCP_URL = "https://docs.sodax.com/~gitbook/mcp";
const GITBOOK_TIMEOUT_MS = 30_000;

// Cache for tools list (refresh every 10 minutes)
let cachedTools: GitBookTool[] | null = null;
let toolsCacheTime = 0;
const TOOLS_CACHE_DURATION = 10 * 60 * 1000; // 10 minutes

export interface GitBookTool {
  name: string;
  description: string;
  inputSchema: {
    type: string;
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

export interface GitBookToolResult {
  content: Array<{
    type: string;
    text?: string;
    [key: string]: unknown;
  }>;
  isError?: boolean;
}

/**
 * GitBook returns either plain JSON or SSE-framed JSON
 * (`event: message\ndata: {...}\n\n`). Pull the JSON out either way.
 * Returns the raw text if it parses as neither — notifications come back
 * with an empty body and shouldn't surface as errors.
 */
function parseGitBookResponse(text: string): unknown {
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

async function postGitBook(body: unknown): Promise<unknown> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), GITBOOK_TIMEOUT_MS);

  try {
    const response = await fetch(GITBOOK_MCP_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText} from GitBook MCP`);
    }

    const text = await response.text();
    return parseGitBookResponse(text);
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Send a JSON-RPC request to the GitBook MCP
 */
async function sendMcpRequest(method: string, params?: unknown): Promise<unknown> {
  const raw = await postGitBook({
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
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: {
        name: "builders-sodax-mcp-server",
        version: "1.0.0",
      },
    });

    // Send initialized notification (fire-and-forget; response is ignored)
    await postGitBook({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
  } catch (error) {
    // Some servers don't require initialization, continue anyway
    logger.debug({ err: error }, "GitBook MCP init (optional) failed");
  }
}

/**
 * Fetch available tools from the GitBook MCP server
 */
export async function fetchGitBookTools(): Promise<GitBookTool[]> {
  // Return cached tools if still valid
  if (cachedTools && Date.now() - toolsCacheTime < TOOLS_CACHE_DURATION) {
    return cachedTools;
  }

  try {
    // Initialize connection first
    await initializeConnection();

    // Fetch tools list
    const result = (await sendMcpRequest("tools/list")) as { tools: GitBookTool[] };

    cachedTools = result.tools || [];
    toolsCacheTime = Date.now();

    if (cachedTools.length > 0) {
      logger.debug({ toolCount: cachedTools.length }, "Fetched tools from GitBook MCP");
    } else {
      logger.warn("GitBook MCP returned empty tools list");
    }
    return cachedTools;
  } catch (error) {
    logger.error({ err: error }, "Failed to fetch GitBook tools");
    // Return cached tools even if expired, or empty array
    return cachedTools || [];
  }
}

/**
 * Call a tool on the GitBook MCP server
 */
export async function callGitBookTool(toolName: string, args: Record<string, unknown>): Promise<GitBookToolResult> {
  try {
    // Ensure connection is initialized
    await initializeConnection();

    const result = (await sendMcpRequest("tools/call", {
      name: toolName,
      arguments: args,
    })) as GitBookToolResult;

    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return {
      content: [{ type: "text", text: `Error calling GitBook tool: ${message}` }],
      isError: true,
    };
  }
}

/**
 * Check if the GitBook MCP is reachable
 */
export async function checkGitBookHealth(): Promise<{ healthy: boolean; toolCount: number }> {
  try {
    const tools = await fetchGitBookTools();
    return { healthy: true, toolCount: tools.length };
  } catch {
    return { healthy: false, toolCount: 0 };
  }
}

/**
 * Clear the tools cache to force a refresh
 */
export function clearGitBookCache(): void {
  cachedTools = null;
  toolsCacheTime = 0;
}
