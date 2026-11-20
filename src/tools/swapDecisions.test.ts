import { describe, expect, it } from "vitest";
import type { BalanceResult } from "../services/swap/balance.js";
import { ACTION_ERROR_CODES, ActionError, type ActionErrorCode } from "../services/swap/errors.js";
import type { SwapQuote } from "../services/swap/quote.js";
import type { Resolution } from "../services/swap/resolver.js";
import type { SwapsApiToken } from "../services/swap/tokens.js";
import { actionsOf, contractBreaks, unboundedTopCall } from "./__fixtures__/nextActionChecks.js";
import type { ToolResult } from "./__fixtures__/nextActionRuntime.js";
import {
  ARBITRUM,
  CANCEL_TX,
  LATER,
  PRICE,
  QUOTE_ID,
  READY,
  SONIC,
  SUI,
  TX,
  cancelled,
  failure,
  ref,
  tracked,
} from "./__fixtures__/swapResults.js";
import type { CallTool, Decision, NextAction, SwapToolName } from "./nextAction.js";
import { balanceDecision, errorDecision, quoteDecision, resolveDecision } from "./swapDecisions.js";

const ARGS = { txHash: TX, chain: ARBITRUM.key, quoteId: QUOTE_ID };

/** A tool result as the decision it carries. */
const decided = (result: ToolResult) => result as unknown as Decision;
const track = (state: Record<string, unknown>, chain = ARBITRUM) => decided(tracked(state, ref(chain)));
const cancel = (state: Record<string, unknown>, chain = ARBITRUM) => decided(cancelled(state, ref(chain)));

/** Every track and cancel result, by status and reason. */
const TRACK_RESULTS: [string, Record<string, unknown>, typeof ARBITRUM?][] = [
  ["awaiting, seen", { status: "awaiting_source_confirmation", seenOnChain: true, retryAfterSec: 15 }],
  [
    "awaiting, unseen, polled",
    {
      status: "awaiting_source_confirmation",
      seenOnChain: false,
      retryAfterSec: 15,
      stopAfter: LATER,
      pollUntil: LATER,
    },
  ],
  [
    "awaiting, unseen, past pollUntil",
    { status: "awaiting_source_confirmation", seenOnChain: false, retryAfterSec: 315, stopAfter: LATER },
  ],
  ["awaiting, unseen, no quote", { status: "awaiting_source_confirmation", seenOnChain: false, retryAfterSec: 15 }],
  ["source_not_found, EVM", { status: "source_not_found" }],
  ["source_not_found, non-EVM", { status: "source_not_found" }, SUI],
  ["source_failed", { status: "source_failed" }],
  ["source_failed, held, alerted", { status: "source_failed", depositHeld: true, alerted: true }],
  ["source_failed, held, not alerted", { status: "source_failed", depositHeld: true, alerted: false }],
  ["source_failed, not this quote", { status: "source_failed", depositHeld: true, alerted: true, notThisQuote: true }],
  ["not_submitted not_a_deposit", { status: "not_submitted", reason: "not_a_deposit" }],
  ["not_submitted deposit_mismatch", { status: "not_submitted", reason: "deposit_mismatch", alerted: false }],
  ["not_submitted other_sender", { status: "not_submitted", reason: "other_sender", alerted: true }],
  ["not_submitted quote_used", { status: "not_submitted", reason: "quote_used", alerted: false }],
  ["not_submitted multiple_deposits", { status: "not_submitted", reason: "multiple_deposits", alerted: true }],
  ["not_submitted unverified", { status: "not_submitted", reason: "unverified", alerted: true }],
  ["unknown quote, deposit", { status: "not_submitted_unknown_quote", isDeposit: true, alerted: true }],
  ["unknown quote, not a deposit", { status: "not_submitted_unknown_quote", isDeposit: false, alerted: false }],
  ["expired_refunding", { status: "expired_refunding" }],
  ["expired_awaiting_refund", { status: "expired_awaiting_refund" }, SONIC],
  ["intent_closed", { status: "intent_closed" }, SONIC],
  ["expired_unsubmitted", { status: "expired_unsubmitted", alerted: false, retryAfterSec: 60 }],
  ["submit_refused", { status: "submit_refused", alerted: true, retryAfterSec: 915 }],
  ["queued", { status: "queued", retryAfterSec: 15 }],
  ["in_progress", { status: "in_progress", stage: "relaying", retryAfterSec: 15 }],
  [
    "solved, complete",
    {
      status: "solved",
      minimumReceived: { amount: "4.9", symbol: "USDC", chainName: "Sonic" },
      delivery: "complete",
    },
  ],
  [
    "solved, in transit",
    {
      status: "solved",
      minimumReceived: { amount: "4.9", symbol: "USDC", chainName: "Base" },
      delivery: "in_transit",
    },
  ],
  ["solved, no quote", { status: "solved" }],
  ["failed, cancellable", { status: "failed", failure: "cancel_to_recover", canCancel: true }],
  ["failed, cancelled", { status: "failed", failure: "cancelled", canCancel: false }],
  ["failed, refunding", { status: "failed", failure: "refunding", canCancel: false }],
  ["failed, abandoned", { status: "failed", failure: "abandoned", canCancel: false }],
  ["failed, unknown", { status: "failed", failure: "unknown", canCancel: false }],
  ["unknown", { status: "unknown" }],
];

const CANCEL_RESULTS: [string, Record<string, unknown>, typeof ARBITRUM?][] = [
  ...(
    [
      "not_submitted",
      "solved",
      "cancelled",
      "refunding",
      "closed",
      "not_on_hub_yet",
      "not_sent",
      "not_this_swap",
    ] as const
  ).map((reason): [string, Record<string, unknown>] => [
    `not_cancellable ${reason}`,
    { status: "not_cancellable", reason },
  ]),
  ["not_cancellable not_submitted, hub", { status: "not_cancellable", reason: "not_submitted" }, SONIC],
  ["not_cancellable unverified", { status: "not_cancellable", reason: "unverified" }],
  ["deposit_unsubmitted", { status: "deposit_unsubmitted", retryAfterSec: 915 }],
  ["expired_unsubmitted", { status: "expired_unsubmitted", alerted: true, retryAfterSec: 60 }],
  [
    "ready",
    { status: "ready", steps: [{ kind: "cancel", chainId: 42161, tx: { to: "0x1", value: "0", data: "0x" } }] },
  ],
  [
    "cancel_awaiting_confirmation",
    { status: "cancel_awaiting_confirmation", retryAfterSec: 15, cancelTxHash: CANCEL_TX },
  ],
  ["cancel_failed", { status: "cancel_failed" }],
  ["not_a_cancel_tx", { status: "not_a_cancel_tx" }],
  ["cancel_relayed", { status: "cancel_relayed", cancelTxHash: CANCEL_TX }],
  ["cancel_relayed, unverified", { status: "cancel_relayed", cancelTxHash: CANCEL_TX, unverified: true }],
  ["cancel_confirmed", { status: "cancel_confirmed" }],
];

const TRACKED: [string, Decision][] = [
  ...TRACK_RESULTS.map(([name, state, chain]): [string, Decision] => [`track ${name}`, track(state, chain)]),
  ...CANCEL_RESULTS.map(([name, state, chain]): [string, Decision] => [`cancel ${name}`, cancel(state, chain)]),
];

const PRE_SEND: SwapToolName[] = ["sodax_swap_price", "sodax_swap_prepare", "sodax_get_balance", "sodax_resolve_token"];
const AFTER_SEND: SwapToolName[] = ["sodax_swap_submit_and_track", "sodax_swap_cancel"];
const failed = (code: ActionErrorCode, tool: SwapToolName, details?: Record<string, unknown>) =>
  decided(failure(code, tool, { amount: "5", deadlineMinutes: 15 }, details));
// Every code from every tool, naming a field as its throw sites do.
const ERRORS: [string, Decision][] = [...PRE_SEND, ...AFTER_SEND].flatMap(tool =>
  ACTION_ERROR_CODES.map((code): [string, Decision] => [`${tool} ${code}`, failed(code, tool, { field: "amount" })]),
);

const token = (symbol: string, address: string): SwapsApiToken => ({
  symbol,
  name: symbol,
  address,
  chainKey: ARBITRUM.key,
  decimals: 6,
  hubAsset: "0x1",
  isNative: false,
});
const RESOLUTIONS: [string, Resolution][] = [
  ["resolved", { status: "resolved", chain: ARBITRUM, matchedBy: "symbol", token: token("USDC", "0x1") }],
  [
    "ambiguous",
    { status: "ambiguous", chain: ARBITRUM, query: "usdc", candidates: [token("USDC", "0x1"), token("USDC.e", "0x2")] },
  ] as [string, Resolution],
  ["not_found, nothing near", { status: "not_found", chain: ARBITRUM, query: "zzz", suggestions: [] }],
  [
    "not_found, elsewhere",
    {
      status: "not_found",
      chain: ARBITRUM,
      query: "sui",
      suggestions: [],
      otherChains: [{ chain: SUI, token: token("SUI", "0x2::sui::SUI") }],
    },
  ] as [string, Resolution],
];
const LOOKUPS: [string, Decision][] = [
  ["price", quoteDecision(PRICE)],
  ["prepare, ready", quoteDecision(READY)],
  ...RESOLUTIONS.map(([name, resolution]): [string, Decision] => [`resolve ${name}`, resolveDecision(resolution)]),
  [
    "balance",
    balanceDecision({
      chain: ARBITRUM,
      address: "0xuser",
      native: { symbol: "ETH", address: "0x0", amount: "1", baseUnits: "1" },
    } as unknown as BalanceResult),
  ],
];

const ALL = [...TRACKED, ...ERRORS, ...LOOKUPS];

describe("every decision", () => {
  it.each(ALL)("%s keeps the contract", (_, decision) => {
    expect(contractBreaks(decision)).toEqual([]);
  });

  // A call made without a bound or a person must be one whose next answer differs: past a deadline, or another tool's.
  const UNBOUNDED_OK = new Set(["track submit_refused", "cancel deposit_unsubmitted", "cancel not_cancellable solved"]);
  it.each(ALL)("%s makes no unbounded call that can loop", (name, decision) => {
    const call = unboundedTopCall(decision);
    if (call) expect(UNBOUNDED_OK.has(name), `${name} calls ${call.tool} unbounded`).toBe(true);
  });

  it.each(TRACKED)("%s writes back only the swap it found", (_, decision) => {
    const found: Record<string, unknown[]> = {
      txHash: [TX],
      quoteId: [QUOTE_ID],
      cancelTxHash: [CANCEL_TX],
      chain: [ARBITRUM.key, SONIC.key, SUI.key],
    };
    const calls = actionsOf(decision.nextAction).filter((action): action is CallTool => action.type === "call_tool");
    for (const call of calls) {
      expect(call.sameArgs).toBeUndefined();
      for (const [key, value] of Object.entries(call.args ?? {})) expect(found[key]).toContain(value);
    }
  });

  it.each(TRACKED.filter(([, decision]) => decision.nextAction.type === "call_tool"))(
    "%s names the tool its sentence asks for",
    (_, decision) => {
      expect(decision.nextStep).toContain((decision.nextAction as CallTool).tool);
    },
  );

  it.each(ERRORS.filter(([name]) => AFTER_SEND.some(tool => name.startsWith(tool))))(
    "%s keeps a sent swap going: never none, never says to send again",
    (_, decision) => {
      expect(decision.nextAction.type).not.toBe("none");
      expect(decision.nextStep).toMatch(/must not send|don't send/);
    },
  );
});

const type = (decision: Decision) => decision.nextAction.type;
const find = (name: string) => {
  const found = ALL.find(([label]) => label === name);
  if (!found) throw new Error(`no fixture ${name}`);
  return found[1];
};

describe("trackDecision", () => {
  it("ends only once the tokens arrive", () => {
    expect(find("track solved, complete")).toMatchObject({ terminal: true, outcome: "succeeded" });
    for (const name of ["track solved, in transit", "track solved, no quote"]) {
      expect(find(name)).toMatchObject({ terminal: false, nextAction: { type: "call_tool", maxAttempts: 30 } });
    }
  });

  it("ends the loop once a step's polls run out, and once a cancel can't reach the hub, without calling again", () => {
    for (const name of ["track in_progress", "cancel not_cancellable not_on_hub_yet"]) {
      expect((find(name).nextAction as CallTool).onExhausted).toEqual({
        nextAction: { type: "external", reason: "still_in_progress" },
        terminal: false,
      });
    }
  });

  it("polls a step 30 times, counted per step, then hands it to a person", () => {
    expect(find("track in_progress").nextAction).toMatchObject({
      type: "call_tool",
      tool: "sodax_swap_submit_and_track",
      args: ARGS,
      afterSec: 15,
      maxAttempts: 30,
      retryKey: `sodax_swap_submit_and_track:${TX}:in_progress:relaying`,
      onExhausted: { nextAction: { type: "external", reason: "still_in_progress" }, terminal: false },
    });
  });

  it("polls an unseen tx until pollUntil, then calls once more for the answer that asks the user", () => {
    expect(find("track awaiting, unseen, polled").nextAction).toMatchObject({
      until: LATER,
      onExhausted: { nextAction: { type: "call_tool", args: ARGS, afterSec: 0 }, terminal: false },
    });
    expect(find("track awaiting, unseen, past pollUntil").nextAction).toMatchObject({
      type: "external",
      reason: "check_wallet",
      // Soon once the user says it was sent, not after stopAfter (past the deadline); a few times at most.
      next: {
        type: "call_tool",
        args: ARGS,
        afterSec: 15,
        maxAttempts: 3,
        retryKey: `sodax_swap_submit_and_track:${TX}:said_sent`,
        onExhausted: { nextAction: { type: "external", reason: "still_in_progress" } },
      },
    });
  });

  it("makes the call that starts a refund after the deadline, never bounded before it", () => {
    expect(find("track submit_refused").nextAction).toEqual({
      type: "call_tool",
      tool: "sodax_swap_submit_and_track",
      args: ARGS,
      afterSec: 915,
    });
    expect(find("cancel deposit_unsubmitted").nextAction).toEqual({
      type: "call_tool",
      tool: "sodax_swap_cancel",
      args: ARGS,
      afterSec: 915,
    });
  });

  it("retries a non-EVM tx its node hasn't got once, then asks the user", () => {
    expect(find("track source_not_found, non-EVM").nextAction).toMatchObject({
      maxAttempts: 1,
      onExhausted: { nextAction: { type: "external", reason: "check_wallet", next: { type: "provide" } } },
    });
    expect(type(find("track source_not_found, EVM"))).toBe("provide");
  });

  it("calls a hub swap's outcome unknown, with nobody to act: the hub fills or refunds its intent", () => {
    const hub = track({ status: "not_submitted_unknown_quote", isDeposit: true, alerted: false }, SONIC);
    expect(hub).toMatchObject({ nextAction: { type: "none" }, terminal: true, outcome: "unknown" });
    const spoke = track({ status: "not_submitted_unknown_quote", isDeposit: true, alerted: false });
    expect(spoke).toMatchObject({ nextAction: { type: "external", reason: "help_desk" }, outcome: "held" });
  });

  it("holds a verified deposit, sending the user to the help desk only when no operator was paged", () => {
    expect(find("track source_failed, held, alerted")).toMatchObject({ nextAction: { type: "none" }, outcome: "held" });
    expect(find("track source_failed, held, not alerted")).toMatchObject({
      nextAction: { type: "external", reason: "help_desk" },
      terminal: true,
      outcome: "held",
    });
  });

  it("never calls a tx it couldn't read held", () => {
    expect(find("track not_submitted unverified")).toMatchObject({ terminal: true, outcome: "unknown" });
    expect(find("cancel not_cancellable unverified")).toMatchObject({ terminal: true, outcome: "unknown" });
  });

  it("sends an unpaged refund to the help desk when its retries run out", () => {
    expect(find("track expired_unsubmitted").nextAction).toMatchObject({
      maxAttempts: 10,
      onExhausted: { nextAction: { type: "external", reason: "help_desk" }, terminal: true, outcome: "held" },
    });
    expect(find("cancel expired_unsubmitted").nextAction).toMatchObject({
      onExhausted: { nextAction: { type: "none" }, terminal: true, outcome: "held" },
    });
  });

  it("asks before a cancel, and gives a declined deposit to the help desk", () => {
    expect(find("track failed, cancellable").nextAction).toEqual({
      type: "confirm",
      summary: { kind: "cancel", chain: ARBITRUM.key, txHash: TX },
      next: { type: "call_tool", tool: "sodax_swap_cancel", args: ARGS, afterSec: 0 },
    });
    expect(find("track not_submitted deposit_mismatch").nextAction).toMatchObject({
      type: "provide",
      fields: [{ name: "quoteId" }],
      next: { args: { txHash: TX, chain: ARBITRUM.key } },
      onDecline: { nextAction: { type: "external", reason: "help_desk" }, outcome: "held" },
    });
  });

  it("calls an ended failure where the funds are", () => {
    expect(find("track failed, cancelled").outcome).toBe("cancelled");
    expect(find("track failed, refunding").outcome).toBe("refunding");
    expect(find("track failed, abandoned").outcome).toBe("held");
    expect(find("track source_failed").outcome).toBe("failed");
  });
});

describe("cancelDecision", () => {
  it("never hands a cancel to track while the swap has no record: track would submit it", () => {
    const decision = find("cancel not_cancellable not_submitted");
    expect(actionsOf(decision.nextAction).map(action => (action as CallTool).tool)).not.toContain(
      "sodax_swap_submit_and_track",
    );
    expect((decision.nextAction as CallTool).onExhausted).toEqual({
      nextAction: { type: "external", reason: "help_desk" },
      terminal: false,
    });
  });

  it("keeps a sent cancel's hash through a retry, so a backend catching up never builds a second", () => {
    const decision = cancel({ status: "not_cancellable", reason: "not_on_hub_yet", cancelTxHash: CANCEL_TX });
    expect(decision.nextAction).toMatchObject({ args: { ...ARGS, cancelTxHash: CANCEL_TX } });
  });

  it("follows a fill that beat the cancel on track", () => {
    expect(find("cancel not_cancellable solved").nextAction).toMatchObject({
      type: "call_tool",
      tool: "sodax_swap_submit_and_track",
      args: ARGS,
    });
  });

  it("keeps a cancel waiting for the hub a cancel, bounded", () => {
    expect(find("cancel not_cancellable not_on_hub_yet").nextAction).toMatchObject({
      tool: "sodax_swap_cancel",
      maxAttempts: 10,
      retryKey: `sodax_swap_cancel:${TX}:not_on_hub_yet`,
    });
  });

  it("follows a relayed cancel on track, bounded by its own hash, never cancelling again", () => {
    expect(find("cancel cancel_relayed").nextAction).toMatchObject({
      tool: "sodax_swap_submit_and_track",
      maxAttempts: 20,
      retryKey: `sodax_swap_submit_and_track:${TX}:cancel:${CANCEL_TX}`,
      onExhausted: { nextAction: { type: "external", reason: "help_desk" } },
    });
    expect(find("cancel cancel_relayed, unverified").nextAction).toMatchObject({ afterSec: 180 });
  });

  it("re-reads a sent cancel with its hash, and asks for a new one without it", () => {
    expect(find("cancel cancel_awaiting_confirmation").nextAction).toMatchObject({
      args: { ...ARGS, cancelTxHash: CANCEL_TX },
      maxAttempts: 10,
      // A new cancel only once the user confirms this one was never sent.
      onExhausted: {
        nextAction: {
          type: "confirm",
          summary: { kind: "unsent_cancel", chain: ARBITRUM.key, txHash: TX, cancelTxHash: CANCEL_TX },
          next: { type: "call_tool", tool: "sodax_swap_cancel", args: ARGS, afterSec: 0 },
        },
        terminal: false,
      },
    });
    // Another cancel costs gas again: the user confirms it, never a loop of signatures.
    expect(find("cancel cancel_failed").nextAction).toEqual({
      type: "confirm",
      summary: { kind: "cancel", chain: ARBITRUM.key, txHash: TX },
      next: { type: "call_tool", tool: "sodax_swap_cancel", args: ARGS, afterSec: 0 },
    });
  });

  it("has the wallet send the cancel, then calls back with its hash once broadcast", () => {
    expect(find("cancel ready").nextAction).toEqual({
      type: "execute",
      chain: ARBITRUM.key,
      stepsAt: "steps",
      waitFor: "receipt_success",
      afterSend: {
        type: "call_tool",
        tool: "sodax_swap_cancel",
        args: ARGS,
        afterSec: 0,
        on: "broadcast",
        needs: ["cancelTxHash"],
      },
    });
  });
});

describe("quoteDecision", () => {
  it("asks a price's missing addresses, then prepares the same swap", () => {
    expect(find("price").nextAction).toEqual({
      type: "provide",
      fields: [{ name: "fromAddress" }],
      next: { type: "call_tool", tool: "sodax_swap_prepare", sameArgs: true, afterSec: 0 },
    });
  });

  it("binds the confirm to the quote, then sends in order and tracks the chain's deposit once broadcast", () => {
    expect(find("prepare, ready").nextAction).toEqual({
      type: "confirm",
      summary: {
        kind: "swap",
        quoteId: QUOTE_ID,
        expiresAt: LATER,
        send: { amount: "5", symbol: "USDC", chain: ARBITRUM.key },
        receiveAtLeast: { amount: "9.9", symbol: "S", chain: SONIC.key },
        expected: { amount: "10", symbol: "S" },
        recipient: "0xuser",
        usdValue: "5.00",
        usdOut: "5.00",
        approve: { spender: "0xspender", amount: "5", symbol: "USDC" },
        warnings: ["own_address_other_chain"],
      },
      next: {
        type: "execute",
        chain: ARBITRUM.key,
        stepsAt: "steps",
        batchAt: "batch",
        waitFor: "receipt_success",
        expiresAt: LATER,
        afterSend: {
          type: "call_tool",
          tool: "sodax_swap_submit_and_track",
          args: { quoteId: QUOTE_ID, chain: ARBITRUM.key },
          afterSec: 0,
          on: "broadcast",
          needs: ["txHash"],
        },
      },
    });
  });

  it.each([
    [{ usdValue: null }, ["usd_unchecked"]],
    [{ usdOut: null }, ["rate_unchecked"]],
    [{ usdValue: "60000.00" }, ["above_warn_level"]],
  ])("names the checks %o couldn't do", (fields, warnings) => {
    const quote = { ...READY, ...fields, toAddress: "0xelse" } as SwapQuote;
    const confirm = quoteDecision(quote).nextAction as Extract<NextAction, { type: "confirm" }>;
    expect(confirm.summary).toMatchObject({ warnings });
  });
});

describe("resolveDecision", () => {
  it("offers the catalog's candidates, each setting the chain and its address", () => {
    expect(find("resolve ambiguous").nextAction).toMatchObject({
      type: "choose",
      field: "query",
      options: [
        { label: "USDC on Arbitrum", args: { chain: ARBITRUM.key, query: "0x1" } },
        { label: "USDC.e on Arbitrum", args: { chain: ARBITRUM.key, query: "0x2" } },
      ],
    });
    expect(find("resolve not_found, elsewhere").nextAction).toMatchObject({
      options: [{ label: "SUI on Sui", args: { chain: "sui", query: "0x2::sui::SUI" } }],
    });
  });

  it("asks for the token when it has nothing to offer", () => {
    expect(type(find("resolve not_found, nothing near"))).toBe("provide");
  });
});

describe("errorDecision", () => {
  const option = { label: "Arbitrum", args: { fromChain: ARBITRUM.key } };

  it("offers the options a failure carries, and asks for the field when there are none", () => {
    const withOptions = errorDecision(
      new ActionError("UNSUPPORTED_SOURCE", "No.", { details: { field: "fromChain" }, hint: { options: [option] } }),
      { tool: "sodax_swap_price", args: {} },
    );
    expect(withOptions.nextAction).toEqual({
      type: "choose",
      field: "fromChain",
      options: [option],
      next: { type: "call_tool", tool: "sodax_swap_price", sameArgs: true, afterSec: 0 },
    });
    expect(failed("RESTRICTED_TOKEN", "sodax_swap_prepare", { side: "to", field: "toToken" }).nextAction).toMatchObject(
      {
        type: "provide",
        fields: [{ name: "toToken" }],
      },
    );
  });

  it("asks for a pasted secret's own field again", () => {
    expect(failed("SECRET_REJECTED", "sodax_swap_submit_and_track", { field: "txHash" }).nextAction).toEqual({
      type: "external",
      reason: "secret_exposed",
      next: {
        type: "provide",
        fields: [{ name: "txHash" }],
        next: { type: "call_tool", tool: "sodax_swap_submit_and_track", sameArgs: true, afterSec: 0 },
      },
    });
  });

  it("returns an off-market price to the tool that priced it", () => {
    expect(failed("PRICE_OFF_MARKET", "sodax_swap_price", { field: "amount" }).nextAction).toMatchObject({
      next: { tool: "sodax_swap_price" },
    });
  });

  it("confirms a suggested amount, and asks for one without it", () => {
    expect(failed("AMOUNT_TOO_LOW", "sodax_swap_price", { suggestedAmount: "1.5", symbol: "USDC" }).nextAction).toEqual(
      {
        type: "confirm",
        summary: { kind: "amount", amount: "1.5", symbol: "USDC" },
        next: { type: "call_tool", tool: "sodax_swap_price", sameArgs: true, args: { amount: "1.5" }, afterSec: 0 },
      },
    );
    expect(type(failed("AMOUNT_TOO_LOW", "sodax_swap_price"))).toBe("provide");
  });

  it("retries a short deadline once at 15 minutes, and hands off one already that long", () => {
    const short = errorDecision(new ActionError("DEADLINE_TOO_SHORT", "No."), {
      tool: "sodax_swap_prepare",
      args: { deadlineMinutes: 5 },
    });
    expect(short.nextAction).toMatchObject({ args: { deadlineMinutes: 15 }, maxAttempts: 1 });
    expect(short.nextStep).toBe("Call sodax_swap_prepare again with a longer deadlineMinutes, e.g. 15.");
    const long = failed("DEADLINE_TOO_SHORT", "sodax_swap_prepare");
    expect(long.nextAction).toEqual({ type: "external", reason: "service_unavailable" });
    expect(long.nextStep).not.toContain("deadlineMinutes");
  });

  it.each([
    ["no_route", "provide"],
    ["no_liquidity", "provide"],
    ["amount_too_large", "provide"],
    ["trustline_room", "external"],
    ["rejected", "none"],
  ])("moves on from SWAP_REJECTED %s with a %s", (reason, expected) => {
    expect(type(failed("SWAP_REJECTED", "sodax_swap_prepare", { reason }))).toBe(expected);
  });

  it("checks the balance a wallet couldn't build from, with the quote's canonical arguments", () => {
    const balance = { chain: "sui", address: "0xuser", token: "0x2::sui::SUI" };
    const decision = errorDecision(
      new ActionError("SWAP_REJECTED", "No.", { details: { reason: "wallet_cannot_build" }, hint: { balance } }),
      { tool: "sodax_swap_prepare", args: {} },
    );
    expect(decision.nextAction).toEqual({ type: "call_tool", tool: "sodax_get_balance", args: balance, afterSec: 0 });
  });

  it("sends a cancel built wrong to the help desk, and refuses one before anything was sent", () => {
    expect(find("sodax_swap_cancel SWAP_MISMATCH").nextAction).toEqual({ type: "external", reason: "help_desk" });
    expect(find("sodax_swap_prepare SWAP_MISMATCH")).toMatchObject({ nextAction: { type: "none" }, terminal: true });
  });

  it("hands off a failure its throw site says won't pass, whatever its code's default", () => {
    const bug = new ActionError("INTERNAL", "No.", { retryable: false, nextStep: "Don't repeat it." });
    expect(errorDecision(bug, { tool: "sodax_swap_prepare", args: {} })).toEqual({
      nextStep: "Don't repeat it.",
      nextAction: { type: "external", reason: "service_unavailable" },
      terminal: false,
    });
    // After a send, its sentence says the same: no call again.
    expect(errorDecision(bug, { tool: "sodax_swap_submit_and_track", args: {} }).nextStep).toBe(
      "Don't repeat it. The user must not send the swap again.",
    );
  });

  it("counts one call's failures together, whatever their codes", () => {
    const keyOf = (code: ActionErrorCode) => (failed(code, "sodax_swap_price").nextAction as CallTool).retryKey;
    expect(keyOf("RATE_LIMITED")).toBe(keyOf("UPSTREAM_UNAVAILABLE"));
  });

  it("never asks for an amount after a send: track and cancel take none", () => {
    expect(failed("SWAP_REJECTED", "sodax_swap_cancel", { reason: "no_liquidity" }).nextAction).toEqual({
      type: "external",
      reason: "help_desk",
    });
  });

  it("retries a failure that may pass ten times in a row, then stops", () => {
    const before = find("sodax_swap_price UPSTREAM_UNAVAILABLE").nextAction;
    const after = find("sodax_swap_submit_and_track UPSTREAM_UNAVAILABLE").nextAction;
    expect(before).toMatchObject({
      sameArgs: true,
      afterSec: 30,
      consecutive: true,
      maxAttempts: 10,
      retryKey: expect.stringMatching(/^sodax_swap_price:[0-9a-f]{16}$/),
      onExhausted: { nextAction: { type: "external", reason: "service_unavailable" }, terminal: false },
    });
    expect(after).toMatchObject({
      onExhausted: { nextAction: { type: "external", reason: "help_desk" }, terminal: true, outcome: "unknown" },
    });
  });

  it.each(ACTION_ERROR_CODES)("never writes back a value %s refused", code => {
    const refused = "abandon ".repeat(11).concat("about");
    for (const tool of [...PRE_SEND, ...AFTER_SEND]) {
      const decision = errorDecision(new ActionError(code, "No.", { details: { field: "query" } }), {
        tool,
        args: { query: refused, deadlineMinutes: 5 },
      });
      expect(JSON.stringify(decision)).not.toContain("abandon");
    }
  });

  it("hands off a failure whose throw site named no field", () => {
    expect(failed("INVALID_AMOUNT", "sodax_swap_price").nextAction).toEqual({
      type: "external",
      reason: "service_unavailable",
    });
  });
});
