/**
 * The bridge catalog against bridge-api's own list, live: `pnpm test:contract`. They're built from the same SDK
 * config the same way, so any difference means the two run different SDK versions, or bridge-api changed its filter:
 * a token one lists and the other doesn't either can't be built here or is refused there.
 */

import { describe, expect, it } from "vitest";
import { SODAX_BRIDGE_BASE_URL } from "../../constants.js";
import { fetchJson } from "../http.js";
import { getBridgeCatalog } from "./catalog.js";

const keys = (tokens: Record<string, readonly { address: string }[]>) =>
  Object.entries(tokens)
    .flatMap(([chainKey, list]) => list.map(token => `${chainKey} ${token.address.toLowerCase()}`))
    .sort();

describe("bridge catalog against /v1/bridge/tokens", () => {
  it("lists exactly the tokens bridge-api lists", async () => {
    const live = await fetchJson<Record<string, { address: string }[]>>(`${SODAX_BRIDGE_BASE_URL}/tokens`);
    expect(keys(getBridgeCatalog().tokens)).toEqual(keys(live));
  });
});
