/**
 * Guardrails for the tool registry and the landing-page placeholder system.
 *
 * These tests fail when someone reintroduces a hand-maintained count that can
 * drift from what the server actually registers — the same spirit as the
 * apiDriftCheck, pointed inward.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { beforeAll, describe, expect, it } from "vitest";
import { registerSodaxApiTools } from "../tools/sodaxApi.js";
import { registerSolverRelayTools } from "../tools/solverRelay.js";
import { TOOL_CONTRACT } from "./apiDriftCheck.js";
import { renderLandingPage } from "./landingPage.js";
import {
  getRegisteredTools,
  getStaticToolCounts,
  getToolCountsByModule,
  getToolNamesByModule,
} from "./toolRegistry.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_HTML_PATH = join(__dirname, "..", "public", "index.html");

/** Minimal stand-in — registerAppTool only needs server.tool() to exist. */
const fakeServer = { tool: () => ({}) } as unknown as McpServer;

beforeAll(() => {
  // Populate the registry the same way createServer() does (minus the
  // network-dependent GitBook proxy — its tools are dynamic by design).
  registerSodaxApiTools(fakeServer);
  registerSolverRelayTools(fakeServer);
});

describe("tool registry", () => {
  it("registers every tool exactly once", () => {
    const names = getRegisteredTools().map(t => t.name);
    expect(names.length).toBeGreaterThan(0);
    expect(new Set(names).size).toBe(names.length);
  });

  it("has at least one tool in every static module", () => {
    const counts = getToolCountsByModule();
    for (const [module, count] of Object.entries(counts)) {
      expect(count, `module "${module}" has no tools`).toBeGreaterThan(0);
    }
  });

  it("static api/relay counts add up to the grouped /api lists", () => {
    const { api, relay } = getStaticToolCounts();
    const groups = getToolNamesByModule();
    expect(relay).toBe(groups.relay.length);
    expect(api).toBe(
      groups.config.length +
        groups.intents.length +
        groups.amm.length +
        groups.moneyMarket.length +
        groups.partnersAndToken.length,
    );
  });

  it("covers every tool the API drift-check contract claims exists", () => {
    const registered = new Set(getRegisteredTools().map(t => t.name));
    for (const contract of Object.values(TOOL_CONTRACT)) {
      expect(registered.has(contract.tool), `contract tool "${contract.tool}" is not registered`).toBe(true);
    }
  });
});

describe("landing page template", () => {
  const template = readFileSync(INDEX_HTML_PATH, "utf-8");

  it("contains no hardcoded tool/network counts (placeholders only)", () => {
    // e.g. "39 tools", "19+ networks", "8 tools" — these drift as tools are
    // added; every displayed number must come from a {{PLACEHOLDER}}.
    const literalCount = /\d+\+?\s+(tools|networks)\b/i.exec(template);
    expect(literalCount, `hardcoded count "${literalCount?.[0]}" found in index.html`).toBeNull();
  });

  it("contains the expected placeholders", () => {
    for (const key of [
      "NETWORK_COUNT",
      "TOTAL_TOOLS",
      "CONFIG_TOOLS",
      "INTENTS_TOOLS",
      "RELAY_TOOLS",
      "AMM_TOOLS",
      "MONEY_MARKET_TOOLS",
      "PARTNERS_TOOLS",
      "SDK_DOCS_TOOLS",
    ]) {
      expect(template, `missing {{${key}}} in index.html`).toContain(`{{${key}}}`);
    }
  });

  it("renders with every placeholder substituted", () => {
    const html = renderLandingPage(template, { networks: 24, sdkDocsToolCount: 5 });
    expect(html).not.toMatch(/\{\{[A-Z_]+\}\}/);
    expect(html).toContain("24+");
  });

  it("falls back to the evergreen network floor when the live count is unavailable", () => {
    const html = renderLandingPage(template, { networks: null, sdkDocsToolCount: 3 });
    expect(html).toContain("19+");
    expect(html).not.toMatch(/\{\{[A-Z_]+\}\}/);
  });

  it("derives the total tool count from the registry plus the live docs count", () => {
    const { api, relay } = getStaticToolCounts();
    const html = renderLandingPage("{{TOTAL_TOOLS}}", { networks: null, sdkDocsToolCount: 5 });
    expect(html).toBe(String(api + relay + 5));
  });
});
