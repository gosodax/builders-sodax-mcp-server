/**
 * Swap tools: the `swap` profile. Registered only while the rollout switch is
 * on and the connection sent an API key (see services/profiles.ts).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getRequestContext } from "../services/requestContext.js";
import { type SwapQuote, quoteSwap } from "../services/swap/quote.js";
import { type Resolution, resolveToken } from "../services/swap/resolver.js";
import { type SwapsApiToken, getSwapCatalog } from "../services/swap/tokens.js";
import { registerActionTool } from "./actionTool.js";

// zod schemas are immutable, so each tool adds its own description to these.
const chainArg = z.string().trim().min(1).max(64);
const tokenArg = z.string().trim().min(1).max(128);
const addressArg = z.string().trim().max(128).optional();

export function registerSwapTools(server: McpServer): void {
  registerActionTool(
    server,
    "sodax_resolve_token",
    "Resolve a token on a chain to the address, decimals and hub asset the swap tools need. Returns resolved, ambiguous (ask the user to pick; never guess) or not_found (with suggestions).",
    {
      chain: chainArg.describe(
        'Chain name, ticker or key, e.g. "Arbitrum", "arb" or "0xa4b1.arbitrum", or EVM chain id (e.g. "42161").',
      ),
      query: tokenArg.describe('Token symbol ("USDC"), contract address, or "native" for the chain\'s gas token.'),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    async ({ chain, query }) => {
      const resolution = resolveToken(await getSwapCatalog(), chain, query);
      return { ...resolution, nextStep: resolveNextStep(resolution) };
    },
  );

  registerActionTool(
    server,
    "sodax_swap_quote",
    "Quote a cross-chain swap. Without fromAddress it returns a price only; with it, the transactions for the user's wallet to sign (approve if needed, then the swap). This server never signs or moves funds.",
    {
      fromChain: chainArg.describe("Source chain key from sodax_resolve_token."),
      fromToken: tokenArg.describe("Address of the token the user sends, from sodax_resolve_token."),
      toChain: chainArg.describe("Destination chain key from sodax_resolve_token."),
      toToken: tokenArg.describe("Address of the token the user receives, from sodax_resolve_token."),
      amount: z
        .string()
        .trim()
        .min(1)
        .max(96)
        .describe('Amount the user sends, in token units as a plain decimal: "0.5", not "1,000" or "1e6".'),
      fromAddress: addressArg.describe("The user's wallet on the source chain. Omit for a price-only quote."),
      toAddress: addressArg.describe(
        "Recipient on the destination chain. Defaults to fromAddress when the destination is EVM.",
      ),
      slippageBps: z
        .number()
        .int()
        .min(1)
        .max(500)
        .default(100)
        .describe("Most the received amount may fall below the quote, in basis points (100 = 1%)."),
      deadlineMinutes: z
        .number()
        .int()
        .min(5)
        .max(60)
        .default(15)
        .describe("Minutes the user has to send the swap before the quote expires."),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    async args => {
      const quote = await quoteSwap(args, getRequestContext().partnerFee);
      return { ...quote, nextStep: quoteNextStep(quote) };
    },
  );
}

// A swap deposits the token the user sends into its hub vault and withdraws the one they receive.
const RESTRICTED = {
  withdrawOnly: "is withdraw-only: use it only as the token the user receives",
  depositOnly: "is deposit-only: use it only as the token the user sends",
} as const;

const USE_RESOLVED = "Pass chain.key and token.address to sodax_swap_quote for this side; amounts stay in token units.";

/**
 * Built from catalog symbols, addresses and chain names only, never from the caller's
 * query or a token's free-text name.
 */
export function resolveNextStep(resolution: Resolution): string {
  const chain = resolution.chain.name;
  switch (resolution.status) {
    case "resolved": {
      const { token } = resolution;
      const named = `${token.symbol} on ${chain}`;
      // The same address can be a different token on each chain.
      const found = resolution.matchedBy === "address" ? `That address is ${named}. ` : "";
      const restricted = token.access ? `${named} ${RESTRICTED[token.access]}. ` : "";
      return `${found}${restricted}${USE_RESOLVED}`;
    }
    case "ambiguous": {
      // Two candidates can share a symbol in any case (bridged and native USDC); the address tells them apart.
      const { candidates } = resolution;
      const labels = candidates.map(token => {
        const twins = candidates.filter(other => other.symbol.toLowerCase() === token.symbol.toLowerCase());
        return twins.length > 1 ? `${token.symbol} (${twinAddress(token, twins)})` : token.symbol;
      });
      const ask =
        labels.length === 1
          ? `whether they mean ${labels[0]} on ${chain}`
          : `which of ${labels.join(", ")} on ${chain} they mean`;
      return `Ask the user ${ask}, then call sodax_resolve_token again with its address.`;
    }
    case "not_found": {
      const [first] = resolution.suggestions;
      const nearest = first && `${first.symbol}${first.isNative ? " (the native token)" : ""}`;
      if (resolution.otherChains) {
        const found = resolution.otherChains.map(other => `${other.token.symbol} on ${other.chain.name}`).join(", ");
        // A symbol listed elsewhere may still be a near miss here: WETH on Arbitrum is most likely its ETH.
        if (nearest) {
          return `No swap token on ${chain} matches that; it is listed as ${found}, and the nearest on ${chain} is ${nearest}. Ask the user which they mean, then call sodax_resolve_token again with that chain.`;
        }
        return `No swap token on ${chain} matches that; it is ${found}. Confirm the chain with the user, then call sodax_resolve_token again with the chain the user confirms.`;
      }
      if (!nearest) return `No swap token matches on ${chain}; confirm the chain and token with the user.`;
      return `No swap token matches on ${chain}; ask the user whether they mean ${nearest} or another suggestion.`;
    }
  }
}

/** Head and tail, as a prefix alone repeats (every Hedera address starts `0x00000000`); in full when those collide. */
function twinAddress(token: SwapsApiToken, twins: SwapsApiToken[]): string {
  const short = shortAddress(token.address);
  return twins.some(other => other !== token && shortAddress(other.address) === short) ? token.address : short;
}

function shortAddress(address: string): string {
  return address.length > 16 ? `${address.slice(0, 6)}…${address.slice(-6)}` : address;
}

function quoteNextStep(quote: SwapQuote): string {
  const { from, to, partnerFee } = quote;
  const fee = partnerFee ? `, including a ${partnerFee.amount} ${partnerFee.symbol} partner fee,` : "";
  const show = `Show the user they send ${from.amount} ${from.symbol} on ${from.chain.name}${fee} and receive about ${to.expectedAmount} ${to.symbol} on ${to.chain.name} (at least ${to.minimumAmount})`;
  if (quote.status === "price_only") {
    const needed = quote.missing.map(field =>
      field === "fromAddress"
        ? `fromAddress (their wallet on ${from.chain.name})`
        : `toAddress (their address on ${to.chain.name})`,
    );
    return `${show}. To prepare the swap, call sodax_swap_quote again with ${needed.join(" and ")}.`;
  }
  // Until sodax_swap_track lands, nothing submits the deposit to the solver, so the swap must not be sent.
  return [
    `${show} at ${quote.toAddress}; the quote expires at ${quote.expiresAt}.`,
    "This server can't submit swaps yet: don't send the swap step or the batch, or the deposit would sit unfilled.",
  ].join(" ");
}
