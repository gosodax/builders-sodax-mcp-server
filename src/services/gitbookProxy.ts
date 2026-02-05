/**
 * GitBook MCP Proxy Service
 * 
 * Connects to the SODAX SDK documentation MCP server (GitBook)
 * and proxies its tools through our builders server.
 * 
 * This keeps SDK docs in sync as docs.sodax.com updates.
 */

import axios, { AxiosInstance } from "axios";

// GitBook MCP endpoint
const GITBOOK_MCP_URL = "https://docs.sodax.com/~gitbook/mcp";

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

// Create axios instance for GitBook MCP
const mcpClient: AxiosInstance = axios.create({
  baseURL: GITBOOK_MCP_URL,
  timeout: 30000,
  headers: {
    "Content-Type": "application/json",
    "Accept": "application/json"
  }
});

/**
 * Send a JSON-RPC request to the GitBook MCP
 */
async function sendMcpRequest(method: string, params?: unknown): Promise<unknown> {
  const response = await mcpClient.post("", {
    jsonrpc: "2.0",
    id: Date.now(),
    method,
    params: params || {}
  });
  
  if (response.data.error) {
    throw new Error(response.data.error.message || "MCP request failed");
  }
  
  return response.data.result;
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
        version: "1.0.0"
      }
    });
    
    // Send initialized notification
    await mcpClient.post("", {
      jsonrpc: "2.0",
      method: "notifications/initialized"
    });
  } catch (error) {
    // Some servers don't require initialization, continue anyway
    console.error("GitBook MCP init (optional):", error instanceof Error ? error.message : "unknown");
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
    const result = await sendMcpRequest("tools/list") as { tools: GitBookTool[] };
    
    cachedTools = result.tools || [];
    toolsCacheTime = Date.now();
    
    console.error(`Fetched ${cachedTools.length} tools from GitBook MCP`);
    return cachedTools;
  } catch (error) {
    console.error("Failed to fetch GitBook tools:", error instanceof Error ? error.message : "unknown");
    // Return cached tools even if expired, or empty array
    return cachedTools || [];
  }
}

/**
 * Call a tool on the GitBook MCP server
 */
export async function callGitBookTool(
  toolName: string, 
  args: Record<string, unknown>
): Promise<GitBookToolResult> {
  try {
    // Ensure connection is initialized
    await initializeConnection();
    
    const result = await sendMcpRequest("tools/call", {
      name: toolName,
      arguments: args
    }) as GitBookToolResult;
    
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return {
      content: [{ type: "text", text: `Error calling GitBook tool: ${message}` }],
      isError: true
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
