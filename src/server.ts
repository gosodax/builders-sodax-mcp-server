/**
 * McpServer composition: the server identity, its instructions and the tools
 * it registers. Transports live in index.ts.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { BRIDGE_HELP, SWAP_HELP } from "./constants.js";
import { withAnalytics } from "./services/analytics.js";
import type { ToolSelection, Toolsets } from "./services/profiles.js";
import { registerBridgeTools } from "./tools/bridge.js";
import { registerDocsProxyTools } from "./tools/docsProxy.js";
import { NEXT_ACTION_JSON_SCHEMA, NEXT_ACTION_SCHEMA_URI, NEXT_ACTION_URI } from "./tools/nextActionSchema.js";
import { registerSodaxApiTools } from "./tools/sodaxApi.js";
import { registerSolverRelayTools } from "./tools/solverRelay.js";
import { registerSwapTools, registerTokenTools } from "./tools/swap.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const { version: SERVER_VERSION } = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8")) as {
  version: string;
};

// Instructions sent on `initialize`, one block per toolset. The builder block steers clients to answer
// support questions ("does SODAX support chain/token X?") from the live tools
// rather than the model's training priors, which predate newer chains such as
// Hedera, Robinhood and Stacks and otherwise produce confidently wrong "no"s.
const BUILDER_INSTRUCTIONS = [
  [
    "This server exposes LIVE SODAX protocol data. It is authoritative and current;",
    "your training data is not. For any question about what SODAX supports —",
    "chains/networks, swap tokens, money-market assets, relay chain IDs — or about",
    "SODAX concepts, SDK usage or protocol behaviour, ANSWER FROM THE TOOLS, never",
    "from prior knowledge, and do not claim something is unsupported without checking.",
  ].join(" "),
  [
    "To check whether a chain is supported, call `sodax_check_chain_support` (accepts a",
    'name, ticker, chain key or EVM chain id, e.g. "Hedera", "HBAR", "hedera", "8453"). For the full',
    "network list use `sodax_get_supported_chains`; for tokens on a chain,",
    "`sodax_get_swap_tokens`. For conceptual/SDK questions, use the `docs_*` tools",
    "(SODAX documentation search). Prefer information returned by these tools over",
    "prior knowledge, and cite the tool result you used.",
  ].join(" "),
].join("\n\n");

// The contract the swap and bridge tools' results keep, as the README links it: one copy, shipped with the build.
const NEXT_ACTION_CONTRACT = readFileSync(join(__dirname, "public", "next-action.md"), "utf-8");

// What a swap and a bridge both need, said once whichever are on. This server can't see the client's other tools, so it
// says what preparing needs before anyone prepares.
const ACTION_RULES = [
  "Show the user the amounts and get their confirmation before their wallet signs; this server never signs or moves funds.",
  "It only returns unsigned transactions: before preparing, make sure a wallet tool can sign and send them",
  "on the source chain and say when each is mined (on EVM, `eth_sendTransaction` with each step's `tx`, which leaves",
  "nonce, gas and fees to the wallet; `wallet_sendCalls` for a `batch`). If there's none, ask the user to connect",
  "their wallet before preparing.",
  "Never pass private keys, seed phrases or API keys as tool inputs.",
].join(" ");

const SWAP_INSTRUCTIONS = [
  "To show or watch a price, call `sodax_swap_price` with each side as the user names it (a chain plus a symbol, an",
  'address or "native"); it builds and holds nothing. Once the user is ready to sign, call `sodax_swap_prepare` with',
  "the same sides plus their wallet as fromAddress (and the recipient as toAddress unless both chains are EVM): it",
  "returns the transactions to sign and holds the quote.",
  "If either returns UNKNOWN_TOKEN, resolve that side with `sodax_resolve_token` and ask the user; never guess a",
  "token or an address. Neither checks balances; `sodax_get_balance` reads a wallet's balance when the user",
  "isn't sure they hold enough. Only some chains can start a swap: a price from another returns UNSUPPORTED_SOURCE",
  "naming the ones that can.",
  "After the user's wallet sends the swap, call `sodax_swap_submit_and_track` with the quoteId and the swap's tx hash: it submits",
  "the swap, so call it at least once. Every swap tool result, errors included, carries nextAction: follow it until the",
  "result is terminal (retryAfterSec, where a result has one, is only when its next call is due), or read its nextStep;",
  `the \`${NEXT_ACTION_URI}\` resource says how to run it.`,
  "Never resend a swap the tracker hasn't reported as failed at the source. To cancel a submitted swap, use `sodax_swap_cancel`.",
  SWAP_HELP,
].join(" ");

const BRIDGE_INSTRUCTIONS = [
  "To move a token to the same asset on another chain, 1:1 less any partner fee: `sodax_bridge_tokens` lists what",
  "bridges between two chains (without toChain, the chains a bridge reaches), and `sodax_bridge_preview` shows what a",
  "bridge would deliver and the most its route takes now, building nothing. Once the user is ready to sign, call",
  "`sodax_bridge_prepare` with each side as the option `sodax_bridge_tokens` offered gives it, or as the user names it",
  '(a chain plus a symbol, an address or "native"), and their wallet as fromAddress (and the recipient as toAddress',
  "unless both chains are EVM): it returns the transactions to sign, the bridgeId, and warnings from the wallet's",
  "balance. If a pair can't be bridged, it names the tokens that can. If it returns UNKNOWN_TOKEN, resolve that side",
  "with `sodax_resolve_token` with for: bridge and ask the user; never guess a token or an address.",
  "After the user's wallet sends the bridge, call `sodax_bridge_submit_and_track` with the bridgeId and the bridge",
  "transaction's hash: it submits the bridge, so call it at least once, and never resend a bridge it hasn't reported failed.",
  "Every bridge tool result, errors included, carries nextAction: follow it until the result is terminal, or read its nextStep;",
  `the \`${NEXT_ACTION_URI}\` resource says how to run it.`,
  BRIDGE_HELP,
].join(" ");

const INSTRUCTIONS: Record<keyof Toolsets, string> = {
  builder: BUILDER_INSTRUCTIONS,
  swap: SWAP_INSTRUCTIONS,
  bridge: BRIDGE_INSTRUCTIONS,
};

// With both toolsets, builder tools that relay, quote and look up intents compete with the swap tools.
const BOTH_INSTRUCTIONS =
  "For a user's swap use the `sodax_swap_*` tools, not `sodax_relay_submit_tx`, `sodax_get_transaction` or `sodax_get_solver_quote`.";
const BOTH_BRIDGE_INSTRUCTIONS =
  "For a user's bridge use the `sodax_bridge_*` tools, not `sodax_relay_submit_tx` or `sodax_get_transaction`.";

// The token lookup and balance tools serve swap and bridge alike: registered once, for whichever are on.
const registerSwapTokenTools = (server: McpServer) => registerTokenTools(server, ["swap"]);
const registerBridgeTokenTools = (server: McpServer) => registerTokenTools(server, ["bridge"]);
const registerBothTokenTools = (server: McpServer) => registerTokenTools(server, ["swap", "bridge"]);

// The static tools of each toolset, in registration order. createServer registers them on a real
// server and seedToolRegistry records them for the counts, so the two can't drift.
const STATIC_REGISTRARS: Record<keyof Toolsets, ((server: McpServer) => void)[]> = {
  builder: [registerSodaxApiTools, registerSolverRelayTools],
  swap: [registerSwapTokenTools, registerSwapTools],
  bridge: [registerBridgeTokenTools, registerBridgeTools],
};

/** Every static registrar of the toolsets that are on; the token tools once, for both when both are on. */
function registrarsFor(toolsets: Toolsets): ((server: McpServer) => void)[] {
  const registrars = enabled(toolsets, STATIC_REGISTRARS).flat();
  if (!toolsets.swap || !toolsets.bridge) return registrars;
  return registrars
    .filter(register => register !== registerBridgeTokenTools)
    .map(register => (register === registerSwapTokenTools ? registerBothTokenTools : register));
}

/** The entries of a per-toolset map for the toolsets that are on, in map order. */
function enabled<T>(toolsets: Toolsets, perToolset: Record<keyof Toolsets, T>): T[] {
  return (Object.keys(perToolset) as (keyof Toolsets)[]).filter(toolset => toolsets[toolset]).map(t => perToolset[t]);
}

/**
 * Creates a McpServer with the given toolsets.
 * Used per-request in HTTP mode to avoid transport conflicts
 * when handling parallel requests.
 */
export async function createServer(toolsets: ToolSelection, clientId?: string): Promise<McpServer> {
  const server = new McpServer(
    {
      name: "sodax-mcp",
      version: SERVER_VERSION,
    },
    {
      instructions: [
        ...enabled(toolsets, INSTRUCTIONS),
        toolsets.swap || toolsets.bridge ? ACTION_RULES : undefined,
        toolsets.builder && toolsets.swap ? BOTH_INSTRUCTIONS : undefined,
        toolsets.builder && toolsets.bridge ? BOTH_BRIDGE_INSTRUCTIONS : undefined,
        toolsets.keyHint,
      ]
        .filter(Boolean)
        .join("\n\n"),
    },
  );

  // Wrap server.tool() and server.registerTool() so every tool call is tracked in PostHog
  // ⚠️  Must be called BEFORE registering any tools
  withAnalytics(server, clientId);

  for (const register of registrarsFor(toolsets)) register(server);
  if (toolsets.swap || toolsets.bridge) registerNextActionContract(server);
  // The SDK docs proxy tools are dynamic (fetched from the docs MCP), so they're never seeded.
  if (toolsets.builder) await registerDocsProxyTools(server);

  return server;
}

function registerNextActionContract(server: McpServer): void {
  server.registerResource(
    "next-action-schema",
    NEXT_ACTION_SCHEMA_URI,
    {
      title: "The nextAction schema",
      description: "The JSON Schema of every nextAction type and its fields, as an object whose nextAction it types.",
      mimeType: "application/schema+json",
    },
    uri => ({ contents: [{ uri: uri.href, mimeType: "application/schema+json", text: NEXT_ACTION_JSON_SCHEMA }] }),
  );
  server.registerResource(
    "next-action",
    NEXT_ACTION_URI,
    {
      title: "The nextAction contract",
      description:
        "How a runtime follows the nextAction every swap and bridge tool result carries: the action types, who acts on each, and the rules on arguments, sending, bounds and handoffs.",
      mimeType: "text/markdown",
    },
    uri => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: NEXT_ACTION_CONTRACT }] }),
  );
}

/**
 * Seed the module-level tool registry that `/health`, `/api`, and the landing
 * page read their counts from, without touching the docs MCP. Only the static
 * tools feed those counts — `getStaticToolCounts()` and `getToolNamesByModule()`
 * skip the `sdkDocs` module, whose live total comes from `getDocsToolNames()`.
 *
 * `registerAppTool()` records `{name, module, description}` in the registry as a
 * side effect, so a no-op recording server (whose `tool()` does nothing) is
 * enough — no real `McpServer` is built and no MCP registration runs here; that
 * only happens on the per-request servers. This also skips
 * `registerDocsProxyTools()`, whose blocking SDK docs fetch (up to 30s) would otherwise delay HTTP boot when
 * the docs MCP is unavailable and `warmDocsCache()` left the cache empty.
 */
export function seedToolRegistry(toolsets: Toolsets): void {
  // Both overloads registerAppTool uses: one with an output schema goes through registerTool.
  const recordingServer = { tool: () => ({}), registerTool: () => ({}) } as unknown as McpServer;
  for (const register of registrarsFor(toolsets)) register(recordingServer);
}
