/**
 * Test helpers around the recorded catalog sources: live `/v1/swaps/tokens` and chain
 * config on 2026-10-26, trimmed to seven chains, plus one bad token entry. Not built.
 */

import { readFileSync } from "node:fs";
import { type SwapCatalog, parseCatalog } from "../tokens.js";

export function fixtureText(name: "swap-tokens.json" | "chain-configs.json"): string {
  return readFileSync(new URL(`./${name}`, import.meta.url), "utf8");
}

export function fixtureCatalog(): SwapCatalog {
  return parseCatalog(JSON.parse(fixtureText("swap-tokens.json")), JSON.parse(fixtureText("chain-configs.json")));
}

/** A `fetch` serving the two catalog sources; `tokens` and `configs` replace the recorded ones. */
export function catalogFetch(
  tokens = fixtureText("swap-tokens.json"),
  configs = fixtureText("chain-configs.json"),
): typeof fetch {
  return async input => {
    const url = String(input);
    if (url.endsWith("/v1/swaps/tokens")) return new Response(tokens);
    if (url.endsWith("/v1/be/config/spoke/all-chains-configs")) return new Response(configs);
    throw new Error(`unexpected fetch ${url}`);
  };
}
