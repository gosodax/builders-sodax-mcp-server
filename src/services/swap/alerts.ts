/**
 * Operator alerts for deposits on chain that this server can't move on its own: an operator can
 * relay or refund them by hand. Logged, and posted to Discord when configured, at most once a day
 * per kind and tx. They carry the chain, tx hash, quote id and deadline, never an address.
 */

import { SODAX_ENV } from "../../constants.js";
import { COLOR, postToDiscord } from "../discord.js";
import { logger } from "../logger.js";

export type AlertKind = "unknown_quote" | "quote_used" | "refund_relay_failed";

const TITLES: Record<AlertKind, string> = {
  unknown_quote: "Swap deposit without its quote: relay it by hand",
  quote_used: "Second deposit for one quote: it can't become a swap",
  refund_relay_failed: "Expired swap deposit not relayed for refund",
};

const DEDUPE_MS = 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 1_000;

// Insertion order is age order; a repeat moves to the end.
const sent = new Map<string, number>();

export function alertOperator(
  kind: AlertKind,
  fields: { chainKey: string; txHash: string; quoteId?: string; deadline?: string },
): void {
  const key = `${kind}:${fields.chainKey}:${fields.txHash}`;
  const now = Date.now();
  const last = sent.get(key);
  if (last !== undefined && now - last < DEDUPE_MS) return;
  sent.delete(key);
  if (sent.size >= MAX_ENTRIES) sent.delete(sent.keys().next().value ?? "");
  sent.set(key, now);

  logger.error({ alert: kind, ...fields }, TITLES[kind]);
  const embedFields = Object.entries({ env: SODAX_ENV, ...fields })
    .filter(([, value]) => value !== undefined)
    .map(([name, value]) => ({ name, value: String(value), inline: name !== "txHash" }));
  void postToDiscord({
    embeds: [
      { title: `🚨 ${TITLES[kind]}`, color: COLOR.red, fields: embedFields, timestamp: new Date().toISOString() },
    ],
  });
}

export function clearAlerts(): void {
  sent.clear();
}
