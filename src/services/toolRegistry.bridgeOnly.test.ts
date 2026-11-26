import { describe, expect, it } from "vitest";
import { seedToolRegistry } from "../server.js";
import { getStaticToolCounts } from "./toolRegistry.js";

describe("a server with only the bridge tools on", () => {
  it("counts the token lookup and balance tools as the bridge's, and no swap tool", () => {
    seedToolRegistry({ builder: false, swap: false, bridge: true });
    expect(getStaticToolCounts()).toMatchObject({ swap: 0, bridge: 6 });
  });
});
