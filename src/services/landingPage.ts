/**
 * Landing-page server-side rendering.
 *
 * `src/public/index.html` ships with `{{PLACEHOLDER}}` tokens for every
 * number that used to be hardcoded (network count, tool counts). This module
 * substitutes live values derived from the tool registry and runtime state,
 * so the page — including the SEO surfaces crawlers read without running JS
 * (meta description, og:/twitter: tags, JSON-LD) — can never drift from what
 * the server actually exposes. The `.js-network-count` client-side refresh
 * in the page remains as a graceful fallback.
 */

import { getStaticToolCounts, getToolCountsByModule } from "./toolRegistry.js";

export interface LandingPageData {
  /** Live integrated-networks count, or null when the backend fetch failed. */
  networks: number | null;
  /** Runtime count of docs_* tools (GitBook proxies + meta-tools). */
  sdkDocsToolCount: number;
}

/** Evergreen floor used when the live network count is unavailable. */
const NETWORK_COUNT_FALLBACK = "19+";

/** "19+"-style string from the live count, or the evergreen floor when it's
 * unavailable (null) or zero — a "0+" surface would be worse than the floor. */
export function formatNetworkCount(networks: number | null): string {
  return networks !== null && networks > 0 ? `${networks}+` : NETWORK_COUNT_FALLBACK;
}

/** Substitute every {{PLACEHOLDER}} in the landing-page template. */
export function renderLandingPage(template: string, data: LandingPageData): string {
  const moduleCounts = getToolCountsByModule();
  const staticCounts = getStaticToolCounts();
  const totalTools = staticCounts.api + staticCounts.relay + data.sdkDocsToolCount;

  const values: Record<string, string> = {
    NETWORK_COUNT: formatNetworkCount(data.networks),
    TOTAL_TOOLS: String(totalTools),
    CONFIG_TOOLS: String(moduleCounts.config),
    INTENTS_TOOLS: String(moduleCounts.intents),
    RELAY_TOOLS: String(moduleCounts.relay),
    AMM_TOOLS: String(moduleCounts.amm),
    MONEY_MARKET_TOOLS: String(moduleCounts.moneyMarket),
    PARTNERS_TOOLS: String(moduleCounts.partnersAndToken),
    SDK_DOCS_TOOLS: String(data.sdkDocsToolCount),
  };

  return template.replace(/\{\{([A-Z_]+)\}\}/g, (match, key: string) => values[key] ?? match);
}
