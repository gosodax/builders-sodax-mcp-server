/**
 * The machine-readable half of every swap tool result: `nextAction` says what happens next and who does it,
 * `terminal` whether any tool call can still move the result on, and `outcome` where a sent swap ended up. A
 * runtime needs three branches: run a `call_tool`, stop on `none`, hand anything else to a person (or the wallet,
 * for `execute`), then follow its `next`. Each result's `nextStep` comes from the same decision, so the two can't
 * disagree. The continuation is `next`, never `then`: an object with a `then` reads as a promise in JavaScript.
 */

import type { ErrorOption } from "../services/swap/errors.js";

export type SwapToolName =
  | "sodax_resolve_token"
  | "sodax_get_balance"
  | "sodax_swap_price"
  | "sodax_swap_prepare"
  | "sodax_swap_submit_and_track"
  | "sodax_swap_cancel";

/** Where a sent swap's funds ended up, once nothing more can change it. */
export const OUTCOMES = ["succeeded", "cancelled", "refunding", "failed", "held", "unknown"] as const;
export type Outcome = (typeof OUTCOMES)[number];

/** Why a person has to act outside these tools. */
export type ExternalReason =
  | "help_desk"
  | "check_wallet"
  | "still_in_progress"
  | "destination_not_ready"
  | "wallet_setup"
  | "api_key"
  | "secret_exposed"
  | "service_unavailable";

/**
 * Call a tool, `afterSec` from now. `args` are complete when the result found the swap; `sameArgs` means the
 * arguments of the call that returned this action, as the runtime kept them, with `args` (and a person's answer)
 * on top. Unbounded, it's one call; with `until` or `maxAttempts` (counted per `retryKey` across the workflow) it
 * repeats while the result asks again, then follows `onExhausted`. A `consecutive` bound counts only calls in a row:
 * any other result in between starts it again, so scattered failures of a long swap never add up. A call a person's
 * answer leads back to is bounded too, under a key the answers don't change: an agent answering for them still stops.
 */
export interface CallTool {
  type: "call_tool";
  tool: SwapToolName;
  args?: Record<string, unknown>;
  sameArgs?: true;
  afterSec: number;
  until?: string;
  maxAttempts?: number;
  retryKey?: string;
  consecutive?: true;
  onExhausted?: Exhausted;
}

/** What follows when a bounded call runs out, or a person declines: a decision without its sentence. */
export type Exhausted = Omit<Decision, "nextStep">;

/** The user picks one option; its `args` go into `next`'s call. */
export interface Choose {
  type: "choose";
  field: string;
  options: ErrorOption[];
  next?: NextAction;
}

/** The user gives these values, keyed by field name, for `next`'s call. */
export interface Provide {
  type: "provide";
  fields: { name: string; format?: string; optional?: true }[];
  next?: NextAction;
  onDecline?: Exhausted;
}

interface Amount {
  amount: string;
  symbol: string;
  chain: string;
}

export type ConfirmSummary =
  | {
      kind: "swap";
      quoteId: string;
      expiresAt: string;
      send: Amount;
      receiveAtLeast: Amount;
      expected: { amount: string; symbol: string };
      recipient: string;
      partnerFee?: { amount: string; symbol: string };
      usdValue: string | null;
      usdOut: string | null;
      approve?: { spender: string; amount: string; symbol: string };
      warnings: ("usd_unchecked" | "above_warn_level" | "rate_unchecked" | "own_address_other_chain")[];
    }
  | { kind: "cancel"; chain: string; txHash: string }
  /** The wallet shows this cancel can never land, before a new one replaces it. */
  | { kind: "unsent_cancel"; chain: string; txHash: string; cancelTxHash: string }
  | { kind: "amount"; amount: string; symbol: string };

/**
 * The user agrees to what `summary` says before `next`. With `by: "wallet"` only the wallet's own record answers (a
 * person reading it there counts, an agent's yes doesn't): a tx can't land once its nonce went to another, or its
 * blockhash expired.
 */
export interface Confirm {
  type: "confirm";
  summary: ConfirmSummary;
  by?: "wallet";
  next: NextAction;
}

/**
 * The wallet sends the result's `steps` (or the `batch` in place of those it replaces) in order, each receipt a
 * success before the next; once the last is broadcast, `afterSend` runs with its hash, whatever its receipt says.
 * A bounded `afterSend` counts sends: it's counted before the wallet signs, and past it nothing is sent.
 */
export interface Execute {
  type: "execute";
  chain: string;
  stepsAt: "steps";
  batchAt?: "batch";
  waitFor: "receipt_success";
  expiresAt?: string;
  afterSend: CallTool & { on: "broadcast"; needs: ["txHash"] | ["cancelTxHash"] };
}

/** A person acts outside these tools, then `next`; if they don't, `onDecline`. */
export interface External {
  type: "external";
  reason: ExternalReason;
  next?: NextAction;
  onDecline?: Exhausted;
}

export interface None {
  type: "none";
}

export type NextAction = CallTool | Choose | Provide | Confirm | Execute | External | None;

/** One result's decision: the action, whether it's final, and the sentence that says the same. */
export interface Decision {
  nextStep: string;
  nextAction: NextAction;
  terminal: boolean;
  outcome?: Outcome;
}

export const NONE: None = { type: "none" };

/** A result nothing more can move on. */
export const final = (nextStep: string, nextAction: None | External, outcome?: Outcome): Decision => ({
  nextStep,
  ...exhausted(nextAction, true, outcome),
});

/** A result something can still move on. */
export const ongoing = (nextStep: string, nextAction: NextAction): Decision => ({
  nextStep,
  nextAction,
  terminal: false,
});

/** A call made once, `afterSec` from now. */
export const callOnce = (tool: SwapToolName, args: Record<string, unknown> | "same", afterSec = 0): CallTool => ({
  type: "call_tool",
  tool,
  ...(args === "same" ? { sameArgs: true as const } : { args }),
  afterSec,
});

/** A call repeated while the result asks again, at most `maxAttempts` times per `retryKey`. */
export const callRepeated = (
  call: CallTool,
  bound: { maxAttempts: number; retryKey: string; consecutive?: true } | { until: string },
  onExhausted: Exhausted,
): CallTool => ({ ...call, ...bound, onExhausted });

export const provide = (
  fields: (string | Provide["fields"][number])[],
  next?: NextAction,
  onDecline?: Exhausted,
): Provide => ({
  type: "provide",
  fields: fields.map(field => (typeof field === "string" ? { name: field } : field)),
  ...(next && { next }),
  ...(onDecline && { onDecline }),
});

/** A pick among options; with none to offer, the user names the value instead. */
export const choose = (field: string, options: Choose["options"], next?: NextAction): Choose | Provide =>
  options.length > 0 ? { type: "choose", field, options, ...(next && { next }) } : provide([field], next);

export const external = (reason: ExternalReason, next?: NextAction, onDecline?: Exhausted): External => ({
  type: "external",
  reason,
  ...(next && { next }),
  ...(onDecline && { onDecline }),
});

export const exhausted = (nextAction: NextAction, terminal: boolean, outcome?: Outcome): Exhausted => ({
  nextAction,
  terminal,
  ...(outcome && { outcome }),
});
