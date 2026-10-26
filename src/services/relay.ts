/**
 * SODAX Intent Relay Service
 *
 * Client for the cross-chain message relayer used by SODAX intents,
 * served by the SODAX API at /v1/relay.
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
 * The relay returns a JSON body for every outcome, including 404 (used for
 * "packet not found" responses on get_packet / get_transaction_packets).
 * We parse the body regardless of status. HTTP 5xx is an error, and so is any
 * body that isn't a relay answer (every relay answer has a boolean `success`),
 * such as the SODAX API edge's own 429.
 *
 * Never send the caller's API key here: the relay takes none, and the gateway
 * passes this route on to an origin outside the SODAX API.
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

  if (response.status >= 500) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }

  const body = (await response.json().catch(() => undefined)) as { success?: unknown } | undefined;
  if (typeof body?.success !== "boolean") {
    const retryAfter = response.headers.get("Retry-After");
    throw new Error(`HTTP ${response.status}${retryAfter ? `, retry after ${retryAfter}s` : ""}`);
  }
  return body as T;
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
