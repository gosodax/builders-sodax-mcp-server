/**
 * Operator alerts for deposits on chain that this server can't move on its own: an operator can
 * relay or refund them by hand. Logged, and posted to Discord when configured, at most once a day
 * per kind and tx. They carry the chain, tx hash, quote id, deadline and a short hash of the
 * caller's key, never an address or the key.
 */

import { SODAX_ENV } from "../../constants.js";
import { COLOR, postToDiscord } from "../discord.js";
import { logger } from "../logger.js";
import { callerKeyHash } from "../requestContext.js";

export type AlertKind = "unknown_quote" | "quote_used" | "refund_relay_failed" | "submit_rejected";

const TITLES: Record<AlertKind, string> = {
  unknown_quote: "Swap deposit without its quote: relay it by hand",
  quote_used: "Second deposit for one quote: it can't become a swap",
  refund_relay_failed: "Expired swap deposit not relayed for refund",
  submit_rejected: "Checked swap deposit refused by submit-tx before its deadline: relay it by hand",
};

const DEDUPE_MS = 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 1_000;
// Past this many posts an hour the rest are only logged, and one post at the end of the hour counts
// them. Any key can name a made-up quoteId for a public deposit, so unknown_quote has its own small
// budget and can't crowd out the alerts on deposits this server checked.
const POSTS_PER_HOUR = { unknown_quote: 5, checked: 20 };
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
  fields: { chainKey: string; txHash: string; quoteId?: string; deadline?: string },
): void {
  const key = `${kind}:${fields.chainKey}:${fields.txHash}`;
  const now = Date.now();
  const last = sent.get(key);
  if (last !== undefined && now - last < DEDUPE_MS) return;

  // Enough to tell callers apart, not to look a key up.
  const tagged = { ...fields, keyHash: callerKeyHash().slice(0, 12) };
  logger.error({ alert: kind, ...tagged }, TITLES[kind]);
  // Only a posted alert is deduped, so one held back by the budget is posted on a later call.
  if (!withinBudget(kind === "unknown_quote" ? "unknown_quote" : "checked", now)) return;
  sent.delete(key);
  if (sent.size >= MAX_ENTRIES) sent.delete(sent.keys().next().value ?? "");
  sent.set(key, now);
  const embedFields = Object.entries({ env: SODAX_ENV, ...tagged })
    .filter(([, value]) => value !== undefined)
    .map(([name, value]) => ({ name, value: String(value), inline: name !== "txHash" }));
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
