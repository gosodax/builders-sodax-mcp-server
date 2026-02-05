/**
 * Constants for the SODAX Builders MCP Server
 */

// SODAX API Base URL
export const SODAX_API_BASE_URL = "https://api.sodax.com/v1";

// SODAX Aggregator API URL (for swap tokens)
export const SODAX_AGGREGATOR_URL = "https://aggregator.sodax.com/v1";

// Cache duration in milliseconds (2 minutes for live data)
export const CACHE_DURATION_MS = 2 * 60 * 1000;

// SODAX Brand Colors (for reference)
export const BRAND_COLORS = {
  cherry: "#E53935",
  cream: "#FFF8E7",
  espresso: "#1A1A1A",
  accent: "#FFD54F"
} as const;
