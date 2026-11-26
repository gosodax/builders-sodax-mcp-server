import { afterEach, describe, expect, it, vi } from "vitest";
import { runWithRequestContext } from "../requestContext.js";
import { ActionError } from "../swap/errors.js";
import { checkBridgeRoom, claimBridge, getBridge, openBridges, putBridge } from "./store.js";

const entry = {
  request: {
    srcChainKey: "0xa4b1.arbitrum",
    srcAddress: `0x${"1".repeat(40)}`,
    srcToken: `0x${"2".repeat(40)}`,
    amount: 1n,
    dstChainKey: "0x2105.base",
    dstToken: `0x${"3".repeat(40)}`,
    recipient: `0x${"1".repeat(40)}`,
  },
  relayData: { address: `0x${"4".repeat(40)}`, payload: "0x" },
  delivered: 1n,
};
const asKey = <T>(apiKey: string, fn: () => T) => runWithRequestContext({ apiKey }, fn);

afterEach(() => {
  vi.useRealTimers();
});

describe("prepared bridges", () => {
  it("refuses a key at its cap of builds not yet sent, before anything is built, and frees one once sent", () => {
    vi.useFakeTimers();
    const kept = asKey("full", () => Array.from({ length: 1_000 }, () => putBridge(entry)));
    const refused = (() => {
      try {
        asKey("full", () => checkBridgeRoom());
      } catch (error) {
        return error;
      }
    })();
    expect(refused).toBeInstanceOf(ActionError);
    expect((refused as ActionError).code).toBe("RATE_LIMITED");
    // Room comes back when the oldest open build goes, 40 minutes after it was kept, not when it can't be signed.
    expect((refused as ActionError).details?.retryAfterSec).toBe(40 * 60);
    // Another key still has room.
    expect(() => asKey("other", () => checkBridgeRoom())).not.toThrow();
    expect(claimBridge(kept[0]?.bridgeId as string, `0x${"a".repeat(64)}`)).toBe("claimed");
    expect(() => asKey("full", () => checkBridgeRoom())).not.toThrow();
    expect(openBridges()).toBe(999);
  });

  it("drops a build once it expires, and its room with it", () => {
    vi.useFakeTimers();
    const before = openBridges();
    const { bridgeId } = asKey("expiring", () => putBridge(entry));
    expect(openBridges()).toBe(before + 1);
    vi.advanceTimersByTime(40 * 60 * 1000);
    expect(getBridge(bridgeId)).toBeUndefined();
    expect(openBridges()).toBe(0);
  });
});
