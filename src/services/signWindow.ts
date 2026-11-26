/**
 * What the swap quote cache and the bridge store share about a record not yet sent: it's offered for signing for
 * `SIGN_WINDOW_MS`, a track call with a well-formed hash holds it `TRACK_HOLD_MS` from that call, and one with no
 * deposit past both gives way when a new one needs the room. Each store keeps its own records, caps and retention.
 */

export const SIGN_WINDOW_MS = 5 * 60 * 1000;
// What a track call buys, as preparing does: a deposit not mined yet is polled well within it, each call renewing it.
const TRACK_HOLD_MS = 5 * 60 * 1000;
// Keys cost nothing to make up: one client can't fill a store whatever keys it sends.
export const MAX_OPEN_PER_CLIENT = 100;
/** The sign window, as a refusal tells it. */
export const SIGN_WINDOW_TEXT = `${SIGN_WINDOW_MS / 60_000} minutes`;

interface Unsent {
  signBy: number;
  heldUntil?: number;
  depositTxHash?: string;
}

/** When a record with no deposit can give way: its sign-by, or the end of a track call's hold. */
export const freesAt = (record: Unsent) => Math.max(record.signBy, record.heldUntil ?? 0);

/** No deposit, past its sign-by, and no track call holding it: what the user was told to send by has passed. */
export const releasable = (record: Unsent, now: number) => record.depositTxHash === undefined && freesAt(record) <= now;

/** Named by a track or cancel call with a well-formed hash: it stays `TRACK_HOLD_MS` from now, room or not. */
export function holdForTrack(record: Unsent): void {
  record.heldUntil = Date.now() + TRACK_HOLD_MS;
}

/** Seconds until `at`, at least one: how long a refusal tells the agent to wait. */
export const secondsUntil = (at: number, now: number) => Math.max(1, Math.ceil((at - now) / 1000));

/** Counts `id` among its owner's records not yet sent. */
export function addOpen(byOwner: Map<string, Set<string>>, owner: string, id: string): void {
  byOwner.set(owner, (byOwner.get(owner) ?? new Set()).add(id));
}

/** No longer counts `id` among its owner's records not yet sent, nor the owner once it has none. */
export function removeOpen(byOwner: Map<string, Set<string>>, owner: string, id: string): void {
  const open = byOwner.get(owner);
  open?.delete(id);
  if (open?.size === 0) byOwner.delete(owner);
}
