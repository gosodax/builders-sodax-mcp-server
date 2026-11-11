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
import { BadResponseError, HttpError, timedFetch } from "./http.js";

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
  // The relay answers "not found" with a 404 and a normal body; 5xx and non-relay bodies are the failures.
  const { response, body } = await timedFetch(
    `${SODAX_RELAY_BASE_URL}/`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ action, params }),
      signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
    },
    response => response.status < 500,
    // A body that isn't JSON is checked below; a timeout or a dropped socket while reading it stays a failure.
    response =>
      response.json().catch(error => {
        if (error instanceof SyntaxError) return undefined;
        throw error;
      }) as Promise<{ success?: unknown } | undefined>,
  );

  if (response.status >= 500) {
    throw new HttpError(`HTTP ${response.status} ${response.statusText}`, response.status);
  }

  if (typeof body?.success !== "boolean") {
    const retryAfter = response.headers.get("Retry-After");
    const message = `HTTP ${response.status}${retryAfter ? `, retry after ${retryAfter}s` : ""}`;
    // A 2xx that isn't a relay answer is a bad response; anything else (the edge's 429) an HTTP failure.
    throw response.ok ? new BadResponseError(message) : new HttpError(message, response.status);
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
    throw new Error(`Failed to submit relay tx: ${error instanceof Error ? error.message : "Unknown error"}`, {
      cause: error,
    });
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
    throw new Error(
      `Failed to fetch relay transaction packets: ${error instanceof Error ? error.message : "Unknown error"}`,
      { cause: error },
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
    throw new Error(`Failed to fetch relay packet: ${error instanceof Error ? error.message : "Unknown error"}`, {
      cause: error,
    });
  }
}
