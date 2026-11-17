/**
 * SODAX API Tools
 *
 * MCP tool definitions for accessing live SODAX API data.
 * Provides SODAX API tools for developers and integration partners.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { chainDisplayName } from "../constants.js";
import {
  clearCache,
  getAllChainsConfigs,
  getAllConfig,
  getAmmNftPositions,
  getAmmPoolCandles,
  getCacheStats,
  getCirculatingSupply,
  getHubAssets,
  getIntent,
  getMoneyMarketAsset,
  getMoneyMarketAssetBorrowers,
  getMoneyMarketAssetSuppliers,
  getMoneyMarketAssets,
  getMoneyMarketBorrowers,
  getMoneyMarketReserveAssets,
  getMoneyMarketTokens,
  getOrderbook,
  getPartnerSummary,
  getPartners,
  getRelayChainIdMap,
  getSolverIntent,
  getSupportedChainsDetailed,
  getSwapTokens,
  getTokenSupply,
  getTotalSupply,
  getTransaction,
  getUserPosition,
  getUserTransactions,
  getVolume,
  getVolumeStats,
  resolveChainSupport,
  toChainKey,
} from "../services/sodaxApi.js";
import { clearSolverCache, getSolverCacheStats } from "../services/solver.js";
import { expireSwapCatalog } from "../services/swap/tokens.js";
import { failedResult } from "../services/toolFailure.js";
import { registerAppTool } from "../services/toolRegistry.js";
import { ResponseFormat } from "../types.js";
import { formatNotFound, formatResponse } from "./formatters.js";

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
  registerAppTool(
    server,
    "config",
    "sodax_get_supported_chains",
    "List all blockchain networks supported by SODAX for cross-chain swaps and DeFi operations",
    {
      format: z
        .nativeEnum(ResponseFormat)
        .optional()
        .default(ResponseFormat.MARKDOWN)
        .describe("Response format: 'json' for raw data or 'markdown' for formatted text"),
    },
    READ_ONLY,
    async ({ format }) => {
      try {
        const chains = await getSupportedChainsDetailed();
        // JSON: the {key, name} objects. Markdown: a readable "Name — `key`"
        // list, since the raw keys (0x2105.base, injective-1) read awkwardly.
        // The key is what other tools take as `chainId`, so it's always shown.
        const text =
          format === ResponseFormat.JSON
            ? formatResponse(chains, format)
            : `## Supported Chains (${chains.length})\n\n${chains.map(c => `- **${c.name}** — \`${c.key}\``).join("\n")}`;
        return {
          content: [{ type: "text", text }],
        };
      } catch (error) {
        return failedResult(error);
      }
    },
  );

  // Tool: Check chain support (name/ticker → supported?)
  registerAppTool(
    server,
    "config",
    "sodax_check_chain_support",
    "Check whether SODAX supports a specific blockchain, given its name, ticker, chain key or EVM chain id (e.g. 'Hedera', 'HBAR', 'hedera', 'Base', 'Arbitrum', '8453'). Use this to answer 'does SODAX support X?' questions authoritatively instead of guessing — it resolves the name to a chain key and confirms against the live network registry.",
    {
      chain: z
        .string()
        .min(1)
        .describe(
          "Chain name, ticker, key or EVM chain id — e.g. 'Hedera', 'HBAR', 'hedera', 'Robinhood', '0x2105.base', '8453'",
        ),
    },
    READ_ONLY,
    async ({ chain }) => {
      try {
        const result = await resolveChainSupport(chain);
        if (result.supported && result.chainKey) {
          return {
            content: [
              {
                type: "text",
                text: `✅ Yes — SODAX supports **${result.displayName}** (chain key: \`${result.chainKey}\`). Use this key with tools like sodax_get_swap_tokens. SODAX currently supports ${result.supportedChains.length} chains.`,
              },
            ],
          };
        }
        if (result.windingDownKey) {
          return {
            content: [
              {
                type: "text",
                text: `⚠️ **${chainDisplayName(result.windingDownKey)}** (\`${result.windingDownKey}\`) is being wound down on SODAX and is no longer counted as a supported network. Do not build new integrations against it.\n\nSupported chain keys (${result.supportedChains.length}): ${result.supportedChains.join(", ")}`,
              },
            ],
          };
        }
        return {
          content: [
            {
              type: "text",
              text: `❌ No chain matching "${chain}" was found in the live SODAX registry. Check the supported list below before concluding it is unsupported — the chain may be listed under a different name or key.\n\nSupported chain keys (${result.supportedChains.length}): ${result.supportedChains.join(", ")}\n\nIf you expected a match, try the exact chain key or call sodax_get_supported_chains.`,
            },
          ],
        };
      } catch (error) {
        return failedResult(error);
      }
    },
  );

  // Tool 2: Get Swap Tokens
  registerAppTool(
    server,
    "config",
    "sodax_get_swap_tokens",
    "Get available tokens for swapping on SODAX, optionally filtered by chain",
    {
      chainId: z
        .string()
        .optional()
        .describe(
          "Filter tokens by spoke chain key, name or EVM chain id (e.g. 'sonic', '0x2105.base', 'Base', '8453'). Call sodax_get_supported_chains for the full, live list.",
        ),
      format: z
        .nativeEnum(ResponseFormat)
        .optional()
        .default(ResponseFormat.MARKDOWN)
        .describe("Response format: 'json' for raw data or 'markdown' for formatted text"),
    },
    READ_ONLY,
    async ({ chainId, format }) => {
      try {
        const key = chainId && (await toChainKey(chainId));
        const tokens = await getSwapTokens(key);
        const summary = key
          ? `## Swap Tokens on ${key}\n\n${tokens.length} tokens available\n\n`
          : `## All Swap Tokens\n\n${tokens.length} tokens available across all chains\n\n`;
        return {
          content: [
            {
              type: "text",
              text: formatResponse(tokens, format, summary),
            },
          ],
        };
      } catch (error) {
        return failedResult(error);
      }
    },
  );

  // Tool 3: Get Transaction
  registerAppTool(
    server,
    "intents",
    "sodax_get_transaction",
    "Look up a specific transaction by its hash to see status, amounts, and details",
    {
      txHash: z.string().describe("The transaction hash to look up (e.g., '0x...')"),
      format: z
        .nativeEnum(ResponseFormat)
        .optional()
        .default(ResponseFormat.MARKDOWN)
        .describe("Response format: 'json' for raw data or 'markdown' for formatted text"),
    },
    READ_ONLY,
    async ({ txHash, format }) => {
      try {
        const transaction = await getTransaction(txHash);
        if (!transaction) {
          return {
            content: [{ type: "text", text: formatNotFound(format, `Transaction not found: ${txHash}`) }],
          };
        }
        return {
          content: [
            {
              type: "text",
              text: formatResponse(transaction, format, "## Transaction Details\n\n"),
            },
          ],
        };
      } catch (error) {
        return failedResult(error);
      }
    },
  );

  // Tool 4: Get User Transactions
  registerAppTool(
    server,
    "intents",
    "sodax_get_user_transactions",
    "Get intent/transaction history for a specific wallet address",
    {
      userAddress: z.string().describe("The wallet address to look up (e.g., '0x...')"),
      limit: z
        .number()
        .min(1)
        .max(100)
        .optional()
        .default(20)
        .describe("Maximum number of transactions to return (1-100)"),
      offset: z.number().min(0).optional().default(0).describe("Number of transactions to skip for pagination"),
      fromBlock: z.number().optional().describe("Inclusive lower bound on blockNumber (chain-native ordering)"),
      toBlock: z.number().optional().describe("Inclusive upper bound on blockNumber (chain-native ordering)"),
      format: z
        .nativeEnum(ResponseFormat)
        .optional()
        .default(ResponseFormat.MARKDOWN)
        .describe("Response format: 'json' for raw data or 'markdown' for formatted text"),
    },
    READ_ONLY,
    async ({ userAddress, limit, offset, fromBlock, toBlock, format }) => {
      try {
        const transactions = await getUserTransactions(userAddress, { limit, offset, fromBlock, toBlock });
        const header = `## Transactions for ${userAddress.slice(0, 10)}...${userAddress.slice(-8)}\n\n`;
        const summary = `${transactions.length} transactions found\n\n`;
        return {
          content: [
            {
              type: "text",
              text: formatResponse(transactions, format, header + summary),
            },
          ],
        };
      } catch (error) {
        return failedResult(error);
      }
    },
  );

  // Tool 5: Get Volume (Filled Intents)
  registerAppTool(
    server,
    "intents",
    "sodax_get_volume",
    "Get solver volume data showing filled intents with filtering and pagination. Requires inputToken and outputToken. Optional filters: chain, solver, block range OR time range (don't mix both).",
    {
      inputToken: z.string().describe("REQUIRED: Input token address"),
      outputToken: z.string().describe("REQUIRED: Output token address"),
      chainId: z.number().optional().describe("Filter by chain ID (e.g., 146 for Sonic)"),
      solver: z.string().optional().describe("Filter by solver address (0x0...0 for default solver)"),
      fromBlock: z.number().optional().describe("Start block number (don't mix with since/until)"),
      toBlock: z.number().optional().describe("End block number (don't mix with since/until)"),
      since: z.string().optional().describe("Start time ISO format (don't mix with fromBlock/toBlock or fromTs/toTs)"),
      until: z.string().optional().describe("End time ISO format (don't mix with fromBlock/toBlock or fromTs/toTs)"),
      fromTs: z
        .number()
        .optional()
        .describe("Start timestamp (unix seconds). Don't mix with since/until or fromBlock/toBlock."),
      toTs: z
        .number()
        .optional()
        .describe("End timestamp (unix seconds). Don't mix with since/until or fromBlock/toBlock."),
      sort: z.enum(["asc", "desc"]).optional().default("desc").describe("Sort order by block number"),
      limit: z
        .number()
        .min(1)
        .max(100)
        .optional()
        .default(50)
        .describe("Maximum number of filled intents to return (1-100)"),
      includeData: z.boolean().optional().default(false).describe("Include raw intent data in response"),
      cursor: z.string().optional().describe("Pagination cursor from previous response's nextCursor"),
      format: z
        .nativeEnum(ResponseFormat)
        .optional()
        .default(ResponseFormat.MARKDOWN)
        .describe("Response format: 'json' for raw data or 'markdown' for formatted text"),
    },
    READ_ONLY,
    async ({
      inputToken,
      outputToken,
      chainId,
      solver,
      fromBlock,
      toBlock,
      since,
      until,
      fromTs,
      toTs,
      sort,
      limit,
      includeData,
      cursor,
      format,
    }) => {
      try {
        const volume = await getVolume({
          chainId,
          inputToken,
          outputToken,
          solver,
          fromBlock,
          toBlock,
          since,
          until,
          fromTs,
          toTs,
          sort,
          limit,
          includeData,
          cursor,
        });
        const header = "## SODAX Filled Intents\n\n";
        // The whole cursor: the next call needs it as is.
        const pagination = !volume.hasMore
          ? "\n\n*No more results.*"
          : volume.nextCursor
            ? `\n\n*Has more results. Use cursor: \`${volume.nextCursor}\`*`
            : "\n\n*Has more results, but the API gave no cursor to fetch them.*";
        return {
          content: [
            {
              type: "text",
              text: formatResponse(format === ResponseFormat.JSON ? volume : volume.items, format, header, pagination),
            },
          ],
        };
      } catch (error) {
        return failedResult(error);
      }
    },
  );

  // Tool 5b: Get Volume Stats (aggregate filled-intent count)
  registerAppTool(
    server,
    "intents",
    "sodax_get_volume_stats",
    "Get aggregate solver volume stats: the approximate total number of filled-intent records (fill documents, not distinct intents). Cached ~60s upstream.",
    {
      format: z
        .nativeEnum(ResponseFormat)
        .optional()
        .default(ResponseFormat.MARKDOWN)
        .describe("Response format: 'json' for raw data or 'markdown' for formatted text"),
    },
    READ_ONLY,
    async ({ format }) => {
      try {
        const stats = await getVolumeStats();
        return {
          content: [
            {
              type: "text",
              text: formatResponse(stats, format, "## SODAX Solver Volume Stats\n\n"),
            },
          ],
        };
      } catch (error) {
        return failedResult(error);
      }
    },
  );

  // Tool 6: Get Orderbook
  registerAppTool(
    server,
    "intents",
    "sodax_get_orderbook",
    "Get current orderbook entries showing pending/open intents",
    {
      limit: z.number().min(1).max(500).optional().describe("Max results (default server-side, cap 500)"),
      offset: z.number().min(0).optional().describe("Offset for simple pagination"),
      srcChain: z.number().optional().describe("Filter by source chain id"),
      dstChain: z.number().optional().describe("Filter by destination chain id"),
      inputToken: z.string().optional().describe("Filter by input token address"),
      outputToken: z.string().optional().describe("Filter by output token address"),
      creator: z.string().optional().describe("Filter by creator address"),
      deadlineBefore: z.number().optional().describe("Only return intents with deadline < value (Unix seconds)"),
      deadlineAfter: z.number().optional().describe("Only return intents with deadline > value (Unix seconds)"),
      excludeZeroDeadline: z.boolean().optional().describe("Exclude intents where deadline = 0"),
      format: z
        .nativeEnum(ResponseFormat)
        .optional()
        .default(ResponseFormat.MARKDOWN)
        .describe("Response format: 'json' for raw data or 'markdown' for formatted text"),
    },
    READ_ONLY,
    async ({ format, ...filters }) => {
      try {
        const orderbook = await getOrderbook(filters);
        return {
          content: [
            {
              type: "text",
              text: formatResponse(orderbook, format, `## Orderbook\n\n${orderbook.length} orders found\n\n`),
            },
          ],
        };
      } catch (error) {
        return failedResult(error);
      }
    },
  );

  // Tool 7: Get Money Market Assets
  registerAppTool(
    server,
    "moneyMarket",
    "sodax_get_money_market_assets",
    "List all assets available for lending and borrowing in the SODAX money market",
    {
      format: z
        .nativeEnum(ResponseFormat)
        .optional()
        .default(ResponseFormat.MARKDOWN)
        .describe("Response format: 'json' for raw data or 'markdown' for formatted text"),
    },
    READ_ONLY,
    async ({ format }) => {
      try {
        const assets = await getMoneyMarketAssets();
        return {
          content: [
            {
              type: "text",
              text: formatResponse(assets, format, `## Money Market Assets\n\n${assets.length} assets available\n\n`),
            },
          ],
        };
      } catch (error) {
        return failedResult(error);
      }
    },
  );

  // Tool 8: Get User Position
  registerAppTool(
    server,
    "moneyMarket",
    "sodax_get_user_position",
    "Get a user's lending and borrowing position in the money market",
    {
      userAddress: z.string().describe("The wallet address to look up"),
      format: z
        .nativeEnum(ResponseFormat)
        .optional()
        .default(ResponseFormat.MARKDOWN)
        .describe("Response format: 'json' for raw data or 'markdown' for formatted text"),
    },
    READ_ONLY,
    async ({ userAddress, format }) => {
      try {
        const position = await getUserPosition(userAddress);
        if (!position) {
          return {
            content: [
              { type: "text", text: formatNotFound(format, `No money market position found for ${userAddress}`) },
            ],
          };
        }
        return {
          content: [
            {
              type: "text",
              text: formatResponse(position, format, `## Money Market Position\n\n**Address:** ${userAddress}\n\n`),
            },
          ],
        };
      } catch (error) {
        return failedResult(error);
      }
    },
  );

  // Tool 9: Get Partners
  registerAppTool(
    server,
    "partnersAndToken",
    "sodax_get_partners",
    "List all SODAX integration partners including wallets, DEXs, and other protocols",
    {
      chainId: z.number().int().optional().describe("Filter partners by numeric chain ID (e.g. 146 for Sonic)"),
      format: z
        .nativeEnum(ResponseFormat)
        .optional()
        .default(ResponseFormat.MARKDOWN)
        .describe("Response format: 'json' for raw data or 'markdown' for formatted text"),
    },
    READ_ONLY,
    async ({ chainId, format }) => {
      try {
        const partners = await getPartners(chainId);
        return {
          content: [
            {
              type: "text",
              text: formatResponse(
                partners,
                format,
                `## SODAX Partners\n\n${partners.length} integration partners\n\n`,
              ),
            },
          ],
        };
      } catch (error) {
        return failedResult(error);
      }
    },
  );

  // Tool 10: Get Token Supply
  registerAppTool(
    server,
    "partnersAndToken",
    "sodax_get_token_supply",
    "Get SODA token supply information including total, circulating, and burned amounts",
    {
      format: z
        .nativeEnum(ResponseFormat)
        .optional()
        .default(ResponseFormat.MARKDOWN)
        .describe("Response format: 'json' for raw data or 'markdown' for formatted text"),
    },
    READ_ONLY,
    async ({ format }) => {
      try {
        const supply = await getTokenSupply();
        return {
          content: [
            {
              type: "text",
              text: formatResponse(supply, format, "## SODA Token Supply\n\n"),
            },
          ],
        };
      } catch (error) {
        return failedResult(error);
      }
    },
  );

  // Tool 11: Get All Config
  registerAppTool(
    server,
    "config",
    "sodax_get_all_config",
    "Get full SODAX configuration including all supported chains, swap tokens, and protocol settings in one call",
    {
      format: z
        .nativeEnum(ResponseFormat)
        .optional()
        .default(ResponseFormat.MARKDOWN)
        .describe("Response format: 'json' for raw data or 'markdown' for formatted text"),
    },
    READ_ONLY,
    async ({ format }) => {
      try {
        const config = await getAllConfig();
        return {
          content: [
            {
              type: "text",
              text: formatResponse(config, format, "## SODAX Full Configuration\n\n"),
            },
          ],
        };
      } catch (error) {
        return failedResult(error);
      }
    },
  );

  // Tool 12: Get Relay Chain ID Map
  registerAppTool(
    server,
    "config",
    "sodax_get_relay_chain_id_map",
    "Get mapping between chain IDs and intent relay chain IDs used by the SODAX relay network",
    {
      format: z
        .nativeEnum(ResponseFormat)
        .optional()
        .default(ResponseFormat.MARKDOWN)
        .describe("Response format: 'json' for raw data or 'markdown' for formatted text"),
    },
    READ_ONLY,
    async ({ format }) => {
      try {
        const map = await getRelayChainIdMap();
        return {
          content: [
            {
              type: "text",
              text: formatResponse(map, format, "## Relay Chain ID Map\n\n"),
            },
          ],
        };
      } catch (error) {
        return failedResult(error);
      }
    },
  );

  // Tool 13: Get All Spoke Chain Configs
  registerAppTool(
    server,
    "config",
    "sodax_get_all_chains_configs",
    "Get detailed configuration for all spoke chains including contract addresses, RPCs, and token configs",
    {
      format: z
        .nativeEnum(ResponseFormat)
        .optional()
        .default(ResponseFormat.MARKDOWN)
        .describe("Response format: 'json' for raw data or 'markdown' for formatted text"),
    },
    READ_ONLY,
    async ({ format }) => {
      try {
        const configs = await getAllChainsConfigs();
        return {
          content: [
            {
              type: "text",
              text: formatResponse(configs, format, "## Spoke Chain Configs\n\n"),
            },
          ],
        };
      } catch (error) {
        return failedResult(error);
      }
    },
  );

  // Tool 14: Get Hub Assets
  registerAppTool(
    server,
    "config",
    "sodax_get_hub_assets",
    "Get assets representing spoke tokens on the hub (Sonic) chain, optionally filtered by source chain",
    {
      chainId: z
        .string()
        .optional()
        .describe(
          "Filter by source spoke chain key, name or EVM chain id (e.g. 'sonic', 'ethereum', 'Base', '8453'). Call sodax_get_supported_chains for the full, live list.",
        ),
      format: z
        .nativeEnum(ResponseFormat)
        .optional()
        .default(ResponseFormat.MARKDOWN)
        .describe("Response format: 'json' for raw data or 'markdown' for formatted text"),
    },
    READ_ONLY,
    async ({ chainId, format }) => {
      try {
        const key = chainId && (await toChainKey(chainId));
        const assets = await getHubAssets(key);
        const header = key ? `## Hub Assets from ${key}\n\n` : "## All Hub Assets\n\n";
        return {
          content: [
            {
              type: "text",
              text: formatResponse(assets, format, header),
            },
          ],
        };
      } catch (error) {
        return failedResult(error);
      }
    },
  );

  // Tool 15: Get Money Market Tokens
  registerAppTool(
    server,
    "config",
    "sodax_get_money_market_tokens",
    "Get tokens supported for money market lending/borrowing, optionally filtered by chain",
    {
      chainId: z
        .string()
        .optional()
        .describe("Filter by chain key, name or EVM chain id (e.g. 'sonic', 'Base', '8453')"),
      format: z
        .nativeEnum(ResponseFormat)
        .optional()
        .default(ResponseFormat.MARKDOWN)
        .describe("Response format: 'json' for raw data or 'markdown' for formatted text"),
    },
    READ_ONLY,
    async ({ chainId, format }) => {
      try {
        const key = chainId && (await toChainKey(chainId));
        const tokens = await getMoneyMarketTokens(key);
        const header = key ? `## Money Market Tokens on ${key}\n\n` : "## Money Market Tokens\n\n";
        return {
          content: [
            {
              type: "text",
              text: formatResponse(tokens, format, header),
            },
          ],
        };
      } catch (error) {
        return failedResult(error);
      }
    },
  );

  // Tool 16: Get Money Market Reserve Assets
  registerAppTool(
    server,
    "config",
    "sodax_get_money_market_reserve_assets",
    "Get money market reserve assets used as collateral backing",
    {
      format: z
        .nativeEnum(ResponseFormat)
        .optional()
        .default(ResponseFormat.MARKDOWN)
        .describe("Response format: 'json' for raw data or 'markdown' for formatted text"),
    },
    READ_ONLY,
    async ({ format }) => {
      try {
        const assets = await getMoneyMarketReserveAssets();
        return {
          content: [
            {
              type: "text",
              text: formatResponse(assets, format, "## Money Market Reserve Assets\n\n"),
            },
          ],
        };
      } catch (error) {
        return failedResult(error);
      }
    },
  );

  // Tool 17: Get AMM NFT Positions
  registerAppTool(
    server,
    "amm",
    "sodax_get_amm_positions",
    "Get AMM liquidity provider NFT positions, optionally filtered by owner address",
    {
      owner: z.string().optional().describe("Filter by owner wallet address"),
      offset: z.number().min(0).optional().describe("Number of positions to skip for pagination"),
      limit: z.number().min(1).max(100).optional().describe("Maximum number of positions to return"),
      format: z
        .nativeEnum(ResponseFormat)
        .optional()
        .default(ResponseFormat.MARKDOWN)
        .describe("Response format: 'json' for raw data or 'markdown' for formatted text"),
    },
    READ_ONLY,
    async ({ owner, offset, limit, format }) => {
      try {
        const positions = await getAmmNftPositions({ owner, offset, limit });
        const header = owner
          ? `## AMM Positions for ${owner.slice(0, 10)}...${owner.slice(-8)}\n\n`
          : "## AMM Positions\n\n";
        return {
          content: [
            {
              type: "text",
              text: formatResponse(positions, format, header),
            },
          ],
        };
      } catch (error) {
        return failedResult(error);
      }
    },
  );

  // Tool 18: Get AMM Pool Candles
  registerAppTool(
    server,
    "amm",
    "sodax_get_amm_pool_candles",
    "Get OHLCV candlestick chart data for an AMM pool",
    {
      // The API parses it as an integer: a chain key or name is a 400 there.
      chainId: z
        .string()
        .regex(/^\d+$/, "chainId is the pool chain's numeric id, such as '146' for Sonic")
        .describe("Numeric chain id where the pool is deployed (e.g. '146' for Sonic)"),
      poolId: z.string().describe("The pool contract address or ID"),
      interval: z.enum(["1m", "5m", "15m", "1h", "4h", "1d"]).describe("REQUIRED: Candle interval"),
      from: z.number().describe("REQUIRED: Start timestamp (unix seconds)"),
      to: z.number().describe("REQUIRED: End timestamp (unix seconds)"),
      format: z
        .nativeEnum(ResponseFormat)
        .optional()
        .default(ResponseFormat.MARKDOWN)
        .describe("Response format: 'json' for raw data or 'markdown' for formatted text"),
    },
    READ_ONLY,
    async ({ chainId, poolId, interval, from, to, format }) => {
      try {
        const candles = await getAmmPoolCandles(chainId, poolId, { interval, from, to });
        return {
          content: [
            {
              type: "text",
              text: formatResponse(candles, format, `## OHLCV Candles — ${poolId.slice(0, 10)}... on ${chainId}\n\n`),
            },
          ],
        };
      } catch (error) {
        return failedResult(error);
      }
    },
  );

  // Tool 19: Get Intent by Hash
  registerAppTool(
    server,
    "intents",
    "sodax_get_intent",
    "Look up a specific intent by its intent hash (different from transaction hash)",
    {
      intentHash: z.string().describe("The intent hash to look up (66 character hex string starting with 0x)"),
      format: z
        .nativeEnum(ResponseFormat)
        .optional()
        .default(ResponseFormat.MARKDOWN)
        .describe("Response format: 'json' for raw data or 'markdown' for formatted text"),
    },
    READ_ONLY,
    async ({ intentHash, format }) => {
      try {
        const intent = await getIntent(intentHash);
        if (!intent) {
          return {
            content: [{ type: "text", text: formatNotFound(format, `Intent not found: ${intentHash}`) }],
          };
        }
        return {
          content: [
            {
              type: "text",
              text: formatResponse(intent, format, "## Intent Details\n\n"),
            },
          ],
        };
      } catch (error) {
        return failedResult(error);
      }
    },
  );

  // Tool 20: Get Solver Intent Details
  registerAppTool(
    server,
    "intents",
    "sodax_get_solver_intent",
    "Get solver-side details for an intent including fill history. Use includeAll to see all solver documents.",
    {
      intentHash: z.string().describe("The intent hash to look up"),
      includeAll: z
        .boolean()
        .optional()
        .default(false)
        .describe("Include all intent documents (history) instead of just the latest"),
      format: z
        .nativeEnum(ResponseFormat)
        .optional()
        .default(ResponseFormat.MARKDOWN)
        .describe("Response format: 'json' for raw data or 'markdown' for formatted text"),
    },
    READ_ONLY,
    async ({ intentHash, includeAll, format }) => {
      try {
        const intent = await getSolverIntent(intentHash, includeAll);
        if (!intent) {
          return {
            content: [{ type: "text", text: formatNotFound(format, `Solver intent not found: ${intentHash}`) }],
          };
        }
        return {
          content: [
            {
              type: "text",
              text: formatResponse(intent, format, "## Solver Intent Details\n\n"),
            },
          ],
        };
      } catch (error) {
        return failedResult(error);
      }
    },
  );

  // Tool 21: Get Single Money Market Asset
  registerAppTool(
    server,
    "moneyMarket",
    "sodax_get_money_market_asset",
    "Get detailed information for a specific money market asset by its reserve address",
    {
      reserveAddress: z.string().describe("The reserve contract address of the asset"),
      format: z
        .nativeEnum(ResponseFormat)
        .optional()
        .default(ResponseFormat.MARKDOWN)
        .describe("Response format: 'json' for raw data or 'markdown' for formatted text"),
    },
    READ_ONLY,
    async ({ reserveAddress, format }) => {
      try {
        const asset = await getMoneyMarketAsset(reserveAddress);
        if (!asset) {
          return {
            content: [
              { type: "text", text: formatNotFound(format, `Money market asset not found: ${reserveAddress}`) },
            ],
          };
        }
        return {
          content: [
            {
              type: "text",
              text: formatResponse(asset, format, "## Money Market Asset\n\n"),
            },
          ],
        };
      } catch (error) {
        return failedResult(error);
      }
    },
  );

  // Tool 22: Get Money Market Asset Borrowers
  registerAppTool(
    server,
    "moneyMarket",
    "sodax_get_asset_borrowers",
    "Get borrowers for a specific money market asset by its reserve address",
    {
      reserveAddress: z.string().describe("The reserve contract address of the asset"),
      offset: z.number().min(0).optional().default(0).describe("Number of borrowers to skip for pagination"),
      limit: z
        .number()
        .min(1)
        .max(100)
        .optional()
        .default(20)
        .describe("Maximum number of borrowers to return (1-100)"),
      format: z
        .nativeEnum(ResponseFormat)
        .optional()
        .default(ResponseFormat.MARKDOWN)
        .describe("Response format: 'json' for raw data or 'markdown' for formatted text"),
    },
    READ_ONLY,
    async ({ reserveAddress, offset, limit, format }) => {
      try {
        const borrowers = await getMoneyMarketAssetBorrowers(reserveAddress, { offset, limit });
        return {
          content: [
            {
              type: "text",
              text: formatResponse(borrowers, format, `## Borrowers for ${reserveAddress.slice(0, 10)}...\n\n`),
            },
          ],
        };
      } catch (error) {
        return failedResult(error);
      }
    },
  );

  // Tool 23: Get Money Market Asset Suppliers
  registerAppTool(
    server,
    "moneyMarket",
    "sodax_get_asset_suppliers",
    "Get suppliers (lenders) for a specific money market asset by its reserve address",
    {
      reserveAddress: z.string().describe("The reserve contract address of the asset"),
      offset: z.number().min(0).optional().default(0).describe("Number of suppliers to skip for pagination"),
      limit: z
        .number()
        .min(1)
        .max(100)
        .optional()
        .default(20)
        .describe("Maximum number of suppliers to return (1-100)"),
      format: z
        .nativeEnum(ResponseFormat)
        .optional()
        .default(ResponseFormat.MARKDOWN)
        .describe("Response format: 'json' for raw data or 'markdown' for formatted text"),
    },
    READ_ONLY,
    async ({ reserveAddress, offset, limit, format }) => {
      try {
        const suppliers = await getMoneyMarketAssetSuppliers(reserveAddress, { offset, limit });
        return {
          content: [
            {
              type: "text",
              text: formatResponse(suppliers, format, `## Suppliers for ${reserveAddress.slice(0, 10)}...\n\n`),
            },
          ],
        };
      } catch (error) {
        return failedResult(error);
      }
    },
  );

  // Tool 24: Get All Money Market Borrowers
  registerAppTool(
    server,
    "moneyMarket",
    "sodax_get_all_borrowers",
    "Get all borrowers across all money market assets with pagination",
    {
      offset: z.number().min(0).optional().default(0).describe("Number of borrowers to skip for pagination"),
      limit: z
        .number()
        .min(1)
        .max(100)
        .optional()
        .default(20)
        .describe("Maximum number of borrowers to return (1-100)"),
      format: z
        .nativeEnum(ResponseFormat)
        .optional()
        .default(ResponseFormat.MARKDOWN)
        .describe("Response format: 'json' for raw data or 'markdown' for formatted text"),
    },
    READ_ONLY,
    async ({ offset, limit, format }) => {
      try {
        const borrowers = await getMoneyMarketBorrowers({ offset, limit });
        return {
          content: [
            {
              type: "text",
              text: formatResponse(borrowers, format, "## All Money Market Borrowers\n\n"),
            },
          ],
        };
      } catch (error) {
        return failedResult(error);
      }
    },
  );

  // Tool 25: Get Partner Summary
  registerAppTool(
    server,
    "partnersAndToken",
    "sodax_get_partner_summary",
    "Get volume and activity summary for a specific integration partner by their receiver address",
    {
      receiver: z.string().describe("The partner receiver address"),
      chainId: z.string().optional().describe("Filter by chain ID"),
      format: z
        .nativeEnum(ResponseFormat)
        .optional()
        .default(ResponseFormat.MARKDOWN)
        .describe("Response format: 'json' for raw data or 'markdown' for formatted text"),
    },
    READ_ONLY,
    async ({ receiver, chainId, format }) => {
      try {
        const summary = await getPartnerSummary(receiver, chainId);
        if (!summary) {
          return {
            content: [{ type: "text", text: formatNotFound(format, `Partner not found: ${receiver}`) }],
          };
        }
        return {
          content: [
            {
              type: "text",
              text: formatResponse(summary, format, "## Partner Summary\n\n"),
            },
          ],
        };
      } catch (error) {
        return failedResult(error);
      }
    },
  );

  // Tool 26: Get Total Supply
  registerAppTool(
    server,
    "partnersAndToken",
    "sodax_get_total_supply",
    "Get SODA token total supply as a plain number",
    {
      format: z
        .nativeEnum(ResponseFormat)
        .optional()
        .default(ResponseFormat.MARKDOWN)
        .describe("Response format: 'json' for raw data or 'markdown' for formatted text"),
    },
    READ_ONLY,
    async ({ format }) => {
      try {
        const supply = await getTotalSupply();
        return {
          content: [
            {
              type: "text",
              text: formatResponse(supply, format, "## SODA Total Supply\n\n"),
            },
          ],
        };
      } catch (error) {
        return failedResult(error);
      }
    },
  );

  // Tool 27: Get Circulating Supply
  registerAppTool(
    server,
    "partnersAndToken",
    "sodax_get_circulating_supply",
    "Get SODA token circulating supply as a plain number",
    {
      format: z
        .nativeEnum(ResponseFormat)
        .optional()
        .default(ResponseFormat.MARKDOWN)
        .describe("Response format: 'json' for raw data or 'markdown' for formatted text"),
    },
    READ_ONLY,
    async ({ format }) => {
      try {
        const supply = await getCirculatingSupply();
        return {
          content: [
            {
              type: "text",
              text: formatResponse(supply, format, "## SODA Circulating Supply\n\n"),
            },
          ],
        };
      } catch (error) {
        return failedResult(error);
      }
    },
  );

  // Bonus Tool: Refresh Cache
  registerAppTool(
    server,
    "partnersAndToken",
    "sodax_refresh_cache",
    "Clear both the backend API cache and the solver oracle cache to force fresh fetches on next requests. Reports the number of entries cleared per cache.",
    {},
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    async () => {
      const apiBefore = getCacheStats();
      const solverBefore = getSolverCacheStats();
      clearCache();
      clearSolverCache();
      expireSwapCatalog();
      const total = apiBefore.size + solverBefore.size;
      return {
        content: [
          {
            type: "text",
            text: `Cache cleared. ${total} cached entries removed (${apiBefore.size} api, ${solverBefore.size} solver).`,
          },
        ],
      };
    },
  );
}
