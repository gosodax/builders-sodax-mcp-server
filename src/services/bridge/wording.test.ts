import { describe, expect, it } from "vitest";
import { ActionError } from "../swap/errors.js";
import { forBridge } from "./wording.js";

describe("forBridge", () => {
  it("names the bridge tools and a bridge where the shared text names the swap's", () => {
    const shared = new ActionError("UNKNOWN_TOKEN", "Swaps of that token aren't supported.", {
      nextStep:
        "Call sodax_swap_prepare again with the address, or pass a tx hash to sodax_swap_submit_and_track; the swap waits.",
      details: { field: "fromToken" },
    });
    const worded = forBridge(shared);
    expect(worded.message).toBe("Bridges of that token aren't supported.");
    expect(worded.nextStep).toBe(
      "Call sodax_bridge_prepare again with the address, or pass a tx hash to sodax_bridge_submit_and_track; the bridge waits.",
    );
    expect(worded).toMatchObject({ code: "UNKNOWN_TOKEN", details: { field: "fromToken" } });
  });

  it("has a token looked up in the bridge's list", () => {
    const shared = new ActionError("UNKNOWN_TOKEN", "No.", { nextStep: "sodax_resolve_token lists candidates." });
    expect(forBridge(shared).nextStep).toBe("sodax_resolve_token with for: bridge lists candidates.");
    expect(forBridge(forBridge(shared)).nextStep).toBe("sodax_resolve_token with for: bridge lists candidates.");
  });

  it("leaves other tool names whole", () => {
    const worded = forBridge(new ActionError("UNKNOWN_TOKEN", "No.", { nextStep: "Call sodax_get_swap_tokens." }));
    expect(worded.nextStep).toBe("Call sodax_get_swap_tokens.");
  });
});
