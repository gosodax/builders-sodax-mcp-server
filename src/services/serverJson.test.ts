/**
 * Guardrails for server.json, the manifest published to the MCP Registry
 * (registry.modelcontextprotocol.io). Directories that mirror the registry show
 * its tool list and version, so both must match what this server actually ships.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { beforeAll, describe, expect, it } from "vitest";
import { DOCS_META_TOOL_NAMES } from "../tools/docsProxy.js";
import { registerSodaxApiTools } from "../tools/sodaxApi.js";
import { registerSolverRelayTools } from "../tools/solverRelay.js";
import { getRegisteredTools } from "./toolRegistry.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const readJson = (file: string) => JSON.parse(readFileSync(join(ROOT, file), "utf8"));

const serverJson = readJson("server.json") as { version: string; tools: { name: string; description: string }[] };

/** Minimal stand-in — registerAppTool only needs server.tool() to exist. */
const fakeServer = { tool: () => ({}) } as unknown as McpServer;

beforeAll(() => {
  registerSodaxApiTools(fakeServer);
  registerSolverRelayTools(fakeServer);
});

describe("server.json", () => {
  it("lists exactly the static tools plus the docs_* meta-tools", () => {
    const expected = [...getRegisteredTools().map(t => t.name), ...DOCS_META_TOOL_NAMES].sort();
    const listed = serverJson.tools.map(t => t.name).sort();
    expect(listed).toEqual(expected);
  });

  it("gives every tool a description", () => {
    for (const tool of serverJson.tools) {
      expect(tool.description.trim(), `${tool.name} has no description`).not.toBe("");
    }
  });

  it("carries the package.json version (release-please bumps both)", () => {
    expect(serverJson.version).toBe(readJson("package.json").version);
  });
});
