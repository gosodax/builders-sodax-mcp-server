/**
 * McpServer composition: the server identity, its instructions and the tools
 * it registers. Transports live in index.ts.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withAnalytics } from "./services/analytics.js";
import type { Toolsets } from "./services/profiles.js";
import { registerDocsProxyTools } from "./tools/docsProxy.js";
import { registerSodaxApiTools } from "./tools/sodaxApi.js";
import { registerSolverRelayTools } from "./tools/solverRelay.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const { version: SERVER_VERSION } = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8")) as {
  version: string;
};

// Server-level instructions sent on `initialize`. They steer clients to answer
// support questions ("does SODAX support chain/token X?") from the live tools
// rather than the model's training priors, which predate newer chains such as
// Hedera, Robinhood and Stacks and otherwise produce confidently wrong "no"s.
const SERVER_INSTRUCTIONS = [
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

/**
 * Creates a McpServer with the given toolsets.
 * Used per-request in HTTP mode to avoid transport conflicts
 * when handling parallel requests.
 */
export async function createServer(toolsets: Toolsets, clientId?: string): Promise<McpServer> {
  const server = new McpServer(
    {
      name: "builders-sodax-mcp-server",
      version: SERVER_VERSION,
    },
    { instructions: SERVER_INSTRUCTIONS },
  );

  // Wrap server.tool() so every tool call is tracked in PostHog
  // ⚠️  Must be called BEFORE registering any tools
  withAnalytics(server, clientId);

  if (toolsets.builder) {
    registerSodaxApiTools(server);
    registerSolverRelayTools(server);
    await registerDocsProxyTools(server);
  }
  // Swap tools, once they exist, register here under `toolsets.swap`.

  return server;
}
