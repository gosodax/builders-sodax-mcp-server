import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type Script, harness as sharedHarness } from "./__fixtures__/nextActionHarness.js";
import { type Saved, run } from "./__fixtures__/nextActionRuntime.js";
import {
  ARBITRUM,
  CANCEL_TX,
  NOW,
  PRICE,
  QUOTE_ID,
  READY,
  SUI,
  TX,
  cancelled,
  failure,
  quoted,
  ref,
  tracked,
} from "./__fixtures__/swapResults.js";

type Args = Record<string, unknown>;

const PRICE_ARGS = { fromChain: "arb", fromToken: "USDC", toChain: "sonic", toToken: "S", amount: "5" };
const TRACK_ARGS = { txHash: TX, chain: ARBITRUM.key, quoteId: QUOTE_ID };
const SOLVED = {
  status: "solved",
  minimumReceived: { amount: "9.9", symbol: "S", chainName: "Sonic" },
  delivery: "complete",
};

const harness = (script: Script) => sharedHarness(script, NOW, TX);

const TRACK = "sodax_swap_submit_and_track";
const CANCEL = "sodax_swap_cancel";

describe("the reference runtime", () => {
  it("prices, asks for the wallet, prepares, confirms, signs and tracks a swap to its end", async () => {
    const swap = harness({
      respond: (tool, _, nth) =>
        tool === "sodax_swap_price"
          ? quoted(PRICE)
          : tool === "sodax_swap_prepare"
            ? quoted(READY)
            : tracked(nth < 3 ? { status: "queued", retryAfterSec: 15 } : SOLVED),
      answers: { provide: () => ({ fromAddress: "0xUser" }), confirm: () => true },
    });
    const ending = await run(swap.host, { tool: "sodax_swap_price", args: PRICE_ARGS });
    expect(ending).toMatchObject({ stop: "terminal", result: { outcome: "succeeded" } });
    expect(swap.asked).toEqual(["provide", "confirm"]);
    expect(swap.of("sodax_swap_prepare")).toEqual([
      { tool: "sodax_swap_prepare", args: { ...PRICE_ARGS, fromAddress: "0xUser" } },
    ]);
    // Tracked with the quote, its chain and the hash the wallet broadcast.
    expect(swap.of(TRACK).map(made => made.args)).toEqual(Array(3).fill(TRACK_ARGS));
    expect(swap.sends()).toBe(1);
  });

  it("tracks a swap the moment it's broadcast, even when its NEAR receipt then fails after the deposit", async () => {
    const swap = harness({
      respond: tool =>
        tool === "sodax_swap_prepare"
          ? quoted(READY)
          : tracked({ status: "source_failed", depositHeld: true, alerted: false }),
      answers: { confirm: () => true },
    });
    const ending = await run(swap.host, { tool: "sodax_swap_prepare", args: PRICE_ARGS });
    expect(ending).toMatchObject({ stop: "terminal", result: { outcome: "held" } });
    expect(swap.asked).toEqual(["confirm", "external:help_desk"]);
  });

  it("stops at a declined confirm without sending anything", async () => {
    const swap = harness({ respond: () => quoted(READY), answers: { confirm: () => false } });
    expect(await run(swap.host, { tool: "sodax_swap_prepare", args: PRICE_ARGS })).toMatchObject({ stop: "declined" });
    expect(swap.sends()).toBe(0);
    expect(swap.host.saved.swap).toBeUndefined();
  });

  it("resumes a swap interrupted after its broadcast from the saved hash, never sending it again", async () => {
    const saved: Saved = {};
    const first = harness({
      saved,
      respond: tool => {
        if (tool === TRACK) throw new Error("the session dropped");
        return quoted(READY);
      },
      answers: { confirm: () => true },
    });
    await expect(run(first.host, { tool: "sodax_swap_prepare", args: PRICE_ARGS })).rejects.toThrow("dropped");
    const second = harness({ saved, respond: () => tracked(SOLVED) });
    const ending = await run(second.host, { tool: "sodax_swap_prepare", args: PRICE_ARGS });
    expect(ending).toMatchObject({ stop: "terminal", result: { outcome: "succeeded" } });
    expect(second.calls).toEqual([{ tool: TRACK, args: TRACK_ARGS }]);
    expect(first.sends() + second.sends()).toBe(1);
  });

  it("resumes a batch interrupted before its tx hash through the wallet's status, never resending it", async () => {
    const saved: Saved = {};
    const first = harness({
      saved,
      respond: () => quoted(READY),
      answers: { confirm: () => true },
      wallet: () => ({ batchId: "batch-1" }),
      batch: () => {
        throw new Error("the session dropped");
      },
    });
    await expect(run(first.host, { tool: "sodax_swap_prepare", args: PRICE_ARGS })).rejects.toThrow("dropped");
    expect(saved.swap).toMatchObject({ batchId: "batch-1" });
    const second = harness({ saved, respond: () => tracked(SOLVED), batch: id => (id === "batch-1" ? TX : undefined) });
    await run(second.host, { tool: "sodax_swap_prepare", args: PRICE_ARGS });
    // Tracked by the batch's transaction hash, not its id.
    expect(second.calls).toEqual([{ tool: TRACK, args: TRACK_ARGS }]);
    expect(first.sends() + second.sends()).toBe(1);
  });

  it("follows a relayed cancel while the backend still says it can be cancelled, never signing a second", async () => {
    const swap = harness({
      respond: (tool, args) => {
        if (tool === TRACK) return tracked({ status: "failed", failure: "cancel_to_recover", canCancel: true });
        return args.cancelTxHash
          ? cancelled({ status: "cancel_relayed", cancelTxHash: args.cancelTxHash })
          : cancelled({ status: "ready", steps: [{ kind: "cancel", chainId: 42161, tx: {} }] });
      },
      answers: { confirm: () => true },
      wallet: () => ({ hash: CANCEL_TX }),
    });
    const ending = await run(swap.host, { tool: TRACK, args: TRACK_ARGS });
    expect(ending.stop).toBe("handoff");
    expect(swap.asked).toEqual(["confirm", "external:help_desk"]);
    expect(swap.sends()).toBe(1);
    expect(swap.of(CANCEL).map(made => made.args)).toEqual([TRACK_ARGS, { ...TRACK_ARGS, cancelTxHash: CANCEL_TX }]);
    // The first track, then its relayed cancel's bound of 20.
    expect(swap.of(TRACK)).toHaveLength(21);
  });

  it("tracks a fill that beat the cancel until it arrives", async () => {
    const swap = harness({
      respond: (tool, _, nth) =>
        tool === CANCEL
          ? cancelled({ status: "not_cancellable", reason: "solved" })
          : tracked(nth === 1 ? { status: "failed", failure: "cancel_to_recover", canCancel: true } : SOLVED),
      answers: { confirm: () => true },
    });
    const ending = await run(swap.host, { tool: TRACK, args: TRACK_ARGS });
    expect(ending).toMatchObject({ stop: "terminal", result: { outcome: "succeeded" } });
    expect(swap.sends()).toBe(0);
  });

  it("keeps cancelling a swap that hasn't reached the hub, until the cancel can be built", async () => {
    const swap = harness({
      respond: (_, args, nth) =>
        args.cancelTxHash
          ? cancelled({ status: "cancel_confirmed" })
          : cancelled(
              nth < 3
                ? { status: "not_cancellable", reason: "not_on_hub_yet" }
                : { status: "ready", steps: [{ kind: "cancel", chainId: 42161, tx: {} }] },
            ),
      wallet: () => ({ hash: CANCEL_TX }),
    });
    const ending = await run(swap.host, { tool: CANCEL, args: TRACK_ARGS });
    expect(ending).toMatchObject({ stop: "terminal", result: { outcome: "cancelled" } });
    expect(swap.of(CANCEL).at(-1)?.args).toEqual({ ...TRACK_ARGS, cancelTxHash: CANCEL_TX });
    expect(swap.of(TRACK)).toEqual([]);
  });

  it("retries a non-EVM tx its node hasn't got once, then asks the user for the hash it should track", async () => {
    const replaced = `0x${"b".repeat(64)}`;
    const swap = harness({
      respond: (_, args) =>
        args.txHash === TX
          ? tracked({ status: "source_not_found" }, ref(SUI))
          : tracked(SOLVED, ref(SUI, String(args.txHash))),
      answers: { provide: () => ({ txHash: replaced }) },
    });
    await run(swap.host, { tool: TRACK, args: { txHash: TX, chain: SUI.key, quoteId: QUOTE_ID } });
    expect(swap.of(TRACK).map(made => made.args.txHash)).toEqual([TX, TX, replaced]);
    expect(swap.asked).toEqual(["external:check_wallet", "provide"]);
  });

  it("keeps the hash of a swap whose quote was lost, and asks only for its chain", async () => {
    const swap = harness({
      respond: (tool, args, nth) =>
        nth === 1 ? failure("QUOTE_NOT_FOUND", TRACK, args, { field: "chain" }) : tracked(SOLVED),
      answers: { provide: () => ({ chain: ARBITRUM.key }) },
    });
    await run(swap.host, { tool: TRACK, args: { txHash: TX, quoteId: QUOTE_ID } });
    expect(swap.of(TRACK).map(made => made.args)).toEqual([{ txHash: TX, quoteId: QUOTE_ID }, TRACK_ARGS]);
  });

  it("asks for a token nothing resolves, then prices the same swap with it", async () => {
    const swap = harness({
      respond: (tool, args, nth) =>
        nth === 1 ? failure("UNKNOWN_TOKEN", tool as "sodax_swap_price", args, { field: "fromToken" }) : quoted(PRICE),
      answers: { provide: action => (action.fields[0].name === "fromToken" ? { fromToken: "USDC.e" } : undefined) },
    });
    const ending = await run(swap.host, { tool: "sodax_swap_price", args: PRICE_ARGS });
    expect(swap.of("sodax_swap_price").map(made => made.args)).toEqual([
      PRICE_ARGS,
      { ...PRICE_ARGS, fromToken: "USDC.e" },
    ]);
    expect(ending.stop).toBe("declined");
  });

  const pollUntil = NOW + 60_000;
  const stopAfter = NOW + 300_000;
  const iso = (ms: number) => new Date(ms).toISOString();
  /** A tx no node has seen: polled until pollUntil, then the answer that asks the user. */
  const unseenUntil = (now: number) => {
    const unseen = { status: "awaiting_source_confirmation", seenOnChain: false, stopAfter: iso(stopAfter) };
    return now < pollUntil
      ? tracked({ ...unseen, retryAfterSec: 15, pollUntil: iso(pollUntil) })
      : tracked({ ...unseen, retryAfterSec: (stopAfter - now) / 1000 + 15 });
  };

  it("polls an unseen tx until pollUntil, asks the user, and tracks it soon once they say it was sent", async () => {
    let said = false;
    const swap = harness({
      respond: (_, __, ___, now) => (said ? tracked(SOLVED) : unseenUntil(now)),
      answers: {
        external: () => {
          said = true;
          return true;
        },
      },
    });
    const ending = await run(swap.host, { tool: TRACK, args: TRACK_ARGS });
    expect(ending).toMatchObject({ stop: "terminal", outcome: "succeeded" });
    expect(swap.asked).toEqual(["external:check_wallet"]);
    // Tracked within seconds of the answer, long before stopAfter: a late broadcast is still submitted in time.
    expect(swap.now()).toBeLessThan(pollUntil + 60_000);
  });

  it("stops a runtime that keeps saying the tx was sent while no node sees it", async () => {
    const swap = harness({ respond: (_, __, ___, now) => unseenUntil(now) });
    const ending = await run(swap.host, { tool: TRACK, args: TRACK_ARGS });
    expect(ending.stop).toBe("handoff");
    expect(swap.asked).toEqual([...Array(4).fill("external:check_wallet"), "external:still_in_progress"]);
  });

  it("makes the call that starts a refused swap's refund after its deadline", async () => {
    const swap = harness({
      respond: (_, __, nth, now) =>
        nth === 1
          ? tracked({ status: "submit_refused", alerted: true, retryAfterSec: 915 })
          : tracked(now >= NOW + 900_000 ? { status: "expired_refunding" } : { status: "submit_refused" }),
    });
    const ending = await run(swap.host, { tool: TRACK, args: TRACK_ARGS });
    expect(ending).toMatchObject({ stop: "terminal", result: { outcome: "refunding" } });
    expect(swap.of(TRACK)).toHaveLength(2);
  });

  it("counts only failures in a row: scattered ones over a long swap never end it", async () => {
    const swap = harness({
      respond: (_, args, nth) =>
        nth % 2 === 0
          ? failure("UPSTREAM_UNAVAILABLE", TRACK, args)
          : tracked(nth < 31 ? { status: "queued", retryAfterSec: 15 } : SOLVED),
    });
    const ending = await run(swap.host, { tool: TRACK, args: TRACK_ARGS });
    expect(ending).toMatchObject({ stop: "terminal", result: { outcome: "succeeded" } });
    // Fifteen failures in all, never two in a row.
    expect(swap.of(TRACK)).toHaveLength(31);
  });

  it("goes on after an external only once the person says it's done", async () => {
    const notReady = (_: string, args: Args) => failure("DESTINATION_NOT_READY", "sodax_swap_prepare", args);
    const waiting = harness({ respond: notReady, answers: { external: () => false } });
    expect(await run(waiting.host, { tool: "sodax_swap_prepare", args: PRICE_ARGS })).toMatchObject({
      stop: "handoff",
    });
    expect(waiting.calls).toHaveLength(1);
    const done = harness({
      respond: (tool, args, nth) => (nth === 1 ? notReady(tool, args) : quoted(READY)),
      answers: { external: () => true, confirm: () => false },
    });
    expect(await run(done.host, { tool: "sodax_swap_prepare", args: PRICE_ARGS })).toMatchObject({ stop: "declined" });
    expect(done.of("sodax_swap_prepare").map(made => made.args)).toEqual([PRICE_ARGS, PRICE_ARGS]);
  });

  it("never prepares a second swap while a sent batch still has no hash", async () => {
    const saved: Saved = {};
    const first = harness({
      saved,
      respond: () => quoted(READY),
      answers: { confirm: () => true },
      wallet: () => ({ batchId: "batch-1" }),
      batch: () => undefined,
    });
    expect(await run(first.host, { tool: "sodax_swap_prepare", args: PRICE_ARGS })).toMatchObject({ stop: "handoff" });
    const second = harness({ saved, respond: () => quoted(READY), batch: () => undefined });
    expect(await run(second.host, { tool: "sodax_swap_prepare", args: PRICE_ARGS })).toMatchObject({ stop: "handoff" });
    expect(second.calls).toEqual([]);
    expect(saved.swap).toMatchObject({ batchId: "batch-1" });
    const third = harness({ saved, respond: () => tracked(SOLVED), batch: () => TX });
    await run(third.host, { tool: "sodax_swap_prepare", args: PRICE_ARGS });
    expect(third.calls).toEqual([{ tool: TRACK, args: TRACK_ARGS }]);
    expect(first.sends() + second.sends() + third.sends()).toBe(1);
  });

  /** A cancel no node ever confirms, a new one confirmed at once, and an agent that agrees to everything. */
  const unsentCancel = (dropped: boolean) =>
    harness({
      respond: (_, args) =>
        args.cancelTxHash === CANCEL_TX
          ? cancelled({ status: "cancel_awaiting_confirmation", retryAfterSec: 15, cancelTxHash: CANCEL_TX })
          : args.cancelTxHash
            ? cancelled({ status: "cancel_confirmed" })
            : cancelled({ status: "ready", steps: [{ kind: "cancel", chainId: 42161, tx: {} }] }),
      answers: { confirm: () => true },
      walletShows: () => dropped,
      wallet: () => ({ hash: `0x${"d".repeat(64)}` }),
    });

  it("builds a new cancel only once the wallet shows the pending one can never land", async () => {
    const swap = unsentCancel(true);
    const ending = await run(swap.host, { tool: CANCEL, args: { ...TRACK_ARGS, cancelTxHash: CANCEL_TX } });
    expect(ending).toMatchObject({ stop: "terminal", outcome: "cancelled" });
    // Ten re-reads of the unsent one, then the wallet's record, not a yes, builds and sends a new one.
    expect(swap.asked).toEqual(["wallet"]);
    expect(swap.of(CANCEL).filter(made => !made.args.cancelTxHash)).toHaveLength(1);
    expect(swap.sends()).toBe(1);
  });

  it("never replaces a pending cancel on an agent's yes alone", async () => {
    const swap = unsentCancel(false);
    expect(await run(swap.host, { tool: CANCEL, args: { ...TRACK_ARGS, cancelTxHash: CANCEL_TX } })).toMatchObject({
      stop: "declined",
    });
    expect(swap.of(CANCEL).filter(made => !made.args.cancelTxHash)).toEqual([]);
    expect(swap.sends()).toBe(0);
  });

  it("sends at most three cancels for one swap, however often the agent agrees to another", async () => {
    const swap = harness({
      respond: (_, args) =>
        args.cancelTxHash
          ? cancelled({ status: "cancel_failed" })
          : cancelled({ status: "ready", steps: [{ kind: "cancel", chainId: 42161, tx: {} }] }),
      answers: { confirm: () => true },
      wallet: () => ({ hash: CANCEL_TX }),
    });
    expect(await run(swap.host, { tool: CANCEL, args: TRACK_ARGS })).toMatchObject({ stop: "handoff" });
    expect(swap.sends()).toBe(3);
    expect(swap.asked.at(-1)).toBe("external:help_desk");
  });

  it("shares one budget between failed cancels and dropped ones", async () => {
    let sent = 0;
    const swap = harness({
      respond: (_, args) => {
        if (!args.cancelTxHash)
          return cancelled({ status: "ready", steps: [{ kind: "cancel", chainId: 42161, tx: {} }] });
        // The first cancel fails, the second never lands, the third fails.
        return String(args.cancelTxHash).endsWith("2")
          ? cancelled({ status: "cancel_awaiting_confirmation", retryAfterSec: 15, cancelTxHash: args.cancelTxHash })
          : cancelled({ status: "cancel_failed" });
      },
      answers: { confirm: () => true },
      walletShows: () => true,
      wallet: () => ({ hash: `0x${String(++sent).padStart(64, "0")}` }),
    });
    expect(await run(swap.host, { tool: CANCEL, args: TRACK_ARGS })).toMatchObject({ stop: "handoff" });
    expect(swap.asked).toEqual(["confirm", "wallet", "confirm", "external:help_desk"]);
    expect(swap.sends()).toBe(3);
  });

  it("stops preparing a swap whose destination the agent keeps calling ready", async () => {
    const swap = harness({ respond: (_, args) => failure("DESTINATION_NOT_READY", "sodax_swap_prepare", args) });
    expect(await run(swap.host, { tool: "sodax_swap_prepare", args: PRICE_ARGS })).toMatchObject({ stop: "terminal" });
    // The first prepare, then three more once the person said it's ready.
    expect(swap.of("sodax_swap_prepare")).toHaveLength(4);
  });

  it("stops asking for a hash when no node has seen any the agent gives, with no quote to go by", async () => {
    let given = 0;
    const swap = harness({
      respond: (_, args) =>
        tracked({ status: "source_not_found", quoteId: undefined }, ref(ARBITRUM, String(args.txHash))),
      answers: { provide: () => ({ txHash: `0x${String(++given).padStart(64, "0")}` }) },
    });
    expect(await run(swap.host, { tool: TRACK, args: { txHash: TX, chain: ARBITRUM.key } })).toMatchObject({
      stop: "handoff",
    });
    expect(swap.of(TRACK)).toHaveLength(4);
    expect(swap.asked.at(-1)).toBe("external:help_desk");
  });

  it("resumes a pending cancel with the chain the user added once its quote was lost", async () => {
    const saved: Saved = {};
    const lost = { txHash: TX, quoteId: QUOTE_ID, cancelTxHash: CANCEL_TX };
    const first = harness({
      saved,
      respond: (_, args) => {
        if (args.chain) throw new Error("the session dropped");
        return failure("QUOTE_NOT_FOUND", CANCEL, args, { field: "chain" });
      },
      answers: { provide: () => ({ chain: ARBITRUM.key }) },
    });
    await expect(run(first.host, { tool: CANCEL, args: lost })).rejects.toThrow("dropped");
    const second = harness({ saved, respond: () => cancelled({ status: "cancel_confirmed" }) });
    await run(second.host, { tool: CANCEL, args: lost });
    expect(second.calls).toEqual([{ tool: CANCEL, args: { ...TRACK_ARGS, cancelTxHash: CANCEL_TX } }]);
  });

  it("resumes with the hash the user corrected, not the one first tracked", async () => {
    const saved: Saved = {};
    const replaced = `0x${"b".repeat(64)}`;
    const first = harness({
      saved,
      respond: (_, args) => {
        if (args.txHash === replaced) throw new Error("the session dropped");
        return tracked({ status: "source_not_found" });
      },
      answers: { provide: () => ({ txHash: replaced }) },
    });
    await expect(run(first.host, { tool: TRACK, args: TRACK_ARGS })).rejects.toThrow("dropped");
    const second = harness({ saved, respond: (_, args) => tracked(SOLVED, ref(ARBITRUM, String(args.txHash))) });
    await run(second.host, { tool: TRACK, args: TRACK_ARGS });
    expect(second.calls).toEqual([{ tool: TRACK, args: { ...TRACK_ARGS, txHash: replaced } }]);
  });

  it("resumes with the chain the user added to a swap whose quote was lost", async () => {
    const saved: Saved = {};
    const lost = { txHash: TX, quoteId: QUOTE_ID };
    const first = harness({
      saved,
      respond: (tool, args) => {
        if (args.chain) throw new Error("the session dropped");
        return failure("QUOTE_NOT_FOUND", tool as "sodax_swap_submit_and_track", args, { field: "chain" });
      },
      answers: { provide: () => ({ chain: ARBITRUM.key }) },
    });
    await expect(run(first.host, { tool: TRACK, args: lost })).rejects.toThrow("dropped");
    const second = harness({ saved, respond: () => tracked(SOLVED) });
    await run(second.host, { tool: TRACK, args: lost });
    expect(second.calls).toEqual([{ tool: TRACK, args: TRACK_ARGS }]);
  });

  it("treats a cancel hash the user gave as pending: no second cancel while the backend catches up", async () => {
    const swap = harness({
      respond: (tool, args) => {
        if (tool === TRACK) return tracked({ status: "failed", failure: "cancel_to_recover", canCancel: true });
        return args.cancelTxHash === CANCEL_TX
          ? cancelled({ status: "cancel_relayed", cancelTxHash: CANCEL_TX })
          : cancelled({ status: "not_a_cancel_tx" });
      },
      answers: { provide: () => ({ cancelTxHash: CANCEL_TX }) },
    });
    await run(swap.host, { tool: CANCEL, args: { ...TRACK_ARGS, cancelTxHash: `0x${"e".repeat(64)}` } });
    expect(swap.asked).toEqual(["provide", "external:help_desk"]);
    expect(swap.sends()).toBe(0);
    expect(swap.of(CANCEL)).toHaveLength(2);
  });

  it("reports where the funds are when a bound runs out on a held deposit", async () => {
    const swap = harness({
      respond: () => tracked({ status: "expired_unsubmitted", alerted: true, retryAfterSec: 60 }),
    });
    expect(await run(swap.host, { tool: TRACK, args: TRACK_ARGS })).toMatchObject({
      stop: "terminal",
      outcome: "held",
    });
  });

  it("resumes a cancel interrupted after its broadcast with its hash, never signing another", async () => {
    const saved: Saved = {};
    const readyCancel = () => cancelled({ status: "ready", steps: [{ kind: "cancel", chainId: 42161, tx: {} }] });
    const first = harness({
      saved,
      respond: (_, args) => {
        if (args.cancelTxHash) throw new Error("the session dropped");
        return readyCancel();
      },
      wallet: () => ({ hash: CANCEL_TX }),
    });
    await expect(run(first.host, { tool: CANCEL, args: TRACK_ARGS })).rejects.toThrow("dropped");
    const second = harness({
      saved,
      respond: (_, args) => (args.cancelTxHash ? cancelled({ status: "cancel_confirmed" }) : readyCancel()),
    });
    expect(await run(second.host, { tool: CANCEL, args: TRACK_ARGS })).toMatchObject({ outcome: "cancelled" });
    expect(second.calls).toEqual([{ tool: CANCEL, args: { ...TRACK_ARGS, cancelTxHash: CANCEL_TX } }]);
    expect(first.sends() + second.sends()).toBe(1);
  });

  it("keeps reading a sent cancel while the backend catches up, never building a second", async () => {
    const swap = harness({
      respond: (_, args, nth) => {
        if (!args.cancelTxHash)
          return cancelled({ status: "ready", steps: [{ kind: "cancel", chainId: 42161, tx: {} }] });
        return nth < 4
          ? cancelled({ status: "not_cancellable", reason: "not_on_hub_yet", cancelTxHash: args.cancelTxHash })
          : cancelled({ status: "cancel_confirmed" });
      },
      wallet: () => ({ hash: CANCEL_TX }),
    });
    expect(await run(swap.host, { tool: CANCEL, args: TRACK_ARGS })).toMatchObject({ outcome: "cancelled" });
    expect(swap.sends()).toBe(1);
  });

  it("never tracks a cancel's swap that has no record: it hands off instead of submitting it", async () => {
    const swap = harness({ respond: () => cancelled({ status: "not_cancellable", reason: "not_submitted" }) });
    expect(await run(swap.host, { tool: CANCEL, args: TRACK_ARGS })).toMatchObject({ stop: "handoff" });
    expect(swap.of(TRACK)).toEqual([]);
    expect(swap.asked).toEqual(["external:help_desk"]);
  });

  it("is the loop the README quotes, word for word", () => {
    const runtime = readFileSync(new URL("./__fixtures__/nextActionRuntime.ts", import.meta.url), "utf8");
    const loop = /\/\/ #region loop\n([\s\S]*?)\/\/ #endregion loop/.exec(runtime)?.[1];
    const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");
    expect(loop).toBeTruthy();
    expect(readme).toContain(`\`\`\`ts\n${loop}\`\`\``);
  });

  // An SDK refusal, or an older server: handed off, and a prepare is never retried (each holds a quote).
  it("hands a result with no contract off, never calling again", async () => {
    const swap = harness({ respond: () => ({ status: "error" }) });
    expect(await run(swap.host, { tool: "sodax_swap_prepare", args: PRICE_ARGS })).toMatchObject({
      stop: "no_contract",
    });
    expect(swap.calls).toHaveLength(1);
  });
});
