/**
 * Solver + Intent Relay Tools
 *
 * MCP tool definitions for the SODAX solver (oracle, quote) and the
 * cross-chain intent relay (submit, get_transaction_packets, get_packet).
 *
 * Solver lives at https://api.sodax.com/v1/intent (separate from /v1/be).
 * Relay lives at https://xcall-relay.nw.iconblockchain.xyz (ICON xCall).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { getRelayPacket, getRelayTransactionPackets, submitRelayTx } from "../services/relay.js";
import { getSolverOracle, getSolverQuote } from "../services/solver.js";
import { registerAppTool } from "../services/toolRegistry.js";
import { ResponseFormat } from "../types.js";
import { formatResponse } from "./formatters.js";

const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: true,
};

// Relay submit isn't destructive in the typical sense — the tx is already
// finalized on the source chain; submit just enqueues the relay packet.
// Re-submitting the same tx is a no-op on the network side, hence idempotent.
const RELAY_SUBMIT: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

/**
 * Map an upstream solver-quote error to an actionable, caller-facing hint.
 *
 * The solver returns two distinct HTTP-400 failures (both already naming the
 * two addresses), and the right next step differs (verified against the live
 * api.sodax.com quote endpoint):
 *  - "not compatible with the quote service" → one address isn't a recognized
 *    hub asset. This fires for spoke-chain (non-chainId-146) or otherwise
 *    unrecognized addresses; a chainId-146 hub asset passes this check (an
 *    unroutable one fails later with "No path" instead). Passing the check
 *    doesn't guarantee a route, so steer callers to the reliable set.
 *  - "No path was found between …" → both tokens are valid chainId-146 hub
 *    assets but the solver couldn't route this pair *for this amount*. Routing
 *    is pair/amount/liquidity-dependent, so a smaller amount or a more liquid
 *    counterparty often works. Many wrapped/derivative entries (e.g. WBTC,
 *    waLocBTC, SONIC_SODA_ASSET) are oracle-priced but frequently unroutable.
 *
 * Returns null for any other message so we never bolt a misleading hint onto an
 * unrelated failure (timeouts, 5xx, contract drift, …).
 */
export function quoteErrorHint(message: string): string | null {
  const m = message.toLowerCase();
  if (m.includes("not compatible with the quote service")) {
    return "Hint: one of the addresses isn't a recognized hub asset — spoke-chain and other non-146 addresses are rejected here. Use a hub-chain (Sonic, chainId 146) asset address from sodax_get_solver_oracle; for a reliable next pick prefer a canonical bridged *_ASSET hub token (e.g. BTC_BTC_ASSET, ETH_ASSET) or a major stablecoin like SONIC_USDC_ASSET — chainId 146 alone doesn't guarantee a route.";
  }
  if (m.includes("no path was found")) {
    return "Hint: both tokens are valid hub assets, but the solver couldn't route this pair for this amount. Routing is pair/amount/liquidity-dependent — retry with a smaller amount, or pick a more liquid counterparty (a canonical bridged *_ASSET hub token, or a major stablecoin like SONIC_USDC_ASSET). Many wrapped/derivative entries (e.g. WBTC, waLocBTC, SONIC_SODA_ASSET) are oracle-priced but frequently have no route.";
  }
  return null;
}

export function registerSolverRelayTools(server: McpServer): void {
  // ── Solver: oracle ──────────────────────────────────────────────────
  registerAppTool(
    server,
    "intents",
    "sodax_get_solver_oracle",
    "Get the solver's oracle USD prices per (chain, token). For quoting with sodax_get_solver_quote, filter chainId='146': chainId-146 addresses pass the quote service's compatibility check, while spoke-chain (non-146) addresses are rejected with 'not compatible with the quote service'. Caveat: passing that check (being listed/priced) does NOT guarantee a swap route — canonical bridged *_ASSET hub tokens and major stablecoins route most reliably, while many wrapped/derivative/money-market entries (e.g. WBTC, waLocBTC, SONIC_SODA_ASSET) are priced but frequently return 'No path was found', and routability is pair/amount/liquidity-dependent. Also useful for sanity-checking quote amounts against the USD prices the solver uses.",
    {
      chainId: z
        .string()
        .optional()
        .describe(
          "Filter results to a single intent-relay chain ID (decimal string, e.g. '146' for Sonic). Call sodax_get_relay_chain_id_map to translate.",
        ),
      symbol: z
        .string()
        .optional()
        .describe("Filter by token symbol (case-insensitive exact match, e.g. 'SODA', 'bnUSD')"),
      format: z
        .nativeEnum(ResponseFormat)
        .optional()
        .default(ResponseFormat.MARKDOWN)
        .describe("Response format: 'json' for raw data or 'markdown' for formatted text"),
    },
    READ_ONLY,
    async ({ chainId, symbol, format }) => {
      try {
        const all = await getSolverOracle();
        const filtered = all.filter(p => {
          if (chainId && p.chainId !== chainId) return false;
          if (symbol && p.symbol.toLowerCase() !== symbol.toLowerCase()) return false;
          return true;
        });
        const header = `## Solver Oracle Prices\n\n${filtered.length} of ${all.length} prices${chainId ? ` on chain ${chainId}` : ""}${symbol ? ` for ${symbol}` : ""}\n\n`;
        return {
          content: [
            {
              type: "text",
              text: header + formatResponse(filtered, format),
            },
          ],
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : "Unknown error"}` }],
          isError: true,
        };
      }
    },
  );

  // ── Solver: quote ───────────────────────────────────────────────────
  registerAppTool(
    server,
    "intents",
    "sodax_get_solver_quote",
    "Get a swap quote from the SODAX solver. tokenSrc/tokenDst MUST be hub-chain (Sonic, chainId 146) asset addresses — look them up with sodax_get_solver_oracle (chainId='146'). Working example: tokenSrc='0xeb0393893b5bf98a50073d6740738b08e575058b' (BTC_BTC_ASSET) → tokenDst='0xaeafa26e43f46cd83efe89b1e57c858eb5685a24' (ETH_ASSET), amount='99800', quoteType='exact_input' returns a quoted_amount. exact_input quotes the destination amount you'd receive; exact_output quotes the source amount you'd need. There are two distinct HTTP-400 failures, both naming the two addresses: (1) 'not compatible with the quote service' = an address isn't a recognized hub asset (a spoke-chain or otherwise non-chainId-146 address was passed) → use a chainId-146 address from sodax_get_solver_oracle, and for a reliable pick prefer a canonical bridged *_ASSET hub token or major stablecoin (chainId 146 alone doesn't guarantee a route). (2) 'No path was found between X and Y' = both tokens are valid hub assets but the solver couldn't route this pair for this amount → routing is pair/amount/liquidity-dependent, so retry with a smaller amount or a more liquid counterparty (a canonical bridged *_ASSET token, or a major stablecoin like SONIC_USDC_ASSET). Many wrapped/derivative entries (e.g. WBTC, waLocBTC, SONIC_SODA_ASSET) are oracle-priced but frequently have no route — prefer canonical bridged *_ASSET hub tokens.",
    {
      tokenSrc: z
        .string()
        .describe(
          "REQUIRED: Source token address (the token you're spending). Hub-chain (Sonic, chainId 146) asset address from sodax_get_solver_oracle. Prefer canonical bridged *_ASSET tokens (e.g. BTC_BTC_ASSET 0xeb0393893b5bf98a50073d6740738b08e575058b); wrapped/derivative entries like WBTC are priced but frequently have no route.",
        ),
      tokenDst: z
        .string()
        .describe(
          "REQUIRED: Destination token address (the token you want to receive). Hub-chain (Sonic, chainId 146) asset address from sodax_get_solver_oracle (e.g. ETH_ASSET 0xaeafa26e43f46cd83efe89b1e57c858eb5685a24). Prefer canonical bridged *_ASSET tokens or a major stablecoin for a routable pair.",
        ),
      amount: z
        .string()
        .describe(
          "REQUIRED: Amount in the smallest unit of the input token (for exact_input) or output token (for exact_output). String to preserve precision. Note: a very large amount can exceed available liquidity and return 'No path was found' even for an otherwise-valid pair — reduce it if that happens.",
        ),
      quoteType: z
        .enum(["exact_input", "exact_output"])
        .optional()
        .default("exact_input")
        .describe(
          "'exact_input' (default): given input amount, quote output amount. 'exact_output': given output amount, quote input amount required.",
        ),
      format: z
        .nativeEnum(ResponseFormat)
        .optional()
        .default(ResponseFormat.MARKDOWN)
        .describe("Response format: 'json' for raw data or 'markdown' for formatted text"),
    },
    READ_ONLY,
    async ({ tokenSrc, tokenDst, amount, quoteType, format }) => {
      try {
        const quote = await getSolverQuote({
          token_src: tokenSrc,
          token_dst: tokenDst,
          amount,
          quote_type: quoteType,
        });
        const header = `## Solver Quote\n\n**${quoteType}** ${amount} ${tokenSrc.slice(0, 10)}... → ${tokenDst.slice(0, 10)}...\n\n`;
        return {
          content: [
            {
              type: "text",
              text: header + formatResponse(quote, format),
            },
          ],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        const hint = quoteErrorHint(message);
        return {
          content: [{ type: "text", text: hint ? `Error: ${message}\n\n${hint}` : `Error: ${message}` }],
          isError: true,
        };
      }
    },
  );

  // ── Relay: submit ───────────────────────────────────────────────────
  registerAppTool(
    server,
    "relay",
    "sodax_relay_submit_tx",
    "Submit a confirmed spoke-chain transaction to the SODAX intent relay so it can be delivered to the destination chain. The tx must already be finalized on the source chain. Re-submitting the same tx is a no-op. For split-tx chains (Solana, Bitcoin) supply the optional `data` argument.",
    {
      chainId: z
        .string()
        .describe(
          "REQUIRED: Intent-relay chain ID of the source chain (decimal string, e.g. '146' for Sonic, '2' for Ethereum). Call sodax_get_relay_chain_id_map to translate from a chain key.",
        ),
      txHash: z.string().describe("REQUIRED: The confirmed transaction hash on the source chain"),
      data: z
        .object({
          address: z.string().describe("Contract address for split-tx chains"),
          payload: z.string().describe("Hex payload for split-tx chains"),
        })
        .optional()
        .describe("Required only for split-tx chains (Solana, Bitcoin). Omit for EVM chains."),
      format: z
        .nativeEnum(ResponseFormat)
        .optional()
        .default(ResponseFormat.MARKDOWN)
        .describe("Response format: 'json' for raw data or 'markdown' for formatted text"),
    },
    RELAY_SUBMIT,
    async ({ chainId, txHash, data, format }) => {
      try {
        const result = await submitRelayTx({
          chain_id: chainId,
          tx_hash: txHash,
          ...(data ? { data } : {}),
        });
        // audit solver-relay-clients:M-1 — this is the only state-changing tool
        // here, so a relay-reported failure must not read as an accepted
        // submission. A non-2xx now throws in services/relay.ts; a 2xx body
        // that says `success: false` is surfaced with isError so the caller
        // (and the analytics wrapper) both see a failure.
        const failed = result.success === false;
        return {
          content: [
            {
              type: "text",
              text: `## Relay Submit${failed ? " — FAILED" : ""}\n\n${formatResponse(result, format)}`,
            },
          ],
          ...(failed ? { isError: true } : {}),
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : "Unknown error"}` }],
          isError: true,
        };
      }
    },
  );

  // ── Relay: get transaction packets ──────────────────────────────────
  registerAppTool(
    server,
    "relay",
    "sodax_relay_get_transaction_packets",
    "List every cross-chain packet emitted by a given source transaction. Use this to track relay status — a packet is complete when status='executed' and dst_tx_hash is populated.",
    {
      chainId: z
        .string()
        .describe(
          "REQUIRED: Intent-relay chain ID of the source chain (decimal string, e.g. '146'). Call sodax_get_relay_chain_id_map to translate from a chain key.",
        ),
      txHash: z.string().describe("REQUIRED: The source-chain transaction hash whose packets you want to inspect"),
      format: z
        .nativeEnum(ResponseFormat)
        .optional()
        .default(ResponseFormat.MARKDOWN)
        .describe("Response format: 'json' for raw data or 'markdown' for formatted text"),
    },
    READ_ONLY,
    async ({ chainId, txHash, format }) => {
      try {
        const result = await getRelayTransactionPackets({
          chain_id: chainId,
          tx_hash: txHash,
        });
        const header = `## Relay Packets for ${txHash.slice(0, 10)}...\n\n`;
        if (!result.success) {
          return {
            content: [
              {
                type: "text",
                text: header + formatResponse(result, format),
              },
            ],
          };
        }
        const summary = `${result.data.length} packet(s) found\n\n`;
        return {
          content: [
            {
              type: "text",
              text: header + summary + formatResponse(result.data, format),
            },
          ],
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : "Unknown error"}` }],
          isError: true,
        };
      }
    },
  );

  // ── Relay: get packet ───────────────────────────────────────────────
  registerAppTool(
    server,
    "relay",
    "sodax_relay_get_packet",
    "Fetch a single relay packet by its connection serial number (conn_sn). Returns the packet data on success or a `{success:false, message}` shape if the packet isn't found.",
    {
      chainId: z.string().describe("REQUIRED: Intent-relay chain ID of the source chain (decimal string)"),
      txHash: z.string().describe("REQUIRED: The source-chain transaction hash"),
      connSn: z.coerce
        .string()
        .describe(
          "REQUIRED: Connection serial number identifying the packet within the tx. Accepts string or number (numeric values are coerced — convenient for piping back a previously-fetched packet's `conn_sn` field).",
        ),
      format: z
        .nativeEnum(ResponseFormat)
        .optional()
        .default(ResponseFormat.MARKDOWN)
        .describe("Response format: 'json' for raw data or 'markdown' for formatted text"),
    },
    READ_ONLY,
    async ({ chainId, txHash, connSn, format }) => {
      try {
        const result = await getRelayPacket({
          chain_id: chainId,
          tx_hash: txHash,
          conn_sn: connSn,
        });
        return {
          content: [
            {
              type: "text",
              text: `## Relay Packet (conn_sn=${connSn})\n\n${formatResponse(result, format)}`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : "Unknown error"}` }],
          isError: true,
        };
      }
    },
  );
}
