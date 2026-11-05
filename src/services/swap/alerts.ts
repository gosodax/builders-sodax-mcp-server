/**
 * Operator alerts: deposits on chain this server can't move on its own (an operator can relay or
 * refund them by hand), and swap tool errors that point at a bug or a broken upstream. Logged, and
 * posted to Discord when configured, at most once a day per kind and fields. They carry enums, chain
 * keys, hashes, ids and a short hash of the caller's key: never an address, the key or error text.
 */

import { SODAX_ENV } from "../../constants.js";
import { COLOR, postToDiscord, truncate } from "../discord.js";
import { logger, withoutUrls } from "../logger.js";
import { callerKeyHash } from "../requestContext.js";

export type AlertKind =
  | "unknown_quote"
  | "other_quote_deposit"
  | "other_sender_deposit"
  | "quote_used"
  | "multiple_deposits"
  | "refund_relay_failed"
  | "submit_rejected"
  | "swap_error";

const TITLES: Record<AlertKind, string> = {
  unknown_quote: "Swap deposit without its quote: relay it by hand",
  other_quote_deposit:
    "Swap deposit tracked under another quote of its sender's: relay it by hand if its own isn't tracked",
  other_sender_deposit: "Swap deposit sent from another address than its quote's: relay it by hand",
  quote_used: "Second deposit for one quote: it can't become a swap",
  multiple_deposits: "Swap deposit in a transaction with other deposits: relay it by hand",
  refund_relay_failed: "Expired swap deposit not relayed for refund",
  submit_rejected: "Checked swap deposit refused by submit-tx before its deadline: relay it by hand",
  swap_error: "Swap tool error: a bug, or the swap service built or priced something other than asked",
};

const DEDUPE_MS = 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 1_000;
// Discord allows 1024; a hash or a fixed reason fits well within this.
const FIELD_VALUE_MAX = 256;
// Past this many posts an hour the rest are only logged, and one post at the end of the hour counts
// them. Any key can name a made-up quoteId, or a quote for any sender, with a public deposit, so those
// alerts have their own small budget and can't crowd out the alerts on deposits this server checked.
const POSTS_PER_HOUR = { unknown_quote: 5, checked: 20 };
const PUBLIC_KINDS: readonly AlertKind[] = ["unknown_quote", "other_quote_deposit"];
const HOUR_MS = 60 * 60 * 1000;

type Budget = keyof typeof POSTS_PER_HOUR;

// Insertion order is age order; a repeat moves to the end.
const sent = new Map<string, number>();
let hourStart = Number.NEGATIVE_INFINITY;
let postsThisHour: Record<Budget, number> = { unknown_quote: 0, checked: 0 };
let suppressed = 0;
let summary: NodeJS.Timeout | undefined;

export function alertOperator(
  kind: AlertKind,
  fields: {
    chainKey?: string;
    txHash?: string;
    quoteId?: string;
    deadline?: string;
    tool?: string;
    code?: string;
    /** Which failure: a fixed message or an error class, never input or upstream text. */
    reason?: string;
  },
): void {
  // A deposit is the same alert whatever quoteId the agent passes; a tool error, per tool, code, reason and chain.
  const key = JSON.stringify(
    kind === "swap_error"
      ? [kind, fields.tool, fields.code, fields.reason, fields.chainKey]
      : [kind, fields.chainKey, fields.txHash],
  );
  const now = Date.now();
  const last = sent.get(key);
  if (last !== undefined && now - last < DEDUPE_MS) return;

  // Enough to tell callers apart, not to look a key up.
  const tagged = { ...fields, keyHash: callerKeyHash().slice(0, 12) };
  logger.error({ alert: kind, ...tagged }, TITLES[kind]);
  // Only a posted alert is deduped, so one held back by the budget is posted on a later call.
  if (!withinBudget(PUBLIC_KINDS.includes(kind) ? "unknown_quote" : "checked", now)) return;
  sent.delete(key);
  if (sent.size >= MAX_ENTRIES) sent.delete(sent.keys().next().value ?? "");
  sent.set(key, now);
  const embedFields = Object.entries({ env: SODAX_ENV, ...tagged })
    .filter(([, value]) => value !== undefined)
    // Fields carry no error text by contract; this keeps a slip from posting a URL or a wall of text.
    .map(([name, value]) => ({
      name,
      value: truncate(withoutUrls(String(value)), FIELD_VALUE_MAX),
      inline: name !== "txHash",
    }));
  post(`🚨 ${TITLES[kind]}`, embedFields);
}

function withinBudget(budget: Budget, now: number): boolean {
  if (now - hourStart >= HOUR_MS) {
    hourStart = now;
    postsThisHour = { unknown_quote: 0, checked: 0 };
  }
  if (postsThisHour[budget] < POSTS_PER_HOUR[budget]) {
    postsThisHour[budget]++;
    return true;
  }
  suppressed++;
  summary ??= setTimeout(postSuppressed, hourStart + HOUR_MS - now).unref();
  return false;
}

function postSuppressed(): void {
  logger.error({ suppressed }, "Swap alerts over the hourly budget were only logged");
  post(`🚨 ${suppressed} more swap alerts in the last hour, only logged`, [
    { name: "env", value: SODAX_ENV, inline: true },
  ]);
  suppressed = 0;
  summary = undefined;
}

function post(title: string, fields: { name: string; value: string; inline: boolean }[]): void {
  void postToDiscord({ embeds: [{ title, color: COLOR.red, fields, timestamp: new Date().toISOString() }] });
}

export function clearAlerts(): void {
  sent.clear();
  clearTimeout(summary);
  summary = undefined;
  hourStart = Number.NEGATIVE_INFINITY;
  postsThisHour = { unknown_quote: 0, checked: 0 };
  suppressed = 0;
}
