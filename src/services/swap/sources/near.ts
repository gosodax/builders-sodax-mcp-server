/**
 * NEAR as a swap source. Its evidence: the `EVENT_JSON` logs of the receipts the connection ran. A tx with any
 * receipt that didn't succeed is failed here; the receipts that ran before it stay, so their messages are kept and a
 * deposit among them is reported as held.
 */

import { spokeChainConfig } from "@sodax/types";
import { z } from "zod";
import { isRecord } from "../../../constants.js";
import { RPC_CALL_TIMEOUT_MS, bounded, spokeClients } from "../../sodax.js";
import { ActionError } from "../errors.js";
import { hexText, utf8Hex } from "./bytes.js";
import { UnreadableEvents, base58Hash, nonEvmAdapter, readable } from "./nonEvm.js";
import type { ConnectionMessage, SpokeEvidence } from "./types.js";

/** An account as messages name it: its name's UTF-8 bytes. */
export const nearSender = utf8Hex;

// The stages before a tx is final: only a final one is judged.
const IN_FLIGHT = ["NONE", "INCLUDED", "INCLUDED_FINAL", "EXECUTED_OPTIMISTIC", "EXECUTED"];

// A tx still in flight comes back with its stage and little else.
const stageSchema = z.object({ final_execution_status: z.string().optional() });
const outcomeSchema = z.object({
  transaction_outcome: z.object({ outcome: z.object({ status: z.unknown() }) }),
  receipts_outcome: z.array(
    z.object({ outcome: z.object({ status: z.unknown(), executor_id: z.string(), logs: z.array(z.string()) }) }),
  ),
});
const messageSchema = z.object({
  src_chain_id: z.number().int().nonnegative(),
  src_address: z.string(),
  dst_chain_id: z.number().int().nonnegative(),
  dst_address: z.string(),
  payload: z.string(),
});

/** A final outcome's status: anything but success (`Unknown` included) fails it; a shape it doesn't know throws. */
function succeeded(status: unknown): boolean {
  if (isRecord(status) && ("SuccessValue" in status || "SuccessReceiptId" in status)) return true;
  if ((isRecord(status) && "Failure" in status) || status === "Unknown") return false;
  throw new Error("unknown NEAR outcome status");
}

/** The connection's messages in a tx's RPC outcome, or `null` until every receipt ran. */
export function nearEvidence(raw: unknown, connection: string): SpokeEvidence | null {
  // Without its stage, or before it's final, the tx is waited for, not judged.
  const stage = stageSchema.parse(raw).final_execution_status;
  if (stage === undefined || IN_FLIGHT.includes(stage)) return null;
  if (stage !== "FINAL") throw new Error("unknown NEAR tx stage");
  const { transaction_outcome, receipts_outcome } = outcomeSchema.parse(raw);
  const failed = ![transaction_outcome, ...receipts_outcome].every(({ outcome }) => succeeded(outcome.status));
  try {
    const messages = receipts_outcome
      .filter(({ outcome }) => outcome.executor_id === connection && succeeded(outcome.status))
      .flatMap(({ outcome }) =>
        outcome.logs.filter(log => log.startsWith("EVENT_JSON:")).flatMap(log => readable(() => eventMessage(log))),
      );
    return { failed, messages };
  } catch (error) {
    // Whether it failed is read already: an event it can't read doesn't take that away.
    throw error instanceof UnreadableEvents ? new UnreadableEvents(error.message, failed) : error;
  }
}

/** `EVENT_JSON: {src_chain_id, src_address, dst_chain_id, dst_address, conn_sn, payload}`, the bytes in hex. */
function eventMessage(log: string): ConnectionMessage[] {
  const json: unknown = JSON.parse(log.slice("EVENT_JSON:".length));
  // Another event the connection may log (a NEP-297 one, say) isn't a message.
  if (!isRecord(json) || !("src_chain_id" in json)) return [];
  const event = messageSchema.parse(json);
  // Beyond 2^53 a JSON number has lost digits: the event can't be trusted.
  if (!Number.isSafeInteger(event.src_chain_id) || !Number.isSafeInteger(event.dst_chain_id)) {
    throw new Error("a Message event of unknown shape");
  }
  return [
    {
      srcChainId: BigInt(event.src_chain_id),
      srcAddress: hexText(event.src_address),
      dstChainId: BigInt(event.dst_chain_id),
      dstAddress: hexText(event.dst_address),
      payload: hexText(event.payload),
    },
  ];
}

/** The node's status of a tx at whatever stage it's at, or `null` if it doesn't know it. */
async function nearStatus(txHash: string, sender?: string): Promise<unknown> {
  // The lookup is routed by the sender's account; public nodes track every shard, so any account does.
  const accountId = sender ?? spokeChainConfig.near.addresses.assetManager;
  try {
    return await spokeClients().near.rpcProvider.viewTransactionStatus({ txHash, accountId, waitUntil: "NONE" });
  } catch (error) {
    if (error instanceof Error && error.name === "UnknownTransactionError") return null;
    throw error;
  }
}

/**
 * Whether a status names a stage this server knows: in flight, or FINAL by the time `seen` asks, after a read that
 * found it earlier. One without a stage says nothing of where the tx is.
 */
export const nearKnows = (status: unknown) => {
  const stage = stageSchema.safeParse(status).data?.final_execution_status;
  return stage !== undefined && (stage === "FINAL" || IN_FLIGHT.includes(stage));
};

export const NEAR = nonEvmAdapter({
  family: "NEAR",
  txHash: { format: "a base58 hash", spell: base58Hash(32) },
  async fetch({ connection, txHash, sender }) {
    const outcome = await nearStatus(txHash, sender);
    return outcome === null ? null : nearEvidence(outcome, connection);
  },
  // A tx is read once FINAL: one at an earlier stage is on its way.
  seen: async ({ txHash, sender }) => nearKnows(await nearStatus(txHash, sender)),
  // Its swap tx is built without a read, so a dead RPC would only show at track: the final block's height first.
  probe: chainKey =>
    bounded({ label: "block number", chainKey, timeoutMs: RPC_CALL_TIMEOUT_MS }, async () => {
      const block = await spokeClients().near.rpcProvider.viewBlock({ finality: "final" });
      return BigInt(block.header.height);
    }),
  // An Ethereum-style account sends through a relayer to its own account contract, a deposit track can't see.
  checkSender(address) {
    if (!address.startsWith("0x")) return;
    throw new ActionError("INVALID_ADDRESS", "Swaps from an Ethereum-style (0x) NEAR account aren't supported here.", {
      nextStep: "Ask the user for a named NEAR account (such as alice.near) or a 64-hex implicit one to send from.",
      details: { field: "fromAddress" },
    });
  },
});
