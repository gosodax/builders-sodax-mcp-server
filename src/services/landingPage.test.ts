import { beforeAll, describe, expect, it } from "vitest";
import { seedToolRegistry } from "../server.js";
import { renderLandingPage } from "./landingPage.js";

// Its own file: the registry is per module, and toolRegistry.test.ts seeds the swap tools.
beforeAll(() => {
  seedToolRegistry({ builder: true, swap: false });
});

describe("Swaps card", () => {
  it("is hidden while the server has no swap tools (the rollout switch is off)", () => {
    const html = renderLandingPage("<details {{SWAP_CARD_HIDDEN}}>", { networks: null, sdkDocsToolCount: 0 });
    expect(html).toBe("<details hidden>");
  });
});
