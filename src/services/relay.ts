/**
 * SODAX Intent Relay Service
 *
 * Client for the cross-chain message relayer used by SODAX intents.
 * Hosted on ICON's xCall infrastructure at xcall-relay.nw.iconblockchain.xyz.
 *
 * All requests are POST / with `{ action, params }` in the body; the
 * action dispatches to one of three operations:
 *   - submit                   (queue a spoke-chain tx for relaying)
 *   - get_transaction_packets  (list packets emitted by a tx)
 *   - get_packet               (fetch a single packet by conn_sn)
 *
 * chain_id values are intent-relay chain IDs (decimal strings), not the
 * formal spoke chain keys — use sodax_get_relay_chain_id_map to translate.
 */

import { SODAX_RELAY_BASE_URL } from "../constants.js";
import type { RelayGetPacketResponse, RelayPacketsResponse, RelaySubmitResponse } from "../types.js";
import { logger } from "./logger.js";

interface SubmitParams {
  chain_id: string;
  tx_hash: string;
  data?: {
    address: string;
    payload: string;
  };
}

interface GetTransactionPacketsParams {
  chain_id: string;
  tx_hash: string;
}

interface GetPacketParams {
  chain_id: string;
  tx_hash: string;
  conn_sn: string;
}

const RELAY_TIMEOUT_MS = 30_000;

/**
 * The relay answers every action on `POST /`, and it uses HTTP 404 as a normal
 * "packet not found" outcome for `get_packet` / `get_transaction_packets`,
 * returning a well-formed `{ success: false, message }` JSON body. That single
 * case is the only non-2xx we parse instead of throwing.
 *
 * SECURITY / correctness (audit solver-relay-clients:M-1): this used to throw
 * only on HTTP >= 500 and parse *every* other status, so 400/401/403/429 came
 * back looking like a successful response — most dangerously on `submit`, the
 * one state-changing action, where a rejected submission was reported to the
 * caller as if it had been accepted. Every non-2xx now raises, and a non-JSON
 * body (an edge/WAF HTML 401 or 429 page, say) reports the HTTP status rather
 * than a confusing "Unexpected token '<'" JSON parse error.
 *
 * Error-message policy mirrors services/http.ts: the message is treated as a
 * *public* string and carries only the HTTP status and the relay action name.
 * No bytes of the upstream response body and no full URL are interpolated.
 */
async function callRelay<T>(action: string, params: unknown): Promise<T> {
  const response = await fetch(`${SODAX_RELAY_BASE_URL}/`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ action, params }),
    signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
  });

  const status = `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`;
  const text = await response.text().catch(() => "");

  const parse = (): T | undefined => {
    try {
      return JSON.parse(text) as T;
    } catch {
      return undefined;
    }
  };

  if (!response.ok) {
    // 404 with the relay's documented `{success:false,...}` JSON body is a
    // normal "not found" answer, not a transport failure — hand it back.
    if (response.status === 404) {
      const parsed = parse() as { success?: unknown } | undefined;
      if (parsed && typeof parsed === "object" && parsed.success === false) {
        return parsed as T;
      }
    }
    throw new Error(`${status} from relay action ${action}`);
  }

  const parsed = parse();
  if (parsed === undefined) {
    throw new Error(`${status} from relay action ${action} — response was not valid JSON`);
  }
  return parsed;
}

/**
 * Submit a spoke-chain tx to the relay so it can be delivered to the
 * destination chain. `data` is required only for split-tx chains
 * (Solana, Bitcoin). The tx must already be confirmed on the source chain.
 */
export async function submitRelayTx(params: SubmitParams): Promise<RelaySubmitResponse> {
  try {
    return await callRelay<RelaySubmitResponse>("submit", params);
  } catch (error) {
    logger.error({ err: error }, "Error submitting relay tx");
    throw new Error(`Failed to submit relay tx: ${error instanceof Error ? error.message : "Unknown error"}`);
  }
}

/**
 * List every cross-chain packet emitted by the given source transaction.
 * Use this to track relay status — a packet is complete when status === "executed".
 */
export async function getRelayTransactionPackets(params: GetTransactionPacketsParams): Promise<RelayPacketsResponse> {
  try {
    return await callRelay<RelayPacketsResponse>("get_transaction_packets", params);
  } catch (error) {
    logger.error({ err: error }, "Error fetching relay transaction packets");
    throw new Error(
      `Failed to fetch relay transaction packets: ${error instanceof Error ? error.message : "Unknown error"}`,
    );
  }
}

/**
 * Fetch a single packet by its connection serial number (conn_sn).
 * Returns either the packet data or a failure message — both shapes
 * are surfaced to the caller without throwing.
 */
export async function getRelayPacket(params: GetPacketParams): Promise<RelayGetPacketResponse> {
  try {
    return await callRelay<RelayGetPacketResponse>("get_packet", params);
  } catch (error) {
    logger.error({ err: error }, "Error fetching relay packet");
    throw new Error(`Failed to fetch relay packet: ${error instanceof Error ? error.message : "Unknown error"}`);
  }
}
