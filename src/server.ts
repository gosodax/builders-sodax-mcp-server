/**
 * McpServer composition: the server identity, its instructions and the tools
 * it registers. Transports live in index.ts.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withAnalytics } from "./services/analytics.js";
import type { ToolSelection, Toolsets } from "./services/profiles.js";
import { registerDocsProxyTools } from "./tools/docsProxy.js";
import { registerSodaxApiTools } from "./tools/sodaxApi.js";
import { registerSolverRelayTools } from "./tools/solverRelay.js";
import { registerSwapTools } from "./tools/swap.js";

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
    'name, ticker or chain key, e.g. "Hedera", "HBAR", "hedera"). For the full',
    "network list use `sodax_get_supported_chains`; for tokens on a chain,",
    "`sodax_get_swap_tokens`. For conceptual/SDK questions, use the `docs_*` tools",
    "(SODAX documentation search). Prefer information returned by these tools over",
    "prior knowledge, and cite the tool result you used.",
  ].join(" "),
].join("\n\n");

const SWAP_INSTRUCTIONS = [
  "To prepare a swap, call `sodax_swap_quote` with each side as the user names it (a chain plus a symbol, an",
  'address or "native") and, when you know it, the user\'s wallet as fromAddress; without it you get a price only.',
  "If the quote returns UNKNOWN_TOKEN, resolve that side with `sodax_resolve_token` and ask the user; never guess a",
  "token or an address.",
  "Show the user the amounts and get their confirmation before their wallet signs; this server never signs or moves funds.",
  "After the user's wallet sends the swap, call `sodax_swap_track` with the quoteId and the swap's tx hash: it submits",
  "the swap, so call it at least once, and again until it reports solved or failed. Never resend a swap the tracker",
  "hasn't reported as failed at the source. To cancel a submitted swap, use `sodax_swap_cancel`.",
].join(" ");

const INSTRUCTIONS: Record<keyof Toolsets, string> = { builder: BUILDER_INSTRUCTIONS, swap: SWAP_INSTRUCTIONS };

// The static tools of each toolset, in registration order. createServer registers them on a real
// server and seedToolRegistry records them for the counts, so the two can't drift.
const STATIC_REGISTRARS: Record<keyof Toolsets, ((server: McpServer) => void)[]> = {
  builder: [registerSodaxApiTools, registerSolverRelayTools],
  swap: [registerSwapTools],
};

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
      name: "builders-sodax-mcp-server",
      version: SERVER_VERSION,
    },
    { instructions: [...enabled(toolsets, INSTRUCTIONS), toolsets.keyHint].filter(Boolean).join("\n\n") },
  );

  // Wrap server.tool() so every tool call is tracked in PostHog
  // ⚠️  Must be called BEFORE registering any tools
  withAnalytics(server, clientId);

  for (const register of enabled(toolsets, STATIC_REGISTRARS).flat()) register(server);
  // The SDK docs proxy tools are dynamic (fetched from the docs MCP), so they're never seeded.
  if (toolsets.builder) await registerDocsProxyTools(server);

  return server;
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
  const recordingServer = { tool: () => ({}) } as unknown as McpServer;
  for (const register of enabled(toolsets, STATIC_REGISTRARS).flat()) register(recordingServer);
}
