/**
 * Tool Registry — single source of truth for the tools this server exposes.
 *
 * Every static tool registration in `src/tools/*.ts` (`server.tool()`, or `registerTool()` with an output schema) is routed
 * through `registerAppTool()`, which records `{ name, module, description }`
 * exactly once. Everything that displays tool counts or lists — `/health`,
 * `/api`, the landing-page placeholder injection, and PostHog analytics
 * grouping — derives from this registry, so adding or removing a tool
 * updates them all with no manual count edits.
 *
 * Dynamic SDK docs proxy tools (`docs_search_sodax_docs`, …) are intentionally NOT in
 * the registry: they change at runtime and are counted via
 * `getDocsToolNames()` where needed. Only the three docs_* meta-tools
 * are registered here (module "sdkDocs") so analytics can group them.
 */

import type { McpServer, ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AnySchema, ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

/** Landing-page / `/api` module a tool belongs to. */
export type ToolModule =
  | "config"
  | "intents"
  | "relay"
  | "amm"
  | "moneyMarket"
  | "partnersAndToken"
  | "sdkDocs"
  | "swap"
  | "bridge";

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
 *
 * A tool with an `outputSchema` registers through `registerTool()`, the only overload that takes one: the SDK then
 * checks every result that isn't an error against it, and a client that listed the tools checks errors too.
 */
export function registerAppTool<Args extends ZodRawShapeCompat>(
  server: McpServer,
  module: ToolModule,
  name: string,
  description: string,
  paramsSchema: Args,
  annotations: ToolAnnotations,
  cb: ToolCallback<Args>,
  outputSchema?: AnySchema,
): void {
  if (!registry.some(t => t.name === name)) {
    registry.push({ name, module, description });
  }
  if (outputSchema) {
    server.registerTool(name, { description, inputSchema: paramsSchema, outputSchema, annotations }, cb);
  } else {
    server.tool(name, description, paramsSchema, annotations, cb);
  }
}

/** Snapshot of every statically registered tool — entries are cloned, so
 * callers can't mutate the singleton registry (safe to iterate/sort). */
export function getRegisteredTools(): readonly RegisteredToolInfo[] {
  return registry.map(t => ({ ...t }));
}

/** Registry lookup for analytics grouping; undefined for dynamic docs_* proxies. */
export function getToolModule(toolName: string): ToolModule | undefined {
  return registry.find(t => t.name === toolName)?.module;
}

/**
 * Tool names grouped by module, in registration order — feeds the `/api`
 * route. `sdkDocs` is excluded (the caller appends the live SDK docs list).
 */
export function getToolNamesByModule(): Record<Exclude<ToolModule, "sdkDocs">, string[]> {
  const groups: Record<Exclude<ToolModule, "sdkDocs">, string[]> = {
    config: [],
    intents: [],
    relay: [],
    amm: [],
    moneyMarket: [],
    partnersAndToken: [],
    swap: [],
    bridge: [],
  };
  for (const tool of registry) {
    if (tool.module === "sdkDocs") continue;
    groups[tool.module].push(tool.name);
  }
  return groups;
}

/** Per-module counts for the landing-page badges (sdkDocs counted at runtime).
 * Counts in a single pass rather than materializing name arrays just to read
 * their length. */
export function getToolCountsByModule(): Record<Exclude<ToolModule, "sdkDocs">, number> {
  const counts: Record<Exclude<ToolModule, "sdkDocs">, number> = {
    config: 0,
    intents: 0,
    relay: 0,
    amm: 0,
    moneyMarket: 0,
    partnersAndToken: 0,
    swap: 0,
    bridge: 0,
  };
  for (const tool of registry) {
    if (tool.module === "sdkDocs") continue;
    counts[tool.module]++;
  }
  return counts;
}

/**
 * The group a module reports under, in `/health` and in analytics: `relay`,
 * `swap`, `bridge` and `sdkDocs` stand alone; every other module is `api`. Deriving `api`
 * as "everything else" means a newly added module is counted automatically
 * rather than silently dropped by an allowlist.
 */
export function toolGroup(module: ToolModule): "api" | "relay" | "swap" | "bridge" | "sdkDocs" {
  return module === "relay" || module === "swap" || module === "bridge" || module === "sdkDocs" ? module : "api";
}

/**
 * Static per-group counts for `/health` and the landing page. docs_* meta-tools
 * (module "sdkDocs") are excluded — the sdkDocs total is counted at runtime from
 * the live SDK docs tool list, so callers add it to `total`.
 */
export function getStaticToolCounts(): { api: number; relay: number; swap: number; bridge: number; total: number } {
  const counts = { api: 0, relay: 0, swap: 0, bridge: 0 };
  for (const tool of registry) {
    const group = toolGroup(tool.module);
    if (group !== "sdkDocs") counts[group]++;
  }
  return { ...counts, total: counts.api + counts.relay + counts.swap + counts.bridge };
}
