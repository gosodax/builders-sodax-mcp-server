/**
 * A reference runtime for the swap tools: what a client does with each result's `nextAction`, reading nothing else
 * (never `nextStep`). The tests drive it through whole swaps; the README quotes its loop.
 */

import type { CallTool, Exhausted, NextAction } from "../nextAction.js";

type Args = Record<string, unknown>;
export type ToolResult = Args & { status?: string; nextAction?: NextAction; terminal?: boolean; outcome?: string };
type PersonAction = Extract<NextAction, { type: "choose" | "provide" | "confirm" | "external" }>;

export interface Host {
  /** Calls a swap tool; returns its `structuredContent`. */
  call(tool: string, args: Args): Promise<ToolResult>;
  sleep(seconds: number): Promise<void>;
  now(): number;
  /**
   * Asks the user: `choose` and `provide` answer with arguments, `confirm` and `external` with true (done); undefined
   * or false declines.
   */
  ask(action: PersonAction, result: ToolResult): Promise<Args | boolean | undefined>;
  /** The wallet sends what `execute` points at, in order: the last step's hash, or the batch id `wallet_sendCalls` gave. */
  send(
    action: Extract<NextAction, { type: "execute" }>,
    result: ToolResult,
  ): Promise<{ hash: string } | { batchId: string }>;
  /** `wallet_getCallsStatus`: the batch's transaction hash, once it has one. */
  batchHash(batchId: string): Promise<string | undefined>;
  /** Kept across sessions: what was sent, so nothing is ever sent twice. */
  saved: Saved;
}

export interface Saved {
  /** The swap's track call, saved the moment its tx was broadcast (or its batch id returned). */
  swap?: { tool: string; args: Args; needs: string; hash?: string; batchId?: string };
  /** A cancel sent and not yet failed; once relayed, the bounded track that follows it. */
  cancel?: { args: Args; cancelTxHash: string; follow?: CallTool };
  /** Calls made per `retryKey`: a bound holds across sessions, so a restart never grants a fresh budget. */
  attempts?: Record<string, number>;
  /** The `retryKey` of the last call made, for a `consecutive` bound. */
  lastKey?: string;
}

export interface Ending {
  stop: "terminal" | "declined" | "handoff" | "no_contract";
  result: ToolResult;
  /** Where the funds ended up, when the workflow ended there: the result's, or the bound's that ran out. */
  outcome?: string;
}

type Next = { tool: string; args: Args } | Ending;

const BATCH_POLLS = 60;

// #region loop
export async function run(host: Host, start: { tool: string; args: Args }): Promise<Ending> {
  // What was sent resumes from what was saved: a cancel with its hash (or its track, once relayed), a swap with its
  // hash. Nothing is priced, signed or sent again; a batch with no hash yet is handed back until the wallet has one.
  const pending = host.saved.cancel;
  let call: Next | undefined;
  if (pending?.follow) call = await follow(host, {}, pending.follow, {});
  else if (pending) call = { tool: "sodax_swap_cancel", args: { ...pending.args, cancelTxHash: pending.cancelTxHash } };
  else call = host.saved.swap ? await resume(host) : start;
  if (!call) return { stop: "handoff", result: {} };
  if ("stop" in call) return call;
  for (;;) {
    // Saved before the call: a corrected hash or chain is what a resumed session uses.
    keepSent(host.saved, call);
    const result = await host.call(call.tool, call.args);
    keepCancel(host.saved, result);
    // No nextAction: an SDK refusal or an older server. Hand it off, keeping what was sent.
    if (!result.nextAction) return { stop: "no_contract", result };
    const next = await follow(host, result, result.nextAction, call.args);
    if ("stop" in next) return next;
    call = next;
  }
}

async function follow(
  host: Host,
  result: ToolResult,
  action: NextAction,
  callArgs: Args,
  answer: Args = {},
): Promise<Next> {
  const go = (next: NextAction, more: Args = answer) => follow(host, result, next, callArgs, more);
  const exhaust = async ({ nextAction, terminal, outcome }: Exhausted) => {
    const ending = await go(nextAction, {});
    return terminal && "stop" in ending ? { ...ending, stop: "terminal" as const, outcome } : ending;
  };
  switch (action.type) {
    case "none":
      return { stop: "terminal", result, outcome: result.outcome };
    case "call_tool": {
      // Bounded calls count per retryKey across the whole workflow, or stop at `until`.
      if (action.until && host.now() >= Date.parse(action.until) && action.onExhausted) {
        return exhaust(action.onExhausted);
      }
      if (action.maxAttempts !== undefined && action.retryKey && action.onExhausted) {
        host.saved.attempts ??= {};
        const attempts = host.saved.attempts;
        // A consecutive bound starts again after any other call: only failures in a row add up.
        if (action.consecutive && host.saved.lastKey !== action.retryKey) attempts[action.retryKey] = 0;
        const made = attempts[action.retryKey] ?? 0;
        if (made >= action.maxAttempts) return exhaust(action.onExhausted);
        attempts[action.retryKey] = made + 1;
      }
      host.saved.lastKey = action.retryKey;
      await host.sleep(action.afterSec);
      return { tool: action.tool, args: { ...(action.sameArgs ? callArgs : {}), ...action.args, ...answer } };
    }
    case "execute": {
      // Never start a send past the quote's expiry: prepare and confirm again instead.
      if (action.expiresAt && host.now() >= Date.parse(action.expiresAt)) return { stop: "handoff", result };
      return send(host, result, action);
    }
    case "confirm": {
      // A cancel already sent is followed, never sent twice.
      const pending = action.summary.kind === "cancel" ? host.saved.cancel : undefined;
      if (pending?.follow) return go(pending.follow, {});
      if (pending) return { tool: "sodax_swap_cancel", args: { ...pending.args, cancelTxHash: pending.cancelTxHash } };
      if ((await host.ask(action, result)) !== true) return { stop: "declined", result };
      return go(action.next);
    }
    case "choose":
    case "provide": {
      const given = await host.ask(action, result);
      if (typeof given !== "object") {
        return action.type === "provide" && action.onDecline ? exhaust(action.onDecline) : { stop: "declined", result };
      }
      return action.next ? go(action.next, { ...answer, ...given }) : { stop: "handoff", result };
    }
    case "external": {
      // Shown to the user before anything else: on a terminal result, this is the handoff. `next` runs only once the
      // person says they did what it asks.
      const done = await host.ask(action, result);
      if (action.next && done === true) return go(action.next);
      return result.terminal ? { stop: "terminal", result, outcome: result.outcome } : { stop: "handoff", result };
    }
    default:
      // A type this runtime doesn't know goes to a person.
      return { stop: "handoff", result };
  }
}
// #endregion loop

/** Sends, saves before anything else can fail, and calls back with the hash. */
async function send(host: Host, result: ToolResult, action: Extract<NextAction, { type: "execute" }>): Promise<Next> {
  const { tool, args, needs } = action.afterSend;
  const sent = await host.send(action, result);
  if (needs[0] === "cancelTxHash") {
    if (!("hash" in sent)) return { stop: "handoff", result };
    return { tool, args: { ...args, cancelTxHash: sent.hash } };
  }
  host.saved.swap = { tool, args: args ?? {}, needs: needs[0], ...sent };
  const hash = "hash" in sent ? sent.hash : await batchHash(host, sent.batchId);
  if (!hash) return { stop: "handoff", result };
  host.saved.swap.hash = hash;
  return { tool, args: { ...args, [needs[0]]: hash } };
}

/** A sent swap's track call from what was saved; a batch interrupted before its hash reads the wallet again. */
async function resume(host: Host): Promise<{ tool: string; args: Args } | undefined> {
  const swap = host.saved.swap;
  if (!swap) return undefined;
  const hash = swap.hash ?? (swap.batchId ? await batchHash(host, swap.batchId) : undefined);
  if (!hash) return undefined;
  swap.hash = hash;
  return { tool: swap.tool, args: { ...swap.args, [swap.needs]: hash } };
}

async function batchHash(host: Host, batchId: string): Promise<string | undefined> {
  for (let poll = 0; poll < BATCH_POLLS; poll++) {
    const hash = await host.batchHash(batchId);
    if (hash) return hash;
    await host.sleep(5);
  }
  return undefined;
}

/**
 * What a call says was sent, whoever gave the hash (the wallet, the user, the start): a track call is the swap's
 * latest arguments to resume with, a cancel call carrying a hash makes that cancel pending.
 */
function keepSent(saved: Saved, call: { tool: string; args: Args }): void {
  const { txHash, cancelTxHash, ...rest } = call.args;
  if (call.tool === "sodax_swap_submit_and_track" && typeof txHash === "string") {
    saved.swap = { tool: call.tool, args: rest, needs: "txHash", hash: txHash };
  }
  if (call.tool !== "sodax_swap_cancel" || typeof cancelTxHash !== "string") return;
  if (saved.cancel?.cancelTxHash !== cancelTxHash) saved.cancel = { args: { ...rest, txHash }, cancelTxHash };
}

/**
 * A relayed cancel is followed by its own bounded track. One that failed, wasn't the cancel, or is being replaced
 * by a new build (`ready`, once the wallet never sent it) leaves nothing pending.
 */
function keepCancel(saved: Saved, result: ToolResult): void {
  if (!saved.cancel) return;
  if (result.status === "cancel_relayed" && result.nextAction?.type === "call_tool") {
    saved.cancel.follow = result.nextAction;
  }
  if (["cancel_failed", "not_a_cancel_tx", "ready"].includes(String(result.status))) saved.cancel = undefined;
}
