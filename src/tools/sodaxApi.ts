/**
 * SODAX API Tools
 * 
 * MCP tool definitions for accessing live SODAX API data.
 * Provides 10 tools for developers and integration partners.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
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
export function registerSodaxApiTools(server: McpServer): void {
  
  // Tool 1: Get Supported Chains
  server.tool(
    "sodax_get_supported_chains",
    "List all blockchain networks supported by SODAX for cross-chain swaps and DeFi operations",
    {
      format: z.nativeEnum(ResponseFormat).optional().default(ResponseFormat.MARKDOWN)
        .describe("Response format: 'json' for raw data or 'markdown' for formatted text")
    },
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
    "Get transaction history for a specific wallet address",
    {
      userAddress: z.string()
        .describe("The wallet address to look up (e.g., '0x...' or 'hx...')"),
      chainId: z.string().optional()
        .describe("Filter by chain ID"),
      limit: z.number().min(1).max(100).optional().default(20)
        .describe("Maximum number of transactions to return (1-100)"),
      offset: z.number().min(0).optional().default(0)
        .describe("Number of transactions to skip for pagination"),
      format: z.nativeEnum(ResponseFormat).optional().default(ResponseFormat.MARKDOWN)
        .describe("Response format: 'json' for raw data or 'markdown' for formatted text")
    },
    async ({ userAddress, chainId, limit, offset, format }) => {
      try {
        const transactions = await getUserTransactions(userAddress, { chainId, limit, offset });
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

  // Tool 5: Get Volume
  server.tool(
    "sodax_get_volume",
    "Get trading volume data for SODAX, optionally filtered by chain and time period",
    {
      chainId: z.string().optional()
        .describe("Filter by chain ID for chain-specific volume"),
      period: z.enum(["24h", "7d", "30d", "all"]).optional().default("24h")
        .describe("Time period for volume data"),
      format: z.nativeEnum(ResponseFormat).optional().default(ResponseFormat.MARKDOWN)
        .describe("Response format: 'json' for raw data or 'markdown' for formatted text")
    },
    async ({ chainId, period, format }) => {
      try {
        const volume = await getVolume({ chainId, period });
        const header = chainId 
          ? `## Trading Volume on ${chainId} (${period})\n\n`
          : `## SODAX Trading Volume (${period})\n\n`;
        return {
          content: [{
            type: "text",
            text: header + formatResponse(volume, format)
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
    "Get current orderbook entries showing pending limit orders",
    {
      chainId: z.string().optional()
        .describe("Filter by chain ID"),
      tokenIn: z.string().optional()
        .describe("Filter by input token address"),
      tokenOut: z.string().optional()
        .describe("Filter by output token address"),
      limit: z.number().min(1).max(100).optional().default(20)
        .describe("Maximum number of orders to return"),
      format: z.nativeEnum(ResponseFormat).optional().default(ResponseFormat.MARKDOWN)
        .describe("Response format: 'json' for raw data or 'markdown' for formatted text")
    },
    async ({ chainId, tokenIn, tokenOut, limit, format }) => {
      try {
        const orderbook = await getOrderbook({ chainId, tokenIn, tokenOut, limit });
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
      chainId: z.string().optional()
        .describe("Filter by chain ID"),
      format: z.nativeEnum(ResponseFormat).optional().default(ResponseFormat.MARKDOWN)
        .describe("Response format: 'json' for raw data or 'markdown' for formatted text")
    },
    async ({ userAddress, chainId, format }) => {
      try {
        const position = await getUserPosition(userAddress, chainId);
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
      format: z.nativeEnum(ResponseFormat).optional().default(ResponseFormat.MARKDOWN)
        .describe("Response format: 'json' for raw data or 'markdown' for formatted text")
    },
    async ({ format }) => {
      try {
        const partners = await getPartners();
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

  // Bonus Tool: Refresh Cache
  server.tool(
    "sodax_refresh_cache",
    "Clear the cached API data to force fresh fetches on next requests",
    {},
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
