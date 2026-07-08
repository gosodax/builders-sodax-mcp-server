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

export function registerSolverRelayTools(server: McpServer): void {
  // ── Solver: oracle ──────────────────────────────────────────────────
  registerAppTool(
    server,
    "intents",
    "sodax_get_solver_oracle",
    "Get the solver's oracle prices for every (chain, token) pair it can quote. Useful for sanity-checking quote amounts against USD prices the solver is using.",
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
    "Get a swap quote from the SODAX solver. IMPORTANT: tokenSrc/tokenDst must be hub-chain asset addresses — the SODAX hub is Sonic (chainId 146); spoke-chain token addresses are rejected with 'not compatible with the quote service'. Call sodax_get_solver_oracle with chainId='146' to look up valid token addresses. quote_type='exact_input' quotes the destination amount you'd receive; 'exact_output' quotes the source amount you'd need to supply. Returns 'No path found' if the solver can't route between the tokens.",
    {
      tokenSrc: z
        .string()
        .describe(
          "REQUIRED: Source token address (the token you're spending). Must be a hub-chain asset address (chainId 146) — look one up via sodax_get_solver_oracle.",
        ),
      tokenDst: z
        .string()
        .describe(
          "REQUIRED: Destination token address (the token you want to receive). Must be a hub-chain asset address (chainId 146) — look one up via sodax_get_solver_oracle.",
        ),
      amount: z
        .string()
        .describe(
          "REQUIRED: Amount in the smallest unit of the input token (for exact_input) or output token (for exact_output). String to preserve precision.",
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
        return {
          content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : "Unknown error"}` }],
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
        return {
          content: [
            {
              type: "text",
              text: `## Relay Submit\n\n${formatResponse(result, format)}`,
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
