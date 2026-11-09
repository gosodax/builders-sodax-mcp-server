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

export type AlertKind =
  | "unknown_quote"
  | "other_quote_deposit"
  | "other_sender_deposit"
  | "quote_used"
  | "multiple_deposits"
  | "refund_relay_failed"
  | "submit_rejected";

const TITLES: Record<AlertKind, string> = {
  unknown_quote: "Swap deposit without its quote: relay it by hand",
  other_quote_deposit:
    "Swap deposit tracked under another quote of its sender's: relay it by hand if its own isn't tracked",
  other_sender_deposit: "Swap deposit sent from another address than its quote's: relay it by hand",
  quote_used: "Second deposit for one quote: it can't become a swap",
  multiple_deposits: "Swap deposit in a transaction with other deposits: relay it by hand",
  refund_relay_failed: "Expired swap deposit not relayed for refund",
  submit_rejected: "Checked swap deposit refused by submit-tx before its deadline: relay it by hand",
};

const DEDUPE_MS = 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 1_000;
// Past this many posts an hour an alert is held, and the hour ends with one post listing the held ones.
// Any key can name a made-up quoteId, or a quote for any sender, with a public deposit, so those
// alerts have their own small budget and can't crowd out the alerts on deposits this server checked.
const POSTS_PER_HOUR = { public: 5, checked: 20 };
// Held alerts listed per budget in that post (it fits Discord's 4096-character description); past this, only logged.
const MAX_HELD = 12;
const PUBLIC_KINDS: readonly AlertKind[] = ["unknown_quote", "other_quote_deposit"];
const HOUR_MS = 60 * 60 * 1000;

type Budget = keyof typeof POSTS_PER_HOUR;

// Insertion order is age order; a repeat moves to the end. `reached`: posted or held, not only logged.
const sent = new Map<string, { at: number; reached: boolean }>();
let hourStart = Number.NEGATIVE_INFINITY;
let postsThisHour: Record<Budget, number> = { public: 0, checked: 0 };
let held: Record<Budget, string[]> = { public: [], checked: [] };
let dropped = 0;
let summary: NodeJS.Timeout | undefined;

/**
 * Logs the alert and posts it, or holds it for the hourly post when its budget is spent. False when
 * it was neither posted nor held (that post is full): only the log has it.
 */
export function alertOperator(
  kind: AlertKind,
  fields: { chainKey: string; txHash: string; quoteId?: string; deadline?: string },
): boolean {
  const key = `${kind}:${fields.chainKey}:${fields.txHash}`;
  const now = Date.now();
  const last = sent.get(key);
  // One that reached only the log is tried again after the hour, when the budget is new.
  if (last && now - last.at < (last.reached ? DEDUPE_MS : HOUR_MS)) return last.reached;

  // Enough to tell callers apart, not to look a key up.
  const tagged = { ...fields, keyHash: callerKeyHash().slice(0, 12) };
  logger.error({ alert: kind, ...tagged }, TITLES[kind]);
  const budget = PUBLIC_KINDS.includes(kind) ? "public" : "checked";
  const verdict = spend(budget, now);
  sent.delete(key);
  if (sent.size >= MAX_ENTRIES) sent.delete(sent.keys().next().value ?? "");
  sent.set(key, { at: now, reached: verdict !== "drop" });
  if (verdict === "drop") return false;
  if (verdict === "hold") {
    const deadline = fields.deadline && `deadline ${fields.deadline}`;
    held[budget].push([kind, fields.chainKey, fields.txHash, fields.quoteId, deadline].filter(Boolean).join(" · "));
    return true;
  }
  const embedFields = Object.entries({ env: SODAX_ENV, ...tagged })
    .filter(([, value]) => value !== undefined)
    .map(([name, value]) => ({ name, value: String(value), inline: name !== "txHash" }));
  post(`🚨 ${TITLES[kind]}`, embedFields);
  return true;
}

function spend(budget: Budget, now: number): "post" | "hold" | "drop" {
  if (now - hourStart >= HOUR_MS) {
    hourStart = now;
    postsThisHour = { public: 0, checked: 0 };
  }
  if (postsThisHour[budget] < POSTS_PER_HOUR[budget]) {
    postsThisHour[budget]++;
    return "post";
  }
  summary ??= setTimeout(postHeld, hourStart + HOUR_MS - now).unref();
  if (held[budget].length < MAX_HELD) return "hold";
  dropped++;
  return "drop";
}

function postHeld(): void {
  const lines = [...held.checked, ...held.public];
  logger.error({ held: lines.length, dropped }, "Swap alerts over the hourly budget");
  const count = lines.length + dropped;
  if (dropped > 0) lines.push(`${dropped} more only in the logs (alert: <kind>)`);
  post(
    `🚨 ${count} more swap alerts in the last hour, held back by the hourly cap`,
    [{ name: "env", value: SODAX_ENV, inline: true }],
    lines.join("\n"),
  );
  held = { public: [], checked: [] };
  dropped = 0;
  summary = undefined;
}

function post(title: string, fields: { name: string; value: string; inline: boolean }[], description?: string): void {
  void postToDiscord({
    embeds: [{ title, description, color: COLOR.red, fields, timestamp: new Date().toISOString() }],
  });
}

export function clearAlerts(): void {
  sent.clear();
  clearTimeout(summary);
  summary = undefined;
  hourStart = Number.NEGATIVE_INFINITY;
  postsThisHour = { public: 0, checked: 0 };
  held = { public: [], checked: [] };
  dropped = 0;
}
