/**
 * Swap tools: the `swap` profile. Registered only while the kill switch is on
 * (the default) and the connection sent an API key (see services/profiles.ts).
 * The token lookup and balance tools (`registerTokenTools`) serve the bridge tools too.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getBridgeCatalog } from "../services/bridge/catalog.js";
import { forBridge } from "../services/bridge/wording.js";
import { getRequestContext } from "../services/requestContext.js";
import { readBalances } from "../services/swap/balance.js";
import { cancelSwap } from "../services/swap/cancel.js";
import { ActionError } from "../services/swap/errors.js";
import { DEFAULT_DEADLINE_MINUTES, DEFAULT_SLIPPAGE_BPS, quoteSwap } from "../services/swap/quote.js";
import { resolveToken } from "../services/swap/resolver.js";
import { type SecretField, secretRefusalText } from "../services/swap/secrets.js";
import { isAnyTxHash } from "../services/swap/sources/index.js";
import { getSwapCatalog } from "../services/swap/tokens.js";
import { trackSwapWaiting } from "../services/swap/track.js";
import { amountText } from "../services/swap/units.js";
import { registerActionTool } from "./actionTool.js";
import {
  type TokenPurpose,
  balanceDecision,
  cancelDecision,
  quoteDecision,
  resolveDecision,
  trackDecision,
} from "./swapDecisions.js";

/**
 * `schema`, plus the SECRET_REJECTED refusal for a value that fails it and looks like a secret: the
 * handler's own screening never sees a value zod rejects. A tx-hash field takes every source family's
 * format, which some key shapes fit too, so it's screened even when it passes.
 */
export function screened(schema: z.ZodType<string>, field: SecretField = {}) {
  return schema.superRefine((value, ctx) => {
    const screen = field.txHash || !schema.safeParse(value).success;
    const refusal = screen ? secretRefusalText(value, field) : undefined;
    if (refusal) ctx.addIssue({ code: "custom", message: refusal });
  });
}

// Functions, so each field gets its own schema: one reused within a tool becomes a `$ref` in its JSON schema.
export const textArg = (max: number, min = 0) => screened(z.string().trim().min(min).max(max));
export const chainArg = () => textArg(64, 1);
export const tokenArg = () => textArg(128, 1);
export const addressArg = () => textArg(128).optional();
export const txHashArg = () =>
  screened(z.string().trim().refine(isAnyTxHash, "Must be a transaction hash as the wallet shows it."), {
    txHash: true,
  });
const quoteIdArg = () => screened(z.string().trim().toLowerCase().uuid(), { notHex64: "a quoteId" });

// The swap both pricing and preparing take; a function, so each tool gets its own schema.
const pairArgs = () => ({
  fromChain: chainArg().describe(
    'Source chain: name, ticker or key, e.g. "Arbitrum", "arb" or "0xa4b1.arbitrum", or EVM chain id (e.g. "42161"). If a swap can\'t start there, the error lists the chains it can.',
  ),
  fromToken: tokenArg().describe('Token the user sends: symbol ("USDC"), contract address, or "native".'),
  toChain: chainArg().describe("Destination chain name, ticker, key or EVM chain id."),
  toToken: tokenArg().describe('Token the user receives: symbol, contract address, or "native".'),
  amount: z
    .union([textArg(96, 1), z.number()])
    .describe('Amount the user sends, in token units, as a plain decimal string: "0.5", not "1,000" or "1e6".'),
});

// What track and cancel take to find the swap. The quote is bound to the API key that made it.
const swapArgs = {
  txHash: txHashArg().describe(
    "Hash of the swap step's transaction on the source chain, as the wallet shows it (EVM: 0x and 64 hex characters), not the approve's. From a batch, the transaction hash wallet_getCallsStatus reports, not the batch id.",
  ),
  quoteId: quoteIdArg().optional().describe("The quoteId from sodax_swap_prepare."),
  chain: chainArg()
    .optional()
    .describe('Source chain name, key or EVM chain id ("42161"); needed only without quoteId.'),
};
const swapActionHints = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true };

export function registerSwapTools(server: McpServer): void {
  registerActionTool(
    server,
    "sodax_swap_price",
    "Price a cross-chain swap: what the user would receive and both sides' USD value. It builds and holds nothing, so use it to show or watch a price; call sodax_swap_prepare only once the user is ready to sign. Only some chains can start a swap: a price from another returns UNSUPPORTED_SOURCE naming the ones that can.",
    pairArgs(),
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    async args => {
      const quote = await quoteSwap(
        { ...args, amount: amountText(args.amount), mode: "price" },
        getRequestContext().partnerFee,
      );
      return { ...quote, ...quoteDecision(quote) };
    },
  );

  registerActionTool(
    server,
    "sodax_swap_prepare",
    "Prepare a cross-chain swap for the user's wallet to sign: the transactions in order (approve if needed, then the swap) and the quoteId sodax_swap_submit_and_track needs. It holds the quote until its deadline, so call it once the user has seen the price and is ready to sign; to show or watch a price, use sodax_swap_price. This server never signs or moves funds.",
    {
      ...pairArgs(),
      fromAddress: addressArg().describe(
        "The user's wallet on the source chain, which sends the swap. Required: without it, the error names what to ask the user for.",
      ),
      toAddress: addressArg().describe(
        "Recipient on the destination chain. Needed unless both chains are EVM; then it defaults to fromAddress.",
      ),
      slippageBps: z
        .number()
        .int()
        .min(1)
        .max(500)
        .default(DEFAULT_SLIPPAGE_BPS)
        .describe(
          "Most the received amount may fall below the expected one, in basis points (100 = 1%). The tighter it is, the likelier no solver fills the swap; an unfilled one is refunded after its deadline.",
        ),
      deadlineMinutes: z
        .number()
        .int()
        .min(5)
        .max(60)
        .default(DEFAULT_DEADLINE_MINUTES)
        .describe("Minutes the user has to send the swap before the quote expires."),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    async args => {
      const quote = await quoteSwap(
        { ...args, amount: amountText(args.amount), mode: "prepare" },
        getRequestContext().partnerFee,
      );
      // Nothing submits the deposit unless track is called; a field is harder to miss than a sentence. Kept for
      // clients that read it, though nextAction's execute.afterSend says the same.
      const afterSend: AfterSend | undefined =
        quote.status === "ready"
          ? { tool: "sodax_swap_submit_and_track", args: { quoteId: quote.quoteId }, needs: "txHash" }
          : undefined;
      return { ...quote, ...(afterSend && { afterSend }), ...quoteDecision(quote) };
    },
  );

  registerActionTool(
    server,
    "sodax_swap_submit_and_track",
    "Submit and track a swap once the user's wallet has sent its swap transaction. Call it right after sending, then follow each result's nextAction until terminal is true (a call to make again waits up to 20 seconds for the swap to move on), or its nextStep. Repeated calls never resubmit. It checks the transaction on chain before submitting. This server never signs or moves funds.",
    swapArgs,
    swapActionHints,
    async args => {
      const result = await trackSwapWaiting(args);
      return { ...result, ...trackDecision(result) };
    },
  );

  registerActionTool(
    server,
    "sodax_swap_cancel",
    "Cancel a swap that hasn't been filled: once it's submitted, or for a swap from Sonic quoted here, as soon as its tx is mined. The first call returns the cancel transaction for the user's wallet to sign; once it's sent, call again with cancelTxHash and this server relays it, or for a swap from Sonic confirms it on the hub. This server never signs or moves funds.",
    {
      ...swapArgs,
      cancelTxHash: txHashArg()
        .optional()
        .describe(
          "Hash of the cancel transaction as the wallet shows it, once the user's wallet has sent the cancel step.",
        ),
    },
    swapActionHints,
    async args => {
      const result = await cancelSwap(args);
      return { ...result, ...cancelDecision(result) };
    },
  );
}

// Which list a token is looked up in: the bridge's differs from the swap's. Without the swap tools, it's the bridge's.
const purposeArg = (byDefault: TokenPurpose) =>
  z
    .enum(["swap", "bridge"])
    .default(byDefault)
    .describe(
      `${byDefault === "swap" ? '"swap" (the default) or "bridge"' : '"bridge" (the default) or "swap"'}: which tool the token is for. Some tokens bridge but don't swap.`,
    );

const catalogFor = async (purpose: TokenPurpose) => (purpose === "bridge" ? getBridgeCatalog() : getSwapCatalog());

/** A lookup for a bridge fails in a bridge's words: the shared resolver's name the swap. */
async function worded<T>(purpose: TokenPurpose, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw purpose === "bridge" && error instanceof ActionError ? forBridge(error) : error;
  }
}

/**
 * The token lookup and balance read, for the swap and the bridge tools alike: registered once for either, counted
 * under `module`, the swap tools' when they're on.
 */
export function registerTokenTools(server: McpServer, module: "swap" | "bridge" = "swap"): void {
  registerActionTool(
    server,
    "sodax_resolve_token",
    "Look up a token on a chain: its address, decimals and hub asset. The swap and bridge tools take symbols themselves; use this when one returns UNKNOWN_TOKEN, with for: bridge for a bridge. Returns resolved, ambiguous (ask the user to pick; never guess) or not_found (with suggestions).",
    {
      chain: chainArg().describe(
        'Chain name, ticker or key, e.g. "Arbitrum", "arb" or "0xa4b1.arbitrum", or EVM chain id (e.g. "42161").',
      ),
      query: tokenArg().describe('Token symbol ("USDC"), contract address, or "native" for the chain\'s gas token.'),
      for: purposeArg(module),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    async args =>
      worded(args.for, async () => {
        const resolution = resolveToken(await catalogFor(args.for), args.chain, args.query);
        return { ...resolution, ...resolveDecision(resolution, args.for) };
      }),
    { module },
  );

  registerActionTool(
    server,
    "sodax_get_balance",
    "Read a wallet's native balance on a chain and, optionally, one token's. The swap and bridge tools don't check balances; use this when the user isn't sure they hold enough, with for: bridge for a bridge's token. Figures can be up to 5 seconds old; after sending a swap or a bridge, follow it with its submit_and_track tool rather than re-reading balances.",
    {
      chain: chainArg().describe(
        'Chain name, ticker or key, e.g. "Arbitrum", "arb" or "0xa4b1.arbitrum", or EVM chain id (e.g. "42161").',
      ),
      address: textArg(128, 1).describe("The wallet's address on that chain."),
      token: tokenArg()
        .optional()
        .describe('Token symbol ("USDC"), contract address, or "native". Omit for the native balance only.'),
      for: purposeArg(module),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    async args =>
      worded(args.for, async () => {
        const balances = await readBalances(args, await catalogFor(args.for));
        return { ...balances, ...balanceDecision(balances) };
      }),
    { module },
  );
}

/** What a ready quote tells the agent to call once the wallet has sent the swap: `execute.afterSend`, kept as a field. */
export interface AfterSend {
  tool: "sodax_swap_submit_and_track";
  args: { quoteId: string };
  needs: "txHash";
}
