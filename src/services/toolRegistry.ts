/**
 * Tool Registry — single source of truth for the tools this server exposes.
 *
 * Every static `server.tool()` registration in `src/tools/*.ts` is routed
 * through `registerAppTool()`, which records `{ name, module, description }`
 * exactly once. Everything that displays tool counts or lists — `/health`,
 * `/api`, the landing-page placeholder injection, and PostHog analytics
 * grouping — derives from this registry, so adding or removing a tool
 * updates them all with no manual count edits.
 *
 * Dynamic GitBook proxy tools (`docs_getPage`, …) are intentionally NOT in
 * the registry: they change at runtime and are counted via
 * `getGitBookToolNames()` where needed. Only the three docs_* meta-tools
 * are registered here (module "sdkDocs") so analytics can group them.
 */

import type { McpServer, ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

/** Landing-page / `/api` module a tool belongs to. */
export type ToolModule = "config" | "intents" | "relay" | "amm" | "moneyMarket" | "partnersAndToken" | "sdkDocs";

/** Modules whose tools count toward the "api" analytics group / static total. */
const API_MODULES: ToolModule[] = ["config", "intents", "amm", "moneyMarket", "partnersAndToken"];

export interface RegisteredToolInfo {
  name: string;
  module: ToolModule;
  description: string;
}

const registry: RegisteredToolInfo[] = [];

/**
 * Register a tool with the MCP server AND record it in the registry.
 * Signature mirrors the `server.tool(name, description, schema, annotations, cb)`
 * overload used everywhere in `src/tools/*.ts`, plus a leading `module`.
 *
 * Safe to call on every per-request McpServer instance — the registry
 * dedupes by tool name, the MCP registration happens each time.
 */
export function registerAppTool<Args extends ZodRawShapeCompat>(
  server: McpServer,
  module: ToolModule,
  name: string,
  description: string,
  paramsSchema: Args,
  annotations: ToolAnnotations,
  cb: ToolCallback<Args>,
): void {
  if (!registry.some(t => t.name === name)) {
    registry.push({ name, module, description });
  }
  server.tool(name, description, paramsSchema, annotations, cb);
}

/** Snapshot of every statically registered tool. */
export function getRegisteredTools(): readonly RegisteredToolInfo[] {
  return registry;
}

/** Registry lookup for analytics grouping; undefined for dynamic docs_* proxies. */
export function getToolModule(toolName: string): ToolModule | undefined {
  return registry.find(t => t.name === toolName)?.module;
}

/**
 * Tool names grouped by module, in registration order — feeds the `/api`
 * route. `sdkDocs` is excluded (the caller appends the live GitBook list).
 */
export function getToolNamesByModule(): Record<Exclude<ToolModule, "sdkDocs">, string[]> {
  const groups: Record<Exclude<ToolModule, "sdkDocs">, string[]> = {
    config: [],
    intents: [],
    relay: [],
    amm: [],
    moneyMarket: [],
    partnersAndToken: [],
  };
  for (const tool of registry) {
    if (tool.module === "sdkDocs") continue;
    groups[tool.module].push(tool.name);
  }
  return groups;
}

/** Per-module counts for the landing-page badges (sdkDocs counted at runtime). */
export function getToolCountsByModule(): Record<Exclude<ToolModule, "sdkDocs">, number> {
  const groups = getToolNamesByModule();
  return {
    config: groups.config.length,
    intents: groups.intents.length,
    relay: groups.relay.length,
    amm: groups.amm.length,
    moneyMarket: groups.moneyMarket.length,
    partnersAndToken: groups.partnersAndToken.length,
  };
}

/**
 * Static per-group counts for `/health`, same shape as the old
 * `STATIC_TOOL_COUNTS`: `api` spans the SODAX API modules, `relay` the
 * intent-relay tools. docs_* meta-tools are excluded — the sdkDocs total
 * is counted at runtime from the live GitBook tool list.
 */
export function getStaticToolCounts(): { api: number; relay: number } {
  let api = 0;
  let relay = 0;
  for (const tool of registry) {
    if (tool.module === "relay") relay++;
    else if (API_MODULES.includes(tool.module)) api++;
  }
  return { api, relay };
}
