import { afterEach, describe, expect, it, vi } from "vitest";
import { runWithRequestContext } from "../requestContext.js";
import { holdForTrack } from "../signWindow.js";
import { ActionError } from "../swap/errors.js";
import {
  type PreparedBridge,
  checkBridgeRoom,
  claimBridge,
  getBridge,
  markHandedOver,
  openBridges,
  putBridge,
} from "./store.js";

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
const asClient = <T>(clientId: string, apiKey: string, fn: () => T) => runWithRequestContext({ apiKey, clientId }, fn);
const refusal = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return error as ActionError;
  }
  throw new Error("not refused");
};

afterEach(() => {
  // The store is the module's: leave it empty for the next test, claimed builds too.
  vi.advanceTimersByTime(25 * 60 * 60 * 1000);
  expect(openBridges().open).toBe(0);
  vi.useRealTimers();
});

describe("prepared bridges", () => {
  it("tells a deploy how many builds a restart would strand, and until when", () => {
    vi.useFakeTimers();
    const kept = asKey("deploy", () => putBridge(entry));
    expect(openBridges()).toEqual({ open: 1, openUntil: new Date(kept.expiresAt).toISOString() });
    claimBridge(kept.bridgeId, `0x${"a".repeat(64)}`);
    // Submitted: the backend has it, and a restart no longer strands it.
    markHandedOver(kept, "submitted");
    expect(openBridges()).toEqual({ open: 0, openUntil: null });
  });

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
    // Room comes back when the oldest one, never sent nor tracked, passes its 5-minute sign-by.
    expect((refused as ActionError).details?.retryAfterSec).toBe(5 * 60);
    // Another key still has room.
    expect(() => asKey("other", () => checkBridgeRoom())).not.toThrow();
    expect(claimBridge(kept[0]?.bridgeId as string, `0x${"a".repeat(64)}`)).toBe("claimed");
    expect(() => asKey("full", () => checkBridgeRoom())).not.toThrow();
    // Sent but not yet handed over, it still counts as one a restart would strand.
    expect(openBridges().open).toBe(1_000);
    markHandedOver(kept[0] as PreparedBridge, "row");
    expect(openBridges().open).toBe(999);
  });

  it("refuses a client at its cap of open builds whatever keys it sends, and no other client", () => {
    vi.useFakeTimers();
    for (let i = 0; i < 100; i++) asClient("busy", `sodax_key${i}`, () => putBridge(entry));
    const refused = refusal(() => asClient("busy", "sodax_fresh", () => checkBridgeRoom()));
    expect(refused).toMatchObject({ code: "RATE_LIMITED", message: "This client has too many open bridges." });
    expect(() => asClient("other", "sodax_fresh", () => checkBridgeRoom())).not.toThrow();
    // Over stdio there's no client to count.
    expect(() => asKey("sodax_fresh", () => checkBridgeRoom())).not.toThrow();
    vi.advanceTimersByTime(40 * 60 * 1000);
    expect(() => asClient("busy", "sodax_fresh", () => checkBridgeRoom())).not.toThrow();
  });

  it("makes room when full by dropping the oldest unsent build past its sign window, never a sent one", () => {
    vi.useFakeTimers();
    const kept = Array.from({ length: 10_000 }, (_, i) =>
      asClient(`c${i}`, `sodax_k${i % 20}`, () => putBridge(entry)),
    );
    const [sent, unsent] = kept;
    if (!sent || !unsent) throw new Error("none kept");
    claimBridge(sent.bridgeId, `0x${"a".repeat(64)}`);
    // A sent build is kept apart from the unsent ones it no longer counts among: one more fills them.
    asClient("c-extra", "sodax_k0", () => putBridge(entry));
    // Every build still signable: nothing gives way.
    const full = refusal(() => asClient("late", "sodax_late", () => checkBridgeRoom()));
    expect(full).toMatchObject({ message: "This server holds too many open bridges right now." });
    vi.advanceTimersByTime(11 * 60 * 1000);
    asClient("late", "sodax_late", () => putBridge(entry));
    expect(getBridge(sent.bridgeId)).toBeDefined();
    expect(getBridge(unsent.bridgeId)).toBeUndefined();
  });

  it("gives a capped key's room to its oldest unheld build past its sign-by, a held one once its hold ends", () => {
    vi.useFakeTimers();
    const [tracked, untracked, next] = asKey("busy", () => Array.from({ length: 1_000 }, () => putBridge(entry)));
    if (!tracked || !untracked || !next) throw new Error("none kept");
    vi.advanceTimersByTime(4 * 60 * 1000);
    holdForTrack(tracked);
    vi.advanceTimersByTime(60 * 1000);
    const fresh = asKey("busy", () => putBridge(entry));
    expect(getBridge(fresh.bridgeId)).toBeDefined();
    expect(getBridge(untracked.bridgeId)).toBeUndefined();
    expect(getBridge(tracked.bridgeId)).toBeDefined();
    // A track call holds it 5 minutes, not for good: once the hold ends, it gives way as an unsent one.
    vi.advanceTimersByTime(4 * 60 * 1000);
    asKey("busy", () => putBridge(entry));
    expect(getBridge(tracked.bridgeId)).toBeUndefined();
    expect(getBridge(next.bridgeId)).toBeDefined();
  });

  it("keeps a build a day once its deposit is checked, counting it open until the deposit is handed over", () => {
    vi.useFakeTimers();
    const before = openBridges().open;
    const build = asKey("claiming", () => putBridge(entry));
    expect(claimBridge(build.bridgeId, `0x${"a".repeat(64)}`)).toBe("claimed");
    // Sent, not yet submitted: a restart would strand it.
    expect(openBridges().open).toBe(before + 1);
    vi.advanceTimersByTime(23 * 60 * 60 * 1000);
    expect(getBridge(build.bridgeId)?.depositTxHash).toBe(`0x${"a".repeat(64)}`);
    markHandedOver(build, "row");
    expect(openBridges().open).toBe(before);
    vi.advanceTimersByTime(2 * 60 * 60 * 1000);
    expect(getBridge(build.bridgeId)).toBeUndefined();
  });

  it("gives a full store of checked deposits the oldest one handed over, and keeps one not handed over past it", () => {
    vi.useFakeTimers();
    let deposits = 0;
    const claimedOne = () => {
      const build = asKey("busy", () => putBridge(entry));
      claimBridge(build.bridgeId, `0x${(deposits++).toString(16).padStart(64, "0")}`);
      return build;
    };
    const [first, second, third] = Array.from({ length: 10_000 }, claimedOne);
    if (!first || !second || !third) throw new Error("none kept");
    // None handed over: only its build submits a deposit, so each stays, past the cap.
    const over = claimedOne();
    expect(openBridges().open).toBe(10_001);
    markHandedOver(second, "row");
    const last = claimedOne();
    expect(getBridge(second.bridgeId)).toBeUndefined();
    for (const kept of [first, third, over, last]) expect(getBridge(kept.bridgeId)).toBeDefined();
  });

  it("drops a build once it expires, and its room with it", () => {
    vi.useFakeTimers();
    const before = openBridges().open;
    const { bridgeId } = asKey("expiring", () => putBridge(entry));
    expect(openBridges().open).toBe(before + 1);
    vi.advanceTimersByTime(40 * 60 * 1000);
    expect(getBridge(bridgeId)).toBeUndefined();
    expect(openBridges().open).toBe(0);
  });
});
