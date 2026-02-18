# Copilot Instructions

## PostHog Analytics — Keep in Sync

Whenever MCP tools or data sources are added, removed, or renamed, **always update the PostHog analytics setup** to match:

1. **`src/services/analytics.ts`** — Update the `TOOL_GROUPS` map so every tool name maps to its logical group. Remove entries for deleted tools. Add entries for new tools. Dynamic `docs_*` tools are handled by the prefix fallback, but static meta-tools (`docs_health`, `docs_refresh`, `docs_list_tools`) must be listed explicitly.
2. **`src/index.ts` → `createServer()`** — Ensure any new `registerXxxTools(server)` call is placed **after** `withAnalytics(server)` so the monkey-patched `server.tool()` captures the new tools.

If a tool is registered but missing from `TOOL_GROUPS`, it will still be tracked but its `tool_group` property will be `"unknown"`, making PostHog filtering unreliable. Treat a missing mapping as a bug.
