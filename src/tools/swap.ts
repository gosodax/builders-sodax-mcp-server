/**
 * Swap tools: the `swap` profile. Registered only while the rollout switch is
 * on and the connection sent an API key (see services/profiles.ts).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type Resolution, resolveToken } from "../services/swap/resolver.js";
import { getSwapCatalog } from "../services/swap/tokens.js";
import { registerActionTool } from "./actionTool.js";

export function registerSwapTools(server: McpServer): void {
  registerActionTool(
    server,
    "sodax_resolve_token",
    "Resolve a token on a chain to the address, decimals and hub asset the swap tools need. Returns resolved, ambiguous (ask the user to pick; never guess) or not_found (with suggestions).",
    {
      chain: z
        .string()
        .trim()
        .min(1)
        .max(64)
        .describe('Chain name, ticker or key, e.g. "Arbitrum", "arb" or "0xa4b1.arbitrum".'),
      query: z
        .string()
        .trim()
        .min(1)
        .max(128)
        .describe('Token symbol ("USDC"), contract address, or "native" for the chain\'s gas token.'),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    async ({ chain, query }) => {
      const resolution = resolveToken(await getSwapCatalog(), chain, query);
      return { ...resolution, nextStep: resolveNextStep(resolution) };
    },
  );
}

// A swap deposits the token the user sends into its hub vault and withdraws the one they receive.
const RESTRICTED = {
  withdrawOnly: "is withdraw-only: use it only as the token the user receives",
  depositOnly: "is deposit-only: use it only as the token the user sends",
} as const;

const USE_RESOLVED = "Use chain.key and token.address for this side of the swap; amounts stay in human units.";

/** Built from catalog symbols, names and chain names only, never from the caller's query. */
export function resolveNextStep(resolution: Resolution): string {
  const chain = resolution.chain.name;
  switch (resolution.status) {
    case "resolved": {
      const { token } = resolution;
      return token.access ? `${token.symbol} on ${chain} ${RESTRICTED[token.access]}. ${USE_RESOLVED}` : USE_RESOLVED;
    }
    case "ambiguous": {
      // Two candidates can share a symbol (bridged and native USDC); the name tells them apart.
      const symbols = resolution.candidates.map(token => token.symbol);
      const labels = resolution.candidates
        .map(token =>
          symbols.indexOf(token.symbol) !== symbols.lastIndexOf(token.symbol)
            ? `${token.symbol} (${token.name})`
            : token.symbol,
        )
        .join(", ");
      return `Ask the user which of ${labels} on ${chain} they mean, then call sodax_resolve_token again with its address.`;
    }
    case "not_found": {
      const [first] = resolution.suggestions;
      if (!first) return `No swap token matches on ${chain}; confirm the chain and token with the user.`;
      const native = first.isNative ? " (the native token)" : "";
      return `No swap token matches on ${chain}; ask the user whether they mean ${first.symbol}${native} or another suggestion.`;
    }
  }
}
