/**
 * Bridge tools: the `bridge` profile. Registered only while its kill switch is on (off by default) and the connection
 * sent an API key (see services/profiles.ts). The token lookup and balance tools come with them (`registerTokenTools`).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { listBridgePairs } from "../services/bridge/pair.js";
import { prepareBridge, previewBridge } from "../services/bridge/prepare.js";
import { trackBridge } from "../services/bridge/track.js";
import { getRequestContext } from "../services/requestContext.js";
import { amountText } from "../services/swap/units.js";
import { registerActionTool } from "./actionTool.js";
import { pairsDecision, prepareDecision, previewDecision, trackDecision } from "./bridgeDecisions.js";
import { addressArg, chainArg, screened, textArg, tokenArg, txHashArg } from "./swap.js";

// What is sent and received; a function, so each tool gets its own schema.
const pairArgs = () => ({
  fromChain: chainArg().describe(
    'Source chain: name, ticker or key, e.g. "Arbitrum", "arb" or "0xa4b1.arbitrum", or EVM chain id (e.g. "42161").',
  ),
  fromToken: tokenArg().describe('Token the user sends: symbol ("USDC"), contract address, or "native".'),
  toChain: chainArg().describe("Destination chain name, ticker, key or EVM chain id."),
  toToken: tokenArg().describe('Token the user receives there: symbol, contract address, or "native".'),
  amount: z
    .union([textArg(96, 1), z.number()])
    .describe('Amount the user sends, in token units, as a plain decimal string: "0.5", not "1,000" or "1e6".'),
});
const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

export function registerBridgeTools(server: McpServer): void {
  registerActionTool(
    server,
    "sodax_bridge_tokens",
    "List the tokens that bridge from one chain to another, each with the token it arrives as. Reads no chain and builds nothing: use it to find what to bridge before sodax_bridge_preview or sodax_bridge_prepare.",
    {
      fromChain: chainArg().describe("Source chain name, ticker, key or EVM chain id."),
      toChain: chainArg().describe("Destination chain name, ticker, key or EVM chain id."),
    },
    readOnly,
    async ({ fromChain, toChain }) => {
      const pairs = listBridgePairs(fromChain, toChain);
      return { ...pairs, ...pairsDecision(pairs) };
    },
    "bridge",
  );

  registerActionTool(
    server,
    "sodax_bridge_preview",
    "Preview a bridge: what the user would receive (1:1 less any partner fee), and the most the route takes now. It builds and holds nothing, so use it to show a bridge; call sodax_bridge_prepare once the user is ready to sign.",
    pairArgs(),
    readOnly,
    async args => {
      const preview = await previewBridge({ ...args, amount: amountText(args.amount) }, getRequestContext().partnerFee);
      return { ...preview, ...previewDecision(preview) };
    },
    "bridge",
  );

  registerActionTool(
    server,
    "sodax_bridge_prepare",
    "Prepare a bridge for the user's wallet to sign: the same asset moved to another chain 1:1 through its SODAX hub vault, less any partner fee. Returns the transactions in order (approve if needed, then the bridge) and the bridgeId sodax_bridge_submit_and_track needs. It refuses a pair that can't be bridged (offering what can), an amount above what the route takes now, and a build that differs from the SDK's own. This server never signs or moves funds.",
    {
      ...pairArgs(),
      fromAddress: addressArg().describe("The user's wallet on the source chain, which sends the bridge. Required."),
      toAddress: addressArg().describe(
        "Recipient on the destination chain. Needed unless both chains are EVM; then it defaults to fromAddress.",
      ),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    async args => {
      const quote = await prepareBridge({ ...args, amount: amountText(args.amount) }, getRequestContext().partnerFee);
      return { ...quote, ...prepareDecision(quote) };
    },
    "bridge",
  );

  registerActionTool(
    server,
    "sodax_bridge_submit_and_track",
    "Submit and track a bridge once the user's wallet has sent its bridge transaction. Call it right after sending, then follow each result's nextAction until terminal is true, or its nextStep. Repeated calls never resubmit. It checks the transaction on chain against the bridge's build before submitting. This server never signs or moves funds.",
    {
      txHash: txHashArg().describe(
        "Hash of the bridge step's transaction on the source chain, as the wallet shows it, not the approve's.",
      ),
      bridgeId: screened(z.string().trim().toLowerCase().uuid(), { notHex64: "a bridgeId" })
        .optional()
        .describe("The bridgeId from sodax_bridge_prepare."),
      chain: chainArg().optional().describe("Source chain name, key or EVM chain id; needed only without bridgeId."),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    async args => {
      const result = await trackBridge(args);
      return { ...result, ...trackDecision(result) };
    },
    "bridge",
  );
}
