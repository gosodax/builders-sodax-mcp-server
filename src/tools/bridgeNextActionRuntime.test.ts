import { describe, expect, it } from "vitest";
import {
  ARBITRUM,
  BRIDGE_ID,
  HUB_TX,
  NON_EVM_READY,
  NOW,
  PAIR_ARGS,
  READY,
  TX,
  type TrackState,
  USER,
  failure,
  listed,
  prepared,
  previewed,
  ref,
  tracked,
} from "./__fixtures__/bridgeResults.js";
import { type Script, harness as sharedHarness } from "./__fixtures__/nextActionHarness.js";
import { type Saved, run } from "./__fixtures__/nextActionRuntime.js";

const TOKENS = "sodax_bridge_tokens";
const PREVIEW = "sodax_bridge_preview";
const PREPARE = "sodax_bridge_prepare";
const TRACK = "sodax_bridge_submit_and_track";
const START = { tool: TOKENS, args: { fromChain: ARBITRUM.key, toChain: READY.to.chain.key } };
const TRACK_ARGS = { bridgeId: BRIDGE_ID, chain: ARBITRUM.key, txHash: TX };
const DELIVERED: TrackState = { status: "delivered", delivery: "delivered", dstTxHash: HUB_TX };
const WRONG_HASH: TrackState = { status: "not_submitted", reason: "not_this_bridge", alerted: false };
const harness = (script: Script) => sharedHarness(script, NOW, TX);

describe("the bridge nextAction runtime", () => {
  it("chooses a pair and amount, previews, prepares, confirms, sends and tracks without reading nextStep", async () => {
    const stages: TrackState[] = [
      { status: "awaiting_source", seenOnChain: true },
      { status: "relaying" },
      { status: "in_transit", hubTxHash: HUB_TX },
      DELIVERED,
    ];
    const bridge = harness({
      respond: (tool, _, nth) => {
        switch (tool) {
          case TOKENS:
            return listed();
          case PREVIEW:
            return previewed();
          case PREPARE:
            return prepared();
          case TRACK:
            return tracked(stages[nth - 1]);
          default:
            throw new Error(`unexpected tool ${tool}`);
        }
      },
      answers: {
        choose: action => action.options[0].args,
        provide: action => (action.fields[0].name === "amount" ? { amount: "5" } : { fromAddress: USER }),
        confirm: action => {
          expect(action.summary).toMatchObject({ kind: "bridge", bridgeId: BRIDGE_ID, recipient: USER });
          return true;
        },
      },
      wallet: (action, result) => {
        expect(action).toMatchObject({ chain: ARBITRUM.key, stepsAt: "steps", waitFor: "receipt_success" });
        expect(result.steps).toEqual(READY.steps);
        return { hash: TX };
      },
    });
    expect(await run(bridge.host, START)).toMatchObject({ stop: "terminal", outcome: "succeeded" });
    expect(bridge.asked).toEqual(["choose", "provide", "provide", "confirm"]);
    expect(bridge.of(PREVIEW)).toEqual([{ tool: PREVIEW, args: { ...PAIR_ARGS, amount: "5" } }]);
    expect(bridge.of(PREPARE)).toEqual([{ tool: PREPARE, args: { ...PAIR_ARGS, amount: "5", fromAddress: USER } }]);
    expect(bridge.of(TRACK).map(call => call.args)).toEqual(Array(4).fill(TRACK_ARGS));
    expect(bridge.sends()).toBe(1);
  });

  it.each(["choose", "provide", "confirm"] as const)("sends nothing when the user declines %s", async declined => {
    const bridge = harness({
      respond: tool => (tool === TOKENS ? listed() : tool === PREVIEW ? previewed() : prepared()),
      answers: {
        choose: action => (declined === "choose" ? undefined : action.options[0].args),
        provide: action =>
          declined === "provide"
            ? undefined
            : action.fields[0].name === "amount"
              ? { amount: "5" }
              : { fromAddress: USER },
        confirm: () => declined !== "confirm",
      },
    });
    expect(await run(bridge.host, START)).toMatchObject({ stop: "declined" });
    expect(bridge.sends()).toBe(0);
    expect(bridge.of(TRACK)).toEqual([]);
  });

  it("resumes after broadcast without preparing, confirming or sending another bridge", async () => {
    const saved: Saved = {};
    const first = harness({
      saved,
      respond: tool => {
        if (tool === TRACK) throw new Error("session dropped");
        return prepared();
      },
      answers: { confirm: () => true },
    });
    await expect(run(first.host, { tool: PREPARE, args: PAIR_ARGS })).rejects.toThrow("session dropped");
    const second = harness({ saved, respond: () => tracked(DELIVERED) });
    expect(await run(second.host, START)).toMatchObject({ stop: "terminal", outcome: "succeeded" });
    expect(second.calls).toEqual([{ tool: TRACK, args: TRACK_ARGS }]);
    expect(second.asked).toEqual([]);
    expect(first.sends() + second.sends()).toBe(1);
  });

  it("holds a sent batch without a hash, then resumes through wallet status without resending", async () => {
    const saved: Saved = {};
    const first = harness({
      saved,
      respond: () => prepared(),
      answers: { confirm: () => true },
      wallet: action => {
        expect(action.batchAt).toBe("batch");
        return { batchId: "bridge-batch" };
      },
    });
    expect(await run(first.host, { tool: PREPARE, args: PAIR_ARGS })).toMatchObject({ stop: "handoff" });
    const second = harness({
      saved,
      respond: () => {
        throw new Error("must wait for the wallet");
      },
    });
    expect(await run(second.host, START)).toMatchObject({ stop: "handoff" });
    expect(second.calls).toEqual([]);
    const third = harness({
      saved,
      batch: id => (id === "bridge-batch" ? TX : undefined),
      respond: () => tracked(DELIVERED),
    });
    expect(await run(third.host, START)).toMatchObject({ outcome: "succeeded" });
    expect(third.calls).toEqual([{ tool: TRACK, args: TRACK_ARGS }]);
    expect(first.sends() + second.sends() + third.sends()).toBe(1);
  });

  it("saves a corrected bridge hash before a failed call, including when no execute ran in this session", async () => {
    const saved: Saved = {};
    const correct = `0x${"c".repeat(64)}`;
    const first = harness({
      saved,
      respond: (_, args) => {
        if (args.txHash === correct) throw new Error("session dropped");
        return tracked(WRONG_HASH);
      },
      answers: { provide: () => ({ txHash: correct }) },
    });
    await expect(run(first.host, { tool: TRACK, args: TRACK_ARGS })).rejects.toThrow("session dropped");
    expect(saved.swap).toMatchObject({
      tool: TRACK,
      hash: correct,
      args: { bridgeId: BRIDGE_ID, chain: ARBITRUM.key },
    });
    const second = harness({ saved, respond: () => tracked(DELIVERED, ref(ARBITRUM, correct)) });
    await run(second.host, START);
    expect(second.calls).toEqual([{ tool: TRACK, args: { ...TRACK_ARGS, txHash: correct } }]);
    expect(second.sends()).toBe(0);
  });

  it("stops after three hash corrections even when an agent keeps inventing new hashes", async () => {
    let changed = 0;
    const bridge = harness({
      respond: (_, args) => tracked(WRONG_HASH, ref(ARBITRUM, String(args.txHash))),
      answers: { provide: () => ({ txHash: `0x${(++changed).toString(16).padStart(64, "0")}` }) },
    });
    expect(await run(bridge.host, { tool: TRACK, args: TRACK_ARGS })).toMatchObject({ stop: "handoff" });
    expect(bridge.of(TRACK)).toHaveLength(4);
    expect(bridge.asked.at(-1)).toBe("external:help_desk");
    expect(bridge.sends()).toBe(0);
  });

  it("keeps the hash-correction budget across sessions", async () => {
    const saved: Saved = {};
    const first = harness({
      saved,
      respond: (_, args, nth) => {
        if (nth === 2) throw new Error("session dropped");
        return tracked(WRONG_HASH, ref(ARBITRUM, String(args.txHash)));
      },
      answers: { provide: () => ({ txHash: HUB_TX }) },
    });
    await expect(run(first.host, { tool: TRACK, args: TRACK_ARGS })).rejects.toThrow("session dropped");
    const second = harness({
      saved,
      respond: (_, args) => tracked(WRONG_HASH, ref(ARBITRUM, String(args.txHash))),
      answers: { provide: () => ({ txHash: TX }) },
    });
    expect(await run(second.host, START)).toMatchObject({ stop: "handoff" });
    expect(second.of(TRACK)).toHaveLength(3);
    expect(second.asked.at(-1)).toBe("external:help_desk");
  });

  it.each([
    [{ status: "awaiting_source", seenOnChain: false }, "external:check_wallet"],
    [{ status: "relaying" }, "external:still_in_progress"],
    [{ status: "in_transit", hubTxHash: HUB_TX }, "external:still_in_progress"],
  ] satisfies [TrackState, string][])("hands off a stuck %s after its poll budget", async (state, ask) => {
    const bridge = harness({ respond: () => tracked(state) });
    expect(await run(bridge.host, { tool: TRACK, args: TRACK_ARGS })).toMatchObject({ stop: "handoff" });
    expect(bridge.of(TRACK)).toHaveLength(31);
    expect(bridge.asked).toEqual([ask]);
    expect(bridge.sends()).toBe(0);
  });

  it("hands off repeated upstream failures after a send without preparing or sending again", async () => {
    const bridge = harness({ respond: (tool, args) => failure("UPSTREAM_UNAVAILABLE", tool as typeof TRACK, args) });
    expect(await run(bridge.host, { tool: TRACK, args: TRACK_ARGS })).toMatchObject({
      stop: "terminal",
      outcome: "unknown",
    });
    expect(bridge.calls).toHaveLength(11);
    expect(bridge.asked).toEqual(["external:help_desk"]);
    expect(bridge.sends()).toBe(0);
  });

  it.each([
    [{ status: "source_failed" }, "failed"],
    [{ status: "relay_failed", alerted: true }, "held"],
    [{ status: "held_on_hub", hubTxHash: HUB_TX, alerted: true }, "held"],
    [{ status: "not_submitted", reason: "multiple_messages", alerted: true }, "unknown"],
    [{ status: "delivered", dstTxHash: "destination-tx", delivery: "sent" }, "succeeded"],
  ] satisfies [TrackState, string][])("ends a %s without sending another bridge", async (state, outcome) => {
    const bridge = harness({ respond: () => tracked(state) });
    expect(await run(bridge.host, { tool: TRACK, args: TRACK_ARGS })).toMatchObject({ stop: "terminal", outcome });
    expect(bridge.calls).toHaveLength(1);
    expect(bridge.sends()).toBe(0);
  });

  it("sends a non-EVM bridge to its own track tool with the source chain and wallet's hash", async () => {
    const bridge = harness({
      respond: tool => (tool === PREPARE ? prepared(NON_EVM_READY) : tracked(DELIVERED, ref(NON_EVM_READY.from.chain))),
      answers: { confirm: () => true },
      wallet: (action, result) => {
        expect(action).not.toHaveProperty("batchAt");
        expect(result.steps).toEqual(NON_EVM_READY.steps);
        return { hash: "solana-tx" };
      },
    });
    expect(await run(bridge.host, { tool: PREPARE, args: PAIR_ARGS })).toMatchObject({ outcome: "succeeded" });
    expect(bridge.of(TRACK)).toEqual([
      { tool: TRACK, args: { bridgeId: BRIDGE_ID, chain: "solana", txHash: "solana-tx" } },
    ]);
    expect(bridge.sends()).toBe(1);
  });
});
