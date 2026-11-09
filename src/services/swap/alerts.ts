/**
 * Operator alerts: deposits on chain this server can't move on its own (an operator can relay or
 * refund them by hand), and swap tool errors that point at a bug or a broken upstream. Logged, and
 * posted to Discord when configured, at most once a day per kind and fields. They carry enums, chain
 * keys, hashes, ids and a short hash of the caller's key: never an address, the key or error text.
 */

import { SODAX_ENV } from "../../constants.js";
import { COLOR, postToDiscord, truncate } from "../discord.js";
import { logger, redact } from "../logger.js";
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
// Past this many posts an hour an alert is held, and the hour ends with one post listing the held ones.
// Any key can name a made-up quoteId, or a quote for any sender, with a public deposit, so those
// alerts have their own small budget and can't crowd out the alerts on deposits this server checked;
// so do tool errors.
const POSTS_PER_HOUR = { public: 5, checked: 20, tools: 5 };
// Held alerts listed per budget in that post; past this, only logged.
const MAX_HELD = 12;
// Discord's limit on that post's description; the deposits this server checked are listed first.
const HELD_TEXT_MAX = 4096;
const PUBLIC_KINDS: readonly AlertKind[] = ["unknown_quote", "other_quote_deposit"];
const HOUR_MS = 60 * 60 * 1000;

type Budget = keyof typeof POSTS_PER_HOUR;

// Insertion order is age order; a repeat moves to the end. `reached`: posted or held, not only logged.
const sent = new Map<string, { at: number; reached: boolean }>();
let hourStart = Number.NEGATIVE_INFINITY;
let postsThisHour: Record<Budget, number> = { public: 0, checked: 0, tools: 0 };
let held: Record<Budget, string[]> = { public: [], checked: [], tools: [] };
let dropped = 0;
let summary: NodeJS.Timeout | undefined;

/**
 * Logs the alert and posts it, or holds it for the hourly post when its budget is spent. False when
 * it was neither posted nor held (that post is full): only the log has it.
 */
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
): boolean {
  // A deposit is the same alert whatever quoteId the agent passes; a tool error, per tool, code, reason and chain.
  const key = JSON.stringify(
    kind === "swap_error"
      ? [kind, fields.tool, fields.code, fields.reason, fields.chainKey]
      : [kind, fields.chainKey, fields.txHash],
  );
  const now = Date.now();
  const last = sent.get(key);
  // One that reached only the log is tried again after the hour, when the budget is new.
  if (last && now - last.at < (last.reached ? DEDUPE_MS : HOUR_MS)) return last.reached;

  // Enough to tell callers apart, not to look a key up.
  const tagged = { ...fields, keyHash: callerKeyHash().slice(0, 12) };
  logger.error({ alert: kind, ...tagged }, TITLES[kind]);
  const budget: Budget = kind === "swap_error" ? "tools" : PUBLIC_KINDS.includes(kind) ? "public" : "checked";
  const verdict = spend(budget, now);
  sent.delete(key);
  if (sent.size >= MAX_ENTRIES) sent.delete(sent.keys().next().value ?? "");
  sent.set(key, { at: now, reached: verdict !== "drop" });
  if (verdict === "drop") return false;
  if (verdict === "hold") {
    const parts =
      kind === "swap_error"
        ? [kind, fields.tool, fields.code, fields.reason, fields.chainKey]
        : [kind, fields.chainKey, fields.txHash, fields.quoteId, fields.deadline && `deadline ${fields.deadline}`];
    // As the embed fields: a slip can't put a URL or a wall of text in the post.
    held[budget].push(truncate(redact(parts.filter(Boolean).join(" · ")), FIELD_VALUE_MAX));
    return true;
  }
  const embedFields = Object.entries({ env: SODAX_ENV, ...tagged })
    .filter(([, value]) => value !== undefined)
    // Fields carry no error text by contract; this keeps a slip from posting a URL or a wall of text.
    .map(([name, value]) => ({
      name,
      value: truncate(redact(String(value)), FIELD_VALUE_MAX),
      inline: name !== "txHash",
    }));
  post(`🚨 ${TITLES[kind]}`, embedFields);
  return true;
}

function spend(budget: Budget, now: number): "post" | "hold" | "drop" {
  if (now - hourStart >= HOUR_MS) {
    hourStart = now;
    postsThisHour = { public: 0, checked: 0, tools: 0 };
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
  const lines = [...held.checked, ...held.public, ...held.tools];
  logger.error({ held: lines.length, dropped }, "Swap alerts over the hourly budget");
  const count = lines.length + dropped;
  if (dropped > 0) lines.push(`${dropped} more only in the logs (alert: <kind>)`);
  post(
    `🚨 ${count} more swap alerts in the last hour, held back by the hourly cap`,
    [{ name: "env", value: SODAX_ENV, inline: true }],
    truncate(lines.join("\n"), HELD_TEXT_MAX),
  );
  held = { public: [], checked: [], tools: [] };
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
  postsThisHour = { public: 0, checked: 0, tools: 0 };
  held = { public: [], checked: [], tools: [] };
  dropped = 0;
}
