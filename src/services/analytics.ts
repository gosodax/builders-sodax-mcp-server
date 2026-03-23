/**
 * Analytics Service — PostHog integration
 *
 * Tracks every MCP tool call automatically via a server.tool() wrapper.
 * Events are sent asynchronously and never block tool responses.
 *
 * Set POSTHOG_API_KEY in your environment to enable tracking.
 * When unset, all tracking is silently skipped.
 */

import { PostHog } from "posthog-node";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// ── Configuration ────────────────────────────────────────────────────
const POSTHOG_API_KEY = process.env.POSTHOG_API_KEY || "";
const POSTHOG_HOST =
  process.env.POSTHOG_HOST || "https://eu.i.posthog.com";
const DISTINCT_ID =
  process.env.POSTHOG_DISTINCT_ID || "sodax-builders-mcp";
const SERVER_NAME =
  process.env.POSTHOG_SERVER_NAME || "builders-mcp";

// ── Tool → Group mapping ─────────────────────────────────────────────
// Map every tool name to a logical group for PostHog filtering.
// Update this when you add or remove tools.
const TOOL_GROUPS: Record<string, string> = {
  // SODAX API tools — config
  sodax_get_supported_chains: "api",
  sodax_get_swap_tokens: "api",
  sodax_get_all_config: "api",
  sodax_get_relay_chain_id_map: "api",
  sodax_get_all_chains_configs: "api",
  sodax_get_hub_assets: "api",
  sodax_get_money_market_tokens: "api",
  sodax_get_money_market_reserve_assets: "api",

  // SODAX API tools — intents & solver
  sodax_get_transaction: "api",
  sodax_get_user_transactions: "api",
  sodax_get_intent: "api",
  sodax_get_volume: "api",
  sodax_get_orderbook: "api",
  sodax_get_solver_intent: "api",

  // SODAX API tools — AMM
  sodax_get_amm_positions: "api",
  sodax_get_amm_pool_candles: "api",

  // SODAX API tools — money market
  sodax_get_money_market_assets: "api",
  sodax_get_money_market_asset: "api",
  sodax_get_asset_borrowers: "api",
  sodax_get_asset_suppliers: "api",
  sodax_get_all_borrowers: "api",
  sodax_get_user_position: "api",

  // SODAX API tools — partners & token
  sodax_get_partners: "api",
  sodax_get_partner_summary: "api",
  sodax_get_token_supply: "api",
  sodax_get_total_supply: "api",
  sodax_get_circulating_supply: "api",
  sodax_refresh_cache: "api",

  // GitBook SDK docs meta-tools
  docs_health: "sdk-docs",
  docs_refresh: "sdk-docs",
  docs_list_tools: "sdk-docs",
};

/**
 * Resolve tool group — static map first, then prefix-based fallback
 * for dynamically registered GitBook proxy tools (docs_*).
 */
function resolveToolGroup(toolName: string): string {
  if (TOOL_GROUPS[toolName]) return TOOL_GROUPS[toolName];
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

// ── Core tracking function ───────────────────────────────────────────
function trackToolCall(
  toolName: string,
  durationMs: number,
  success: boolean,
  error?: string
): void {
  const ph = getClient();
  if (!ph) return;

  ph.capture({
    distinctId: DISTINCT_ID,
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
 */
export function withAnalytics(server: McpServer): void {
  const originalTool = server.tool.bind(server);

  (server as any).tool = function (...allArgs: any[]) {
    const toolName = allArgs[0] as string;
    const lastIdx = allArgs.length - 1;
    const handler = allArgs[lastIdx];

    if (typeof handler === "function") {
      allArgs[lastIdx] = async (...handlerArgs: any[]) => {
        const start = Date.now();
        try {
          const result = await handler(...handlerArgs);
          trackToolCall(toolName, Date.now() - start, true);
          return result;
        } catch (err) {
          trackToolCall(toolName, Date.now() - start, false, String(err));
          throw err;
        }
      };
    }

    return (originalTool as any)(...allArgs);
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
