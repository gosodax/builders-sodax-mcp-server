#!/usr/bin/env node
/**
 * CLI entrypoint for the SDK docs proxy liveness check.
 *
 * Exit codes:
 *   0 — the docs MCP is reachable and exposes at least one proxied tool
 *   2 — the docs MCP returned NO tools (unreachable, moved, or empty)
 *
 * Rationale: docs.sodax.com silently migrated GitBook → Mintlify and the proxy
 * pointed at the retired endpoint for an unknown period, registering zero docs
 * tools while `/health` still read "healthy". This gate makes the next such
 * move fail loudly. Wire into CI / pre-deploy via `pnpm check:docs`.
 */

import { fetchDocsTools } from "../services/docsProxy.js";

const tools = await fetchDocsTools({ force: true });

if (tools.length === 0) {
  console.error("");
  console.error("❌ SDK docs proxy returned 0 tools — this is a failure, not a pass.");
  console.error("   The docs MCP (https://docs.sodax.com/mcp) is unreachable, moved, or empty,");
  console.error("   so NO docs_* documentation tools would register. Conceptual 'is X supported?'");
  console.error("   questions would fall back to stale model priors.");
  console.error("   Next steps: verify https://docs.sodax.com/mcp responds to tools/list, and check");
  console.error("   the allowlist in src/services/docsProxy.ts still matches the upstream tool names.");
  console.error("");
  process.exit(2);
}

console.error(`✅ SDK docs proxy healthy — ${tools.length} tool(s): ${tools.map(t => t.name).join(", ")}`);
process.exit(0);
