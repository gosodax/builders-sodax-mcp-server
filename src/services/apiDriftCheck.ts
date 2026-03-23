/**
 * API Drift Check
 *
 * Fetches the live OpenAPI spec from the SODAX API at startup and compares
 * it against the MCP tools we expose. Logs warnings for any endpoints
 * that exist in the spec but are missing from the MCP server.
 *
 * This prevents the MCP server from silently falling behind the API.
 */

import axios from "axios";
import { SODAX_API_BASE_URL } from "../constants.js";

/**
 * Known API paths that are intentionally NOT exposed as MCP tools.
 * Add paths here with a reason to suppress drift warnings.
 */
const IGNORED_PATHS: Record<string, string> = {
  // No ignored paths yet — all API endpoints should be exposed.
};

/**
 * Map of API path patterns to MCP tool names.
 * Used to verify coverage. Path params are replaced with `:param`.
 */
const API_TO_TOOL_MAP: Record<string, string> = {
  "GET /config/all": "sodax_get_all_config",
  "GET /config/relay/chain-id-map": "sodax_get_relay_chain_id_map",
  "GET /config/spoke/chains": "sodax_get_supported_chains",
  "GET /config/spoke/all-chains-configs": "sodax_get_all_chains_configs",
  "GET /config/hub/assets": "sodax_get_hub_assets",
  "GET /config/hub/:chainId/assets": "sodax_get_hub_assets",
  "GET /config/swap/tokens": "sodax_get_swap_tokens",
  "GET /config/swap/:chainId/tokens": "sodax_get_swap_tokens",
  "GET /config/money-market/tokens": "sodax_get_money_market_tokens",
  "GET /config/money-market/reserve-assets": "sodax_get_money_market_reserve_assets",
  "GET /config/money-market/:chainId/tokens": "sodax_get_money_market_tokens",
  "GET /amm/nft-positions": "sodax_get_amm_positions",
  "GET /amm/pools/:chainId/:poolId/candles": "sodax_get_amm_pool_candles",
  "GET /intent/tx/:txHash": "sodax_get_transaction",
  "GET /intent/user/:userAddress": "sodax_get_user_transactions",
  "GET /intent/:intentHash": "sodax_get_intent",
  "GET /solver/orderbook": "sodax_get_orderbook",
  "GET /solver/volume": "sodax_get_volume",
  "GET /solver/intents/:intentHash": "sodax_get_solver_intent",
  "GET /moneymarket/position/:userAddress": "sodax_get_user_position",
  "GET /moneymarket/asset/all": "sodax_get_money_market_assets",
  "GET /moneymarket/asset/:reserveAddress": "sodax_get_money_market_asset",
  "GET /moneymarket/asset/:reserveAddress/borrowers": "sodax_get_asset_borrowers",
  "GET /moneymarket/asset/:reserveAddress/suppliers": "sodax_get_asset_suppliers",
  "GET /moneymarket/borrowers": "sodax_get_all_borrowers",
  "GET /partners": "sodax_get_partners",
  "GET /partners/:receiver/summary": "sodax_get_partner_summary",
  "GET /sodax/total_supply": "sodax_get_total_supply",
  "GET /sodax/circulating_supply": "sodax_get_circulating_supply",
  "GET /sodax/supply": "sodax_get_token_supply",
};

/**
 * Normalize an OpenAPI path with {param} placeholders to :param format.
 */
function normalizePath(path: string): string {
  return path.replace(/\{([^}]+)\}/g, ":$1");
}

/**
 * Run the drift check. Call this at startup (non-blocking).
 * Logs warnings to stderr — never throws.
 */
export async function checkApiDrift(): Promise<void> {
  try {
    const response = await axios.get(`${SODAX_API_BASE_URL}/docs-json`, {
      timeout: 10000,
    });

    const spec = response.data;
    if (!spec?.paths) {
      console.error("⚠️  API drift check: could not parse OpenAPI spec");
      return;
    }

    const missing: string[] = [];

    for (const [path, methods] of Object.entries(spec.paths)) {
      for (const method of Object.keys(methods as object)) {
        const normalized = normalizePath(path);
        const key = `${method.toUpperCase()} ${normalized}`;

        if (IGNORED_PATHS[key]) continue;

        if (!API_TO_TOOL_MAP[key]) {
          missing.push(key);
        }
      }
    }

    if (missing.length === 0) {
      console.error(`✅ API drift check: all ${Object.keys(API_TO_TOOL_MAP).length} API endpoints are covered by MCP tools`);
    } else {
      console.error(`⚠️  API drift check: ${missing.length} API endpoint(s) have no MCP tool:`);
      for (const endpoint of missing) {
        console.error(`   - ${endpoint}`);
      }
      console.error(`   → Add tools for these in src/tools/sodaxApi.ts and update the map in src/services/apiDriftCheck.ts`);
    }
  } catch (error) {
    console.error("⚠️  API drift check: could not fetch OpenAPI spec —", error instanceof Error ? error.message : error);
  }
}
