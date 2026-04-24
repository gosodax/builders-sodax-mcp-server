/**
 * SODAX API Tools
 * 
 * MCP tool definitions for accessing live SODAX API data.
 * Provides 27 tools for developers and integration partners.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  getSupportedChains,
  getSwapTokens,
  getTransaction,
  getUserTransactions,
  getVolume,
  getOrderbook,
  getMoneyMarketAssets,
  getUserPosition,
  getPartners,
  getTokenSupply,
  getAllConfig,
  getRelayChainIdMap,
  getAllChainsConfigs,
  getHubAssets,
  getMoneyMarketTokens,
  getMoneyMarketReserveAssets,
  getAmmNftPositions,
  getAmmPoolCandles,
  getIntent,
  getSolverIntent,
  getMoneyMarketAsset,
  getMoneyMarketAssetBorrowers,
  getMoneyMarketAssetSuppliers,
  getMoneyMarketBorrowers,
  getPartnerSummary,
  getTotalSupply,
  getCirculatingSupply,
  clearCache,
  getCacheStats
} from "../services/sodaxApi.js";
import { ResponseFormat } from "../types.js";

/**
 * Format response based on requested format
 */
function formatResponse(data: unknown, format: ResponseFormat): string {
  if (format === ResponseFormat.MARKDOWN) {
    return formatAsMarkdown(data);
  }
  return JSON.stringify(data, null, 2);
}

/**
 * Format data as Markdown for better readability
 */
function formatAsMarkdown(data: unknown): string {
  if (Array.isArray(data)) {
    if (data.length === 0) return "_No data available_";
    
    // Try to create a table for arrays of objects
    if (typeof data[0] === "object" && data[0] !== null) {
      const keys = Object.keys(data[0]).slice(0, 6); // Limit columns
      let md = `| ${keys.join(" | ")} |\n`;
      md += `| ${keys.map(() => "---").join(" | ")} |\n`;
      for (const item of data.slice(0, 20)) { // Limit rows
        const values = keys.map(k => {
          const val = (item as Record<string, unknown>)[k];
          if (val === null || val === undefined) return "-";
          if (typeof val === "object") return JSON.stringify(val).slice(0, 30);
          return String(val).slice(0, 40);
        });
        md += `| ${values.join(" | ")} |\n`;
      }
      if (data.length > 20) {
        md += `\n_... and ${data.length - 20} more items_`;
      }
      return md;
    }
    return data.map(item => `- ${String(item)}`).join("\n");
  }
  
  if (typeof data === "object" && data !== null) {
    const entries = Object.entries(data);
    return entries.map(([key, value]) => {
      if (typeof value === "object" && value !== null) {
        return `**${key}:**\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
      }
      return `**${key}:** ${value}`;
    }).join("\n\n");
  }
  
  return String(data);
}

/**
 * Register all SODAX API tools with the MCP server
 */
// Shared annotations for read-only data-fetching tools
const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: true,
};

export function registerSodaxApiTools(server: McpServer): void {
  
  // Tool 1: Get Supported Chains
  server.tool(
    "sodax_get_supported_chains",
    "List all blockchain networks supported by SODAX for cross-chain swaps and DeFi operations",
    {
      format: z.nativeEnum(ResponseFormat).optional().default(ResponseFormat.MARKDOWN)
        .describe("Response format: 'json' for raw data or 'markdown' for formatted text")
    },
    READ_ONLY,
    async ({ format }) => {
      try {
        const chains = await getSupportedChains();
        return {
          content: [{
            type: "text",
            text: formatResponse(chains, format)
          }]
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : "Unknown error"}` }],
          isError: true
        };
      }
    }
  );

  // Tool 2: Get Swap Tokens
  server.tool(
    "sodax_get_swap_tokens",
    "Get available tokens for swapping on SODAX, optionally filtered by chain",
    {
      chainId: z.string().optional()
        .describe("Filter tokens by chain ID (e.g., 'base', 'ethereum', 'icon')"),
      format: z.nativeEnum(ResponseFormat).optional().default(ResponseFormat.MARKDOWN)
        .describe("Response format: 'json' for raw data or 'markdown' for formatted text")
    },
    READ_ONLY,
    async ({ chainId, format }) => {
      try {
        const tokens = await getSwapTokens(chainId);
        const summary = chainId 
          ? `## Swap Tokens on ${chainId}\n\n${tokens.length} tokens available\n\n`
          : `## All Swap Tokens\n\n${tokens.length} tokens available across all chains\n\n`;
        return {
          content: [{
            type: "text",
            text: summary + formatResponse(tokens, format)
          }]
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : "Unknown error"}` }],
          isError: true
        };
      }
    }
  );

  // Tool 3: Get Transaction
  server.tool(
    "sodax_get_transaction",
    "Look up a specific transaction by its hash to see status, amounts, and details",
    {
      txHash: z.string()
        .describe("The transaction hash to look up (e.g., '0x...')"),
      format: z.nativeEnum(ResponseFormat).optional().default(ResponseFormat.MARKDOWN)
        .describe("Response format: 'json' for raw data or 'markdown' for formatted text")
    },
    READ_ONLY,
    async ({ txHash, format }) => {
      try {
        const transaction = await getTransaction(txHash);
        if (!transaction) {
          return {
            content: [{ type: "text", text: `Transaction not found: ${txHash}` }]
          };
        }
        return {
          content: [{
            type: "text",
            text: `## Transaction Details\n\n${formatResponse(transaction, format)}`
          }]
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : "Unknown error"}` }],
          isError: true
        };
      }
    }
  );

  // Tool 4: Get User Transactions
  server.tool(
    "sodax_get_user_transactions",
    "Get intent/transaction history for a specific wallet address",
    {
      userAddress: z.string()
        .describe("The wallet address to look up (e.g., '0x...')"),
      limit: z.number().min(1).max(100).optional().default(20)
        .describe("Maximum number of transactions to return (1-100)"),
      offset: z.number().min(0).optional().default(0)
        .describe("Number of transactions to skip for pagination"),
      startDate: z.string().optional()
        .describe("Start date filter (ISO 8601, e.g. '2026-01-01'). Don't mix with fromTs/toTs."),
      endDate: z.string().optional()
        .describe("End date filter (ISO 8601). Don't mix with fromTs/toTs."),
      fromTs: z.number().optional()
        .describe("Start timestamp filter (unix seconds). Don't mix with startDate/endDate."),
      toTs: z.number().optional()
        .describe("End timestamp filter (unix seconds). Don't mix with startDate/endDate."),
      format: z.nativeEnum(ResponseFormat).optional().default(ResponseFormat.MARKDOWN)
        .describe("Response format: 'json' for raw data or 'markdown' for formatted text")
    },
    READ_ONLY,
    async ({ userAddress, limit, offset, startDate, endDate, fromTs, toTs, format }) => {
      try {
        const transactions = await getUserTransactions(userAddress, { limit, offset, startDate, endDate, fromTs, toTs });
        const header = `## Transactions for ${userAddress.slice(0, 10)}...${userAddress.slice(-8)}\n\n`;
        const summary = `${transactions.length} transactions found\n\n`;
        return {
          content: [{
            type: "text",
            text: header + summary + formatResponse(transactions, format)
          }]
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : "Unknown error"}` }],
          isError: true
        };
      }
    }
  );

  // Tool 5: Get Volume (Filled Intents)
  server.tool(
    "sodax_get_volume",
    "Get solver volume data showing filled intents with filtering and pagination. Requires inputToken and outputToken. Optional filters: chain, solver, block range OR time range (don't mix both).",
    {
      inputToken: z.string()
        .describe("REQUIRED: Input token address"),
      outputToken: z.string()
        .describe("REQUIRED: Output token address"),
      chainId: z.number().optional()
        .describe("Filter by chain ID (e.g., 146 for Sonic)"),
      solver: z.string().optional()
        .describe("Filter by solver address (0x0...0 for default solver)"),
      fromBlock: z.number().optional()
        .describe("Start block number (don't mix with since/until)"),
      toBlock: z.number().optional()
        .describe("End block number (don't mix with since/until)"),
      since: z.string().optional()
        .describe("Start time ISO format (don't mix with fromBlock/toBlock or fromTs/toTs)"),
      until: z.string().optional()
        .describe("End time ISO format (don't mix with fromBlock/toBlock or fromTs/toTs)"),
      fromTs: z.number().optional()
        .describe("Start timestamp (unix seconds). Don't mix with since/until or fromBlock/toBlock."),
      toTs: z.number().optional()
        .describe("End timestamp (unix seconds). Don't mix with since/until or fromBlock/toBlock."),
      sort: z.enum(["asc", "desc"]).optional().default("desc")
        .describe("Sort order by block number"),
      limit: z.number().min(1).max(100).optional().default(50)
        .describe("Maximum number of filled intents to return (1-100)"),
      includeData: z.boolean().optional().default(false)
        .describe("Include raw intent data in response"),
      cursor: z.string().optional()
        .describe("Pagination cursor from previous response's nextCursor"),
      format: z.nativeEnum(ResponseFormat).optional().default(ResponseFormat.MARKDOWN)
        .describe("Response format: 'json' for raw data or 'markdown' for formatted text")
    },
    READ_ONLY,
    async ({ inputToken, outputToken, chainId, solver, fromBlock, toBlock, since, until, fromTs, toTs, sort, limit, includeData, cursor, format }) => {
      try {
        const volume = await getVolume({
          chainId, inputToken, outputToken, solver,
          fromBlock, toBlock, since, until, fromTs, toTs,
          sort, limit, includeData, cursor
        });
        const header = `## SODAX Filled Intents\n\n`;
        const pagination = volume.hasMore && volume.nextCursor 
          ? `\n\n*Has more results. Use cursor: \`${volume.nextCursor.substring(0, 30)}...\`*`
          : "\n\n*No more results.*";
        return {
          content: [{
            type: "text",
            text: header + formatResponse(volume.items, format) + pagination
          }]
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : "Unknown error"}` }],
          isError: true
        };
      }
    }
  );

  // Tool 6: Get Orderbook
  server.tool(
    "sodax_get_orderbook",
    "Get current orderbook entries showing pending/open intents",
    {
      limit: z.number().min(1).max(100)
        .describe("REQUIRED: Maximum number of orders to return (1-100)"),
      offset: z.number().min(0)
        .describe("REQUIRED: Number of orders to skip for pagination"),
      format: z.nativeEnum(ResponseFormat).optional().default(ResponseFormat.MARKDOWN)
        .describe("Response format: 'json' for raw data or 'markdown' for formatted text")
    },
    READ_ONLY,
    async ({ limit, offset, format }) => {
      try {
        const orderbook = await getOrderbook({ limit, offset });
        return {
          content: [{
            type: "text",
            text: `## Orderbook\n\n${orderbook.length} orders found\n\n` + formatResponse(orderbook, format)
          }]
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : "Unknown error"}` }],
          isError: true
        };
      }
    }
  );

  // Tool 7: Get Money Market Assets
  server.tool(
    "sodax_get_money_market_assets",
    "List all assets available for lending and borrowing in the SODAX money market",
    {
      chainId: z.string().optional()
        .describe("Filter by chain ID"),
      format: z.nativeEnum(ResponseFormat).optional().default(ResponseFormat.MARKDOWN)
        .describe("Response format: 'json' for raw data or 'markdown' for formatted text")
    },
    READ_ONLY,
    async ({ chainId, format }) => {
      try {
        const assets = await getMoneyMarketAssets(chainId);
        const header = chainId 
          ? `## Money Market Assets on ${chainId}\n\n`
          : `## Money Market Assets\n\n`;
        return {
          content: [{
            type: "text",
            text: header + `${assets.length} assets available\n\n` + formatResponse(assets, format)
          }]
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : "Unknown error"}` }],
          isError: true
        };
      }
    }
  );

  // Tool 8: Get User Position
  server.tool(
    "sodax_get_user_position",
    "Get a user's lending and borrowing position in the money market",
    {
      userAddress: z.string()
        .describe("The wallet address to look up"),
      format: z.nativeEnum(ResponseFormat).optional().default(ResponseFormat.MARKDOWN)
        .describe("Response format: 'json' for raw data or 'markdown' for formatted text")
    },
    READ_ONLY,
    async ({ userAddress, format }) => {
      try {
        const position = await getUserPosition(userAddress);
        if (!position) {
          return {
            content: [{ type: "text", text: `No money market position found for ${userAddress}` }]
          };
        }
        return {
          content: [{
            type: "text",
            text: `## Money Market Position\n\n**Address:** ${userAddress}\n\n` + formatResponse(position, format)
          }]
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : "Unknown error"}` }],
          isError: true
        };
      }
    }
  );

  // Tool 9: Get Partners
  server.tool(
    "sodax_get_partners",
    "List all SODAX integration partners including wallets, DEXs, and other protocols",
    {
      chainId: z.number().int().optional()
        .describe("Filter partners by numeric chain ID (e.g. 146 for Sonic)"),
      format: z.nativeEnum(ResponseFormat).optional().default(ResponseFormat.MARKDOWN)
        .describe("Response format: 'json' for raw data or 'markdown' for formatted text")
    },
    READ_ONLY,
    async ({ chainId, format }) => {
      try {
        const partners = await getPartners(chainId);
        return {
          content: [{
            type: "text",
            text: `## SODAX Partners\n\n${partners.length} integration partners\n\n` + formatResponse(partners, format)
          }]
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : "Unknown error"}` }],
          isError: true
        };
      }
    }
  );

  // Tool 10: Get Token Supply
  server.tool(
    "sodax_get_token_supply",
    "Get SODA token supply information including total, circulating, and burned amounts",
    {
      format: z.nativeEnum(ResponseFormat).optional().default(ResponseFormat.MARKDOWN)
        .describe("Response format: 'json' for raw data or 'markdown' for formatted text")
    },
    READ_ONLY,
    async ({ format }) => {
      try {
        const supply = await getTokenSupply();
        return {
          content: [{
            type: "text",
            text: `## SODA Token Supply\n\n` + formatResponse(supply, format)
          }]
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : "Unknown error"}` }],
          isError: true
        };
      }
    }
  );

  // Tool 11: Get All Config
  server.tool(
    "sodax_get_all_config",
    "Get full SODAX configuration including all supported chains, swap tokens, and protocol settings in one call",
    {
      format: z.nativeEnum(ResponseFormat).optional().default(ResponseFormat.MARKDOWN)
        .describe("Response format: 'json' for raw data or 'markdown' for formatted text")
    },
    READ_ONLY,
    async ({ format }) => {
      try {
        const config = await getAllConfig();
        return {
          content: [{
            type: "text",
            text: `## SODAX Full Configuration\n\n` + formatResponse(config, format)
          }]
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : "Unknown error"}` }],
          isError: true
        };
      }
    }
  );

  // Tool 12: Get Relay Chain ID Map
  server.tool(
    "sodax_get_relay_chain_id_map",
    "Get mapping between chain IDs and intent relay chain IDs used by the SODAX relay network",
    {
      format: z.nativeEnum(ResponseFormat).optional().default(ResponseFormat.MARKDOWN)
        .describe("Response format: 'json' for raw data or 'markdown' for formatted text")
    },
    READ_ONLY,
    async ({ format }) => {
      try {
        const map = await getRelayChainIdMap();
        return {
          content: [{
            type: "text",
            text: `## Relay Chain ID Map\n\n` + formatResponse(map, format)
          }]
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : "Unknown error"}` }],
          isError: true
        };
      }
    }
  );

  // Tool 13: Get All Spoke Chain Configs
  server.tool(
    "sodax_get_all_chains_configs",
    "Get detailed configuration for all spoke chains including contract addresses, RPCs, and token configs",
    {
      format: z.nativeEnum(ResponseFormat).optional().default(ResponseFormat.MARKDOWN)
        .describe("Response format: 'json' for raw data or 'markdown' for formatted text")
    },
    READ_ONLY,
    async ({ format }) => {
      try {
        const configs = await getAllChainsConfigs();
        return {
          content: [{
            type: "text",
            text: `## Spoke Chain Configs\n\n` + formatResponse(configs, format)
          }]
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : "Unknown error"}` }],
          isError: true
        };
      }
    }
  );

  // Tool 14: Get Hub Assets
  server.tool(
    "sodax_get_hub_assets",
    "Get assets representing spoke tokens on the hub (Sonic) chain, optionally filtered by source chain",
    {
      chainId: z.string().optional()
        .describe("Filter by source chain ID (e.g., 'base', 'ethereum')"),
      format: z.nativeEnum(ResponseFormat).optional().default(ResponseFormat.MARKDOWN)
        .describe("Response format: 'json' for raw data or 'markdown' for formatted text")
    },
    READ_ONLY,
    async ({ chainId, format }) => {
      try {
        const assets = await getHubAssets(chainId);
        const header = chainId
          ? `## Hub Assets from ${chainId}\n\n`
          : `## All Hub Assets\n\n`;
        return {
          content: [{
            type: "text",
            text: header + formatResponse(assets, format)
          }]
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : "Unknown error"}` }],
          isError: true
        };
      }
    }
  );

  // Tool 15: Get Money Market Tokens
  server.tool(
    "sodax_get_money_market_tokens",
    "Get tokens supported for money market lending/borrowing, optionally filtered by chain",
    {
      chainId: z.string().optional()
        .describe("Filter by chain ID"),
      format: z.nativeEnum(ResponseFormat).optional().default(ResponseFormat.MARKDOWN)
        .describe("Response format: 'json' for raw data or 'markdown' for formatted text")
    },
    READ_ONLY,
    async ({ chainId, format }) => {
      try {
        const tokens = await getMoneyMarketTokens(chainId);
        const header = chainId
          ? `## Money Market Tokens on ${chainId}\n\n`
          : `## Money Market Tokens\n\n`;
        return {
          content: [{
            type: "text",
            text: header + formatResponse(tokens, format)
          }]
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : "Unknown error"}` }],
          isError: true
        };
      }
    }
  );

  // Tool 16: Get Money Market Reserve Assets
  server.tool(
    "sodax_get_money_market_reserve_assets",
    "Get money market reserve assets used as collateral backing",
    {
      format: z.nativeEnum(ResponseFormat).optional().default(ResponseFormat.MARKDOWN)
        .describe("Response format: 'json' for raw data or 'markdown' for formatted text")
    },
    READ_ONLY,
    async ({ format }) => {
      try {
        const assets = await getMoneyMarketReserveAssets();
        return {
          content: [{
            type: "text",
            text: `## Money Market Reserve Assets\n\n` + formatResponse(assets, format)
          }]
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : "Unknown error"}` }],
          isError: true
        };
      }
    }
  );

  // Tool 17: Get AMM NFT Positions
  server.tool(
    "sodax_get_amm_positions",
    "Get AMM liquidity provider NFT positions, optionally filtered by owner address",
    {
      owner: z.string().optional()
        .describe("Filter by owner wallet address"),
      offset: z.number().min(0).optional()
        .describe("Number of positions to skip for pagination"),
      limit: z.number().min(1).max(100).optional()
        .describe("Maximum number of positions to return"),
      format: z.nativeEnum(ResponseFormat).optional().default(ResponseFormat.MARKDOWN)
        .describe("Response format: 'json' for raw data or 'markdown' for formatted text")
    },
    READ_ONLY,
    async ({ owner, offset, limit, format }) => {
      try {
        const positions = await getAmmNftPositions({ owner, offset, limit });
        const header = owner
          ? `## AMM Positions for ${owner.slice(0, 10)}...${owner.slice(-8)}\n\n`
          : `## AMM Positions\n\n`;
        return {
          content: [{
            type: "text",
            text: header + formatResponse(positions, format)
          }]
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : "Unknown error"}` }],
          isError: true
        };
      }
    }
  );

  // Tool 18: Get AMM Pool Candles
  server.tool(
    "sodax_get_amm_pool_candles",
    "Get OHLCV candlestick chart data for an AMM pool",
    {
      chainId: z.string()
        .describe("Chain ID where the pool is deployed (e.g., 'sonic')"),
      poolId: z.string()
        .describe("The pool contract address or ID"),
      interval: z.enum(["1m", "5m", "15m", "1h", "4h", "1d"])
        .describe("REQUIRED: Candle interval"),
      from: z.number()
        .describe("REQUIRED: Start timestamp (unix seconds)"),
      to: z.number()
        .describe("REQUIRED: End timestamp (unix seconds)"),
      format: z.nativeEnum(ResponseFormat).optional().default(ResponseFormat.MARKDOWN)
        .describe("Response format: 'json' for raw data or 'markdown' for formatted text")
    },
    READ_ONLY,
    async ({ chainId, poolId, interval, from, to, format }) => {
      try {
        const candles = await getAmmPoolCandles(chainId, poolId, { interval, from, to });
        return {
          content: [{
            type: "text",
            text: `## OHLCV Candles — ${poolId.slice(0, 10)}... on ${chainId}\n\n` + formatResponse(candles, format)
          }]
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : "Unknown error"}` }],
          isError: true
        };
      }
    }
  );

  // Tool 19: Get Intent by Hash
  server.tool(
    "sodax_get_intent",
    "Look up a specific intent by its intent hash (different from transaction hash)",
    {
      intentHash: z.string()
        .describe("The intent hash to look up (66 character hex string starting with 0x)"),
      format: z.nativeEnum(ResponseFormat).optional().default(ResponseFormat.MARKDOWN)
        .describe("Response format: 'json' for raw data or 'markdown' for formatted text")
    },
    READ_ONLY,
    async ({ intentHash, format }) => {
      try {
        const intent = await getIntent(intentHash);
        if (!intent) {
          return {
            content: [{ type: "text", text: `Intent not found: ${intentHash}` }]
          };
        }
        return {
          content: [{
            type: "text",
            text: `## Intent Details\n\n` + formatResponse(intent, format)
          }]
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : "Unknown error"}` }],
          isError: true
        };
      }
    }
  );

  // Tool 20: Get Solver Intent Details
  server.tool(
    "sodax_get_solver_intent",
    "Get solver-side details for an intent including fill history. Use includeAll to see all solver documents.",
    {
      intentHash: z.string()
        .describe("The intent hash to look up"),
      includeAll: z.boolean().optional().default(false)
        .describe("Include all intent documents (history) instead of just the latest"),
      format: z.nativeEnum(ResponseFormat).optional().default(ResponseFormat.MARKDOWN)
        .describe("Response format: 'json' for raw data or 'markdown' for formatted text")
    },
    READ_ONLY,
    async ({ intentHash, includeAll, format }) => {
      try {
        const intent = await getSolverIntent(intentHash, includeAll);
        if (!intent) {
          return {
            content: [{ type: "text", text: `Solver intent not found: ${intentHash}` }]
          };
        }
        return {
          content: [{
            type: "text",
            text: `## Solver Intent Details\n\n` + formatResponse(intent, format)
          }]
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : "Unknown error"}` }],
          isError: true
        };
      }
    }
  );

  // Tool 21: Get Single Money Market Asset
  server.tool(
    "sodax_get_money_market_asset",
    "Get detailed information for a specific money market asset by its reserve address",
    {
      reserveAddress: z.string()
        .describe("The reserve contract address of the asset"),
      format: z.nativeEnum(ResponseFormat).optional().default(ResponseFormat.MARKDOWN)
        .describe("Response format: 'json' for raw data or 'markdown' for formatted text")
    },
    READ_ONLY,
    async ({ reserveAddress, format }) => {
      try {
        const asset = await getMoneyMarketAsset(reserveAddress);
        if (!asset) {
          return {
            content: [{ type: "text", text: `Money market asset not found: ${reserveAddress}` }]
          };
        }
        return {
          content: [{
            type: "text",
            text: `## Money Market Asset\n\n` + formatResponse(asset, format)
          }]
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : "Unknown error"}` }],
          isError: true
        };
      }
    }
  );

  // Tool 22: Get Money Market Asset Borrowers
  server.tool(
    "sodax_get_asset_borrowers",
    "Get borrowers for a specific money market asset by its reserve address",
    {
      reserveAddress: z.string()
        .describe("The reserve contract address of the asset"),
      offset: z.number().min(0).optional().default(0)
        .describe("Number of borrowers to skip for pagination"),
      limit: z.number().min(1).max(100).optional().default(20)
        .describe("Maximum number of borrowers to return (1-100)"),
      format: z.nativeEnum(ResponseFormat).optional().default(ResponseFormat.MARKDOWN)
        .describe("Response format: 'json' for raw data or 'markdown' for formatted text")
    },
    READ_ONLY,
    async ({ reserveAddress, offset, limit, format }) => {
      try {
        const borrowers = await getMoneyMarketAssetBorrowers(reserveAddress, { offset, limit });
        return {
          content: [{
            type: "text",
            text: `## Borrowers for ${reserveAddress.slice(0, 10)}...\n\n` + formatResponse(borrowers, format)
          }]
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : "Unknown error"}` }],
          isError: true
        };
      }
    }
  );

  // Tool 23: Get Money Market Asset Suppliers
  server.tool(
    "sodax_get_asset_suppliers",
    "Get suppliers (lenders) for a specific money market asset by its reserve address",
    {
      reserveAddress: z.string()
        .describe("The reserve contract address of the asset"),
      offset: z.number().min(0).optional().default(0)
        .describe("Number of suppliers to skip for pagination"),
      limit: z.number().min(1).max(100).optional().default(20)
        .describe("Maximum number of suppliers to return (1-100)"),
      format: z.nativeEnum(ResponseFormat).optional().default(ResponseFormat.MARKDOWN)
        .describe("Response format: 'json' for raw data or 'markdown' for formatted text")
    },
    READ_ONLY,
    async ({ reserveAddress, offset, limit, format }) => {
      try {
        const suppliers = await getMoneyMarketAssetSuppliers(reserveAddress, { offset, limit });
        return {
          content: [{
            type: "text",
            text: `## Suppliers for ${reserveAddress.slice(0, 10)}...\n\n` + formatResponse(suppliers, format)
          }]
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : "Unknown error"}` }],
          isError: true
        };
      }
    }
  );

  // Tool 24: Get All Money Market Borrowers
  server.tool(
    "sodax_get_all_borrowers",
    "Get all borrowers across all money market assets with pagination",
    {
      offset: z.number().min(0).optional().default(0)
        .describe("Number of borrowers to skip for pagination"),
      limit: z.number().min(1).max(100).optional().default(20)
        .describe("Maximum number of borrowers to return (1-100)"),
      format: z.nativeEnum(ResponseFormat).optional().default(ResponseFormat.MARKDOWN)
        .describe("Response format: 'json' for raw data or 'markdown' for formatted text")
    },
    READ_ONLY,
    async ({ offset, limit, format }) => {
      try {
        const borrowers = await getMoneyMarketBorrowers({ offset, limit });
        return {
          content: [{
            type: "text",
            text: `## All Money Market Borrowers\n\n` + formatResponse(borrowers, format)
          }]
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : "Unknown error"}` }],
          isError: true
        };
      }
    }
  );

  // Tool 25: Get Partner Summary
  server.tool(
    "sodax_get_partner_summary",
    "Get volume and activity summary for a specific integration partner by their receiver address",
    {
      receiver: z.string()
        .describe("The partner receiver address"),
      chainId: z.string().optional()
        .describe("Filter by chain ID"),
      format: z.nativeEnum(ResponseFormat).optional().default(ResponseFormat.MARKDOWN)
        .describe("Response format: 'json' for raw data or 'markdown' for formatted text")
    },
    READ_ONLY,
    async ({ receiver, chainId, format }) => {
      try {
        const summary = await getPartnerSummary(receiver, chainId);
        if (!summary) {
          return {
            content: [{ type: "text", text: `Partner not found: ${receiver}` }]
          };
        }
        return {
          content: [{
            type: "text",
            text: `## Partner Summary\n\n` + formatResponse(summary, format)
          }]
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : "Unknown error"}` }],
          isError: true
        };
      }
    }
  );

  // Tool 26: Get Total Supply
  server.tool(
    "sodax_get_total_supply",
    "Get SODA token total supply as a plain number",
    {
      format: z.nativeEnum(ResponseFormat).optional().default(ResponseFormat.MARKDOWN)
        .describe("Response format: 'json' for raw data or 'markdown' for formatted text")
    },
    READ_ONLY,
    async ({ format }) => {
      try {
        const supply = await getTotalSupply();
        return {
          content: [{
            type: "text",
            text: `## SODA Total Supply\n\n` + formatResponse(supply, format)
          }]
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : "Unknown error"}` }],
          isError: true
        };
      }
    }
  );

  // Tool 27: Get Circulating Supply
  server.tool(
    "sodax_get_circulating_supply",
    "Get SODA token circulating supply as a plain number",
    {
      format: z.nativeEnum(ResponseFormat).optional().default(ResponseFormat.MARKDOWN)
        .describe("Response format: 'json' for raw data or 'markdown' for formatted text")
    },
    READ_ONLY,
    async ({ format }) => {
      try {
        const supply = await getCirculatingSupply();
        return {
          content: [{
            type: "text",
            text: `## SODA Circulating Supply\n\n` + formatResponse(supply, format)
          }]
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : "Unknown error"}` }],
          isError: true
        };
      }
    }
  );

  // Bonus Tool: Refresh Cache
  server.tool(
    "sodax_refresh_cache",
    "Clear the cached API data to force fresh fetches on next requests",
    {},
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    async () => {
      const statsBefore = getCacheStats();
      clearCache();
      return {
        content: [{
          type: "text",
          text: `Cache cleared. ${statsBefore.size} cached entries removed.`
        }]
      };
    }
  );
}
