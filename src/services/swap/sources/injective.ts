/**
 * Injective as a swap source. Its evidence, as the relay's verifier reads it: the connection contract's `wasm-Message` events, from a
 * tx that succeeded. Its `src_address` is the sender's bech32 name; the other bytes are hex.
 */

import { z } from "zod";
import { HEX_64 } from "../../../constants.js";
import { HttpError, fetchJson } from "../../http.js";
import { spokeClients } from "../../sodax.js";
import { utf8Hex } from "./bytes.js";
import { nonEvmAdapter } from "./nonEvm.js";
import type { ConnectionMessage, SpokeEvidence } from "./types.js";

/** A contract as messages name it: its bech32 address's UTF-8 bytes. */
export const injectiveSender = utf8Hex;

const txSchema = z.object({
  tx_response: z.object({
    code: z.number(),
    events: z.array(
      z.object({ type: z.string(), attributes: z.array(z.object({ key: z.string(), value: z.string() })) }),
    ),
  }),
});

const DECIMAL = /^\d{1,39}$/;
const HEX = /^(?:[0-9a-fA-F]{2})*$/;

/** The connection's messages in a tx from the REST `GET /cosmos/tx/v1beta1/txs/{hash}`. A failed tx is rolled back. */
export function injectiveEvidence(body: unknown, connection: string): SpokeEvidence {
  const { tx_response } = txSchema.parse(body);
  if (tx_response.code !== 0) return { failed: true, messages: [] };
  const messages = tx_response.events.flatMap(event => {
    const attribute = (key: string) => event.attributes.find(entry => entry.key === key)?.value;
    if (event.type !== "wasm-Message" || attribute("_contract_address") !== connection) return [];
    return [eventMessage(attribute)];
  });
  return { failed: false, messages };
}

function eventMessage(attribute: (key: string) => string | undefined): ConnectionMessage {
  const read = (key: string, pattern: RegExp) => {
    const value = attribute(key);
    if (value === undefined || !pattern.test(value)) throw new Error("a Message event of unknown shape");
    return value;
  };
  const sender = read("src_address", /^inj1[0-9a-z]{38,58}$/);
  return {
    srcChainId: BigInt(read("src_chain_id", DECIMAL)),
    srcAddress: utf8Hex(sender),
    dstChainId: BigInt(read("dst_chain_id", DECIMAL)),
    dstAddress: `0x${read("dst_address", HEX).toLowerCase()}`,
    payload: `0x${read("payload", HEX).toLowerCase()}`,
  };
}

// Each try fits in the read's own bound.
const TRY_MS = 2_500;

export const INJECTIVE = nonEvmAdapter({
  family: "INJECTIVE",
  txHash: { format: "64 hex characters", spell: text => HEX_64.exec(text)?.[1].toUpperCase() },
  async fetch({ connection, txHash }) {
    const url = `${spokeClients().injective.endpoints.rest}/cosmos/tx/v1beta1/txs/${txHash}`;
    // The public LCD balances over nodes that keep different history, so a tx some still have is asked again, as is a
    // slow node. Unknown only if every node said so.
    let slow: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return injectiveEvidence(await fetchJson<unknown>(url, { timeout: TRY_MS }), connection);
      } catch (error) {
        if (error instanceof Error && error.name === "TimeoutError") slow = error;
        else if (!nodeLacksTx(error)) throw error;
      }
    }
    if (slow) throw slow;
    return null;
  },
});

/**
 * The node's own answer that it doesn't have the tx: NotFound (gRPC code 5), or the block it's in pruned ("height N is
 * not available", code 2). A 404 or 500 from anything in front of the node is an outage.
 */
function nodeLacksTx(error: unknown): boolean {
  if (!(error instanceof HttpError)) return false;
  if (error.status === 404) return error.apiCode === 5;
  return error.status === 500 && error.apiCode === 2 && /^height \d+ is not available/.test(error.apiMessage ?? "");
}
