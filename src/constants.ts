/**
 * Constants for the SODAX Builders MCP Server
 */

// SODAX API Base URL (Backend API)
export const SODAX_API_BASE_URL = "https://api.sodax.com/v1/be";

// SODAX Solver API Base URL (intent oracle + quote)
export const SODAX_SOLVER_BASE_URL = "https://api.sodax.com/v1/intent";

// SODAX Intent Relay API Base URL (xCall relay hosted by ICON)
export const SODAX_RELAY_BASE_URL = "https://xcall-relay.nw.iconblockchain.xyz";

// Cache duration in milliseconds (2 minutes for live data)
export const CACHE_DURATION_MS = 2 * 60 * 1000;

// Spoke chains excluded from the public "integrated networks" count.
// ICON (0x1.icon) is being wound down, so it's filtered out — this mirrors
// the frontend's stats.ts fetchIntegratedNetworksCount() source of truth.
export const NETWORK_COUNT_EXCLUDED_CHAIN_IDS: readonly string[] = ["0x1.icon"];

// SODAX Brand Colors (for reference)
export const BRAND_COLORS = {
  cherry: "#E53935",
  cream: "#FFF8E7",
  espresso: "#1A1A1A",
  accent: "#FFD54F",
} as const;
