import { describe, expect, it } from "vitest";
import { BRIDGE_HELP } from "../constants.js";
import type { BridgeTrack } from "../services/bridge/track.js";
import { forBridge } from "../services/bridge/wording.js";
import type { BalanceResult } from "../services/swap/balance.js";
import { ACTION_ERROR_CODES, ActionError } from "../services/swap/errors.js";
import {
  ARBITRUM,
  BASE,
  BRIDGE_ID,
  HUB_TX,
  NON_EVM_READY,
  PAIRS,
  PREVIEW,
  READY,
  SONIC,
  TX,
  type TrackState,
  failure,
  listed,
  prepared,
  previewed,
  ref,
  tracked,
} from "./__fixtures__/bridgeResults.js";
import { actionsOf, contractBreaks, unboundedAnswers, unboundedTopCall } from "./__fixtures__/nextActionChecks.js";
import type { ToolResult } from "./__fixtures__/nextActionRuntime.js";
import { pairsDecision, trackDecision } from "./bridgeDecisions.js";
import type { CallTool, Decision, SwapToolName } from "./nextAction.js";
import { balanceDecision, errorDecision } from "./swapDecisions.js";

const TRACK = "sodax_bridge_submit_and_track";
const TOOLS: SwapToolName[] = ["sodax_bridge_tokens", "sodax_bridge_preview", "sodax_bridge_prepare", TRACK];
const decided = (result: ToolResult) => result as unknown as Decision;
type Refusal = Extract<BridgeTrack, { status: "not_submitted" }>["reason"];
const REFUSALS: Record<Refusal, true> = {
  not_this_bridge: true,
  unverified: true,
  unknown_bridge: true,
  bridge_used: true,
  submitted_differently: true,
  submit_refused: true,
  multiple_messages: true,
};
// A new service status must have at least one decision case here.
const STATES: { [Status in TrackState["status"]]: Extract<TrackState, { status: Status }>[] } = {
  awaiting_source: [
    { status: "awaiting_source", seenOnChain: true },
    { status: "awaiting_source", seenOnChain: false },
  ],
  source_failed: [{ status: "source_failed" }],
  not_submitted: (Object.keys(REFUSALS) as Refusal[]).flatMap(reason =>
    [true, false].map(alerted => ({ status: "not_submitted" as const, reason, alerted })),
  ),
  relaying: [{ status: "relaying" }],
  relay_failed: [true, false].map(alerted => ({ status: "relay_failed", alerted })),
  in_transit: [{ status: "in_transit", hubTxHash: HUB_TX }],
  delivered: [
    { status: "delivered", dstTxHash: HUB_TX, delivery: "delivered" },
    { status: "delivered", dstTxHash: "destination-tx", delivery: "sent" },
  ],
  held_on_hub: [
    { status: "held_on_hub", hubTxHash: HUB_TX, alerted: false },
    {
      status: "held_on_hub",
      hubTxHash: HUB_TX,
      alerted: true,
      recovery: { srcChainKey: ARBITRUM.key, srcAddress: READY.fromAddress, token: READY.from.address },
    },
  ],
};
const TRACKED: [string, Decision][] = Object.values(STATES).flatMap(states =>
  states.flatMap((state, i) =>
    [ARBITRUM, SONIC].map((chain): [string, Decision] => [
      `track ${state.status} ${i} ${chain.key}`,
      decided(tracked(state, ref(chain))),
    ]),
  ),
);
const LOOKUPS: [string, Decision][] = [
  ["tokens", decided(listed())],
  ["tokens empty", decided(listed({ ...PAIRS, pairs: [] }))],
  ["preview", decided(previewed())],
  ["preview non-EVM", decided(previewed({ ...PREVIEW, prepareNeeds: ["fromAddress", "toAddress"] }))],
  ["prepare", decided(prepared())],
  ["prepare non-EVM", decided(prepared(NON_EVM_READY))],
  ["prepare without approve", decided(prepared({ ...READY, steps: READY.steps.slice(-1), batch: undefined }))],
  [
    "prepare with fee",
    decided(
      prepared({ ...READY, partnerFee: { amount: "0.05", symbol: "USDC" }, to: { ...READY.to, amount: "4.95" } }),
    ),
  ],
];
const ERRORS: [string, Decision][] = TOOLS.flatMap(tool =>
  ACTION_ERROR_CODES.map(
    code =>
      [
        `${tool} ${code}`,
        decided(failure(code, tool, { amount: "5" }, { field: tool === TRACK ? "txHash" : "amount" })),
      ] as [string, Decision],
  ),
);
const SPECIAL_ERRORS: [string, ActionError][] = [
  [
    "pair",
    new ActionError("BRIDGE_REJECTED", "No.", {
      details: { reason: "not_bridgeable", field: "toToken" },
      hint: { options: [{ label: "USDC", args: { toToken: "0xtoken" } }] },
    }),
  ],
  ["chain", new ActionError("BRIDGE_REJECTED", "No.", { details: { reason: "same_chain", field: "toChain" } })],
  ["limit", new ActionError("BRIDGE_REJECTED", "No.", { details: { reason: "above_limit", field: "amount" } })],
  ["capacity", new ActionError("BRIDGE_REJECTED", "No.", { details: { reason: "no_capacity" } })],
  [
    "wallet",
    new ActionError("BRIDGE_REJECTED", "No.", {
      details: { reason: "wallet_cannot_build" },
      hint: { balance: { chain: "solana", address: "wallet", token: "native", for: "bridge" } },
    }),
  ],
  ["recipient", new ActionError("INVALID_ADDRESS", "No.", { details: { missing: ["fromAddress", "toAddress"] } })],
  ["amount", new ActionError("AMOUNT_TOO_LOW", "No.", { details: { suggestedAmount: "1", symbol: "USDC" } })],
  ["unreadable token", new ActionError("UNKNOWN_TOKEN", "No.", { details: { reason: "unreadable" } })],
  // A code that usually passes, which its throw site says won't: handed off in the tool's own words.
  ["won't pass", new ActionError("UPSTREAM_UNAVAILABLE", "No.", { retryable: false })],
];
// The token tools serve both: a lookup or a read for a bridge fails, and reads, in a bridge's words.
const FOR_BRIDGE = (["sodax_resolve_token", "sodax_get_balance"] as const).flatMap(tool =>
  [...SPECIAL_ERRORS, ["internal", new ActionError("INTERNAL", "No.")] as const].map(
    ([name, error]): [string, Decision] => [
      `${tool} for a bridge ${name}`,
      errorDecision(forBridge(error), { tool, args: { for: "bridge" } }),
    ],
  ),
);
const NATIVE = { symbol: "ETH", address: "0x0", amount: "1", baseUnits: "1" };
const ALL = [
  ...LOOKUPS,
  ...TRACKED,
  ...ERRORS,
  ...TOOLS.flatMap(tool =>
    SPECIAL_ERRORS.map(([name, error]): [string, Decision] => [
      `${tool} ${name}`,
      errorDecision(forBridge(error), { tool, args: {} }),
    ]),
  ),
  ...FOR_BRIDGE,
  [
    "a native balance for a bridge",
    balanceDecision(
      {
        chain: { key: "0xa4b1.arbitrum", name: "Arbitrum" },
        native: NATIVE,
        token: NATIVE,
      } as unknown as BalanceResult,
      "bridge",
    ),
  ],
];

describe("every bridge decision", () => {
  it.each(ALL)("%s keeps the contract", (_, decision) => {
    expect(contractBreaks(decision)).toEqual([]);
  });

  it.each(ALL)("%s makes no unbounded call that can loop", (_, decision) => {
    const call = unboundedTopCall(decision);
    // A wallet build refusal reads a balance, whose result is terminal.
    if (call) expect(call.tool).toBe("sodax_get_balance");
  });

  it.each(ALL)("%s bounds every call an answer leads back to", (name, decision) => {
    const calls = unboundedAnswers(decision.nextAction);
    // These advance to a different tool; neither destination returns to its caller.
    const forward =
      name === "tokens" ? "sodax_bridge_preview" : name.startsWith("preview") ? "sodax_bridge_prepare" : undefined;
    expect(calls.every(call => call.tool === forward)).toBe(true);
  });

  // The decisions shared with the swap tools take their words from the tool: a bridge's never names a swap, but in the
  // help desk's line, which covers both.
  it.each(ALL)("%s never names a swap", (_, decision) => {
    expect(decision.nextStep.replace(BRIDGE_HELP, "")).not.toMatch(/\bswaps?\b/i);
  });

  it.each(TRACKED)("%s keeps the canonical bridge when it calls again", (_, decision) => {
    for (const action of actionsOf(decision.nextAction)) {
      if (action.type !== "call_tool" || action.tool !== TRACK) continue;
      if (action.sameArgs) continue;
      expect(action.args).toMatchObject({
        bridgeId: BRIDGE_ID,
        chain: expect.stringMatching(/^(sonic|0xa4b1.arbitrum)$/),
      });
      expect(action.args).not.toHaveProperty("txHash");
    }
  });
});

describe("bridge choices", () => {
  it("asks for a pair, then an amount, before previewing its canonical addresses", () => {
    expect(pairsDecision(PAIRS)).toMatchObject({
      terminal: false,
      nextAction: {
        type: "choose",
        options: [
          {
            args: {
              fromChain: ARBITRUM.key,
              toChain: BASE.key,
              fromToken: READY.from.address,
              toToken: READY.to.address,
            },
          },
        ],
        next: {
          type: "provide",
          fields: [{ name: "amount" }],
          next: { type: "call_tool", tool: "sodax_bridge_preview" },
        },
      },
    });
  });

  it("distinguishes pairs with the same symbols by their addresses", () => {
    const second = { ...PAIRS.pairs[0], from: { ...PAIRS.pairs[0].from, address: "0xother" } };
    const action = pairsDecision({ ...PAIRS, pairs: [...PAIRS.pairs, second] }).nextAction;
    if (action.type !== "choose") throw new Error("expected pair choices");
    expect(new Set(action.options.map(option => option.label)).size).toBe(2);
    expect(action.options[1].args.fromToken).toBe("0xother");
  });

  it("keeps the hash-correction budget stable when the answers change", () => {
    const first = trackDecision({ ...ref(), status: "not_submitted", reason: "not_this_bridge", alerted: false });
    const other = trackDecision({
      ...ref(SONIC, HUB_TX),
      status: "not_submitted",
      reason: "not_this_bridge",
      alerted: false,
    });
    const retry = (decision: Decision) =>
      actionsOf(decision.nextAction).find((action): action is CallTool => action.type === "call_tool");
    expect(retry(first)).toMatchObject({
      args: { bridgeId: BRIDGE_ID, chain: ARBITRUM.key },
      maxAttempts: 3,
      retryKey: `${TRACK}:ask:txHash`,
      onExhausted: { nextAction: { type: "external", reason: "help_desk" }, terminal: false },
    });
    expect(retry(other)?.retryKey).toBe(retry(first)?.retryKey);
    expect(JSON.stringify(first.nextAction)).not.toContain(TX);
  });
});
