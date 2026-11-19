/**
 * Sui as a swap source. Its evidence, as the relay's verifier reads it: the connection package's `Message` events, from a tx that
 * succeeded. Read from the event's BCS, whose layout a package upgrade can't change.
 */

import { spokeChainConfig } from "@sodax/types";
import { z } from "zod";
import { isRecord } from "../../../constants.js";
import { logger } from "../../logger.js";
import { spokeClients } from "../../sodax.js";
import { ActionError } from "../errors.js";
import { ByteReader, hex, utf8Hex } from "./bytes.js";
import { base58Hash, nonEvmAdapter, readable } from "./nonEvm.js";
import type { ConnectionMessage, SpokeEvidence } from "./types.js";

/** The asset manager as messages name it: the UTF-8 of its config string, `<package>::asset_manager::<object>`. */
export const suiSender = utf8Hex;

const suiTx = z.object({
  status: z.object({ success: z.boolean() }),
  events: z.array(z.object({ eventType: z.string(), bcs: z.instanceof(Uint8Array) })).nullish(),
});
const suiResultSchema = z.union([
  z.object({ $kind: z.literal("Transaction"), Transaction: suiTx }),
  z.object({ $kind: z.literal("FailedTransaction"), FailedTransaction: suiTx }),
]);

// An address in full: events name types with 64 hex digits, a config may drop leading zeros.
const fullAddress = (address: string) => `0x${address.replace(/^0x/, "").toLowerCase().padStart(64, "0")}`;

/** A Move type or call target (`<package>::...`) with its package in full. */
const target = (text: string) => {
  const [pkg, ...rest] = text.split("::");
  return `${fullAddress(pkg)}::${rest.join("::")}`;
};

/** A member of a config string's module (`<package>::<module>::<state object>`), as `target` spells it. */
const memberOf = (config: string, member: string) => {
  const [pkg, module] = config.split("::");
  return target(`${pkg}::${module}::${member}`);
};

/**
 * The connection's messages in a tx from `core.getTransaction({ include: { events: true } })`. A failed tx emits no
 * events; a shape it doesn't know throws.
 */
export function suiEvidence(raw: unknown, connection: string): SpokeEvidence {
  const result = suiResultSchema.parse(raw);
  const tx = result.$kind === "Transaction" ? result.Transaction : result.FailedTransaction;
  if (result.$kind === "FailedTransaction" || !tx.status.success) return { failed: true, messages: [] };
  if (!tx.events) throw new Error("a Sui tx without its events");
  const type = memberOf(connection, "Message");
  const messages = tx.events.flatMap(event =>
    target(event.eventType) === type ? [readable(() => messageEvent(event.bcs))] : [],
  );
  return { failed: false, messages };
}

/** BCS `Message { u256, vector<u8>, u256 conn_sn, u256, vector<u8>, vector<u8> }`. */
function messageEvent(bcs: Uint8Array): ConnectionMessage {
  const reader = new ByteReader(bcs);
  const bytes = () => hex(reader.take(reader.uleb128()));
  const srcChainId = reader.uintLE(32);
  const srcAddress = bytes();
  reader.uintLE(32);
  const dstChainId = reader.uintLE(32);
  const dstAddress = bytes();
  const payload = bytes();
  if (!reader.done) throw new Error("a Message event of unknown shape");
  return { srcChainId, srcAddress, dstChainId, dstAddress, payload };
}

export const SUI = nonEvmAdapter({
  family: "SUI",
  txHash: { format: "a base58 digest", spell: base58Hash(32) },
  async fetch({ connection, txHash }) {
    try {
      return suiEvidence(
        await suiClient().core.getTransaction({ digest: txHash, include: { events: true } }),
        connection,
      );
    } catch (error) {
      // Only the node's own answer names the digest: a 404 from anything in front of it is an outage.
      const { code, message } = (error ?? {}) as { code?: unknown; message?: unknown };
      if (code === "NOT_FOUND" && typeof message === "string" && message.includes(txHash)) return null;
      throw error;
    }
  },
  // What the wallet signs is checked, not the SDK's `to`. The SDK reads the upgraded asset manager package from the
  // chain, so a swap must call the one the Swaps API's own build names; a cancel, the packaged connection.
  // The state objects it's given must be the packaged ones too, as Solana's accounts must.
  callsPinned(kind, raw, expected) {
    const call = moveCallOf(raw);
    if (!call) return false;
    const { assetManager, connection } = spokeChainConfig.sui.addresses;
    const given = (config: string) => call.objects.includes(fullAddress(config.split("::")[2] ?? ""));
    if (kind === "cancel") return call.target === memberOf(connection, "send_message_ua") && given(connection);
    const transfer = typeof expected === "string" && /::asset_manager::transfer$/.test(expected);
    return transfer && call.target === target(expected) && given(assetManager) && given(connection);
  },
  finish: withSender,
});

// The SDK serializes a tx unbuilt (`Transaction.serialize`, the v1 JSON): its inputs, objects by id, and its commands,
// MoveCalls naming a target.
const suiPtb = z.object({
  version: z.literal(1),
  inputs: z.array(z.object({ type: z.string().optional(), value: z.unknown() })),
  transactions: z.array(z.object({ kind: z.string(), target: z.string().optional() })),
});
// Only coin handling besides the one call: what a deposit splits off or merges, and nothing that moves anything else.
const COIN_COMMANDS = ["SplitCoins", "MergeCoins"];

/** The one Move call in an SDK build and the objects the tx is given, or `undefined` for a build of any other shape. */
function moveCallOf(raw: unknown): { target: string; objects: string[] } | undefined {
  const ptb = suiPtb.safeParse(isRecord(raw) && typeof raw.data === "string" ? jsonRecord(raw.data) : undefined);
  if (!ptb.success) return undefined;
  const calls = ptb.data.transactions.filter(command => !COIN_COMMANDS.includes(command.kind));
  if (calls.length !== 1 || calls[0].kind !== "MoveCall" || calls[0].target === undefined) return undefined;
  const objects = ptb.data.inputs.flatMap(input =>
    input.type === "object" && typeof input.value === "string" ? [fullAddress(input.value)] : [],
  );
  return { target: target(calls[0].target), objects };
}

type SuiGetTransaction = (options: { digest: string; include: { events: true } }) => Promise<unknown>;

/**
 * The SDK's Sui gRPC client, which its transport keeps private: no public SDK call returns a tx's events. Its shape
 * is checked, so an SDK that moves it fails here, plainly, and in the contract tests.
 */
export function suiClient(): { core: { getTransaction: SuiGetTransaction } } {
  const transport = spokeClients().sui.transport as unknown as { client?: { core?: { getTransaction?: unknown } } };
  const client = transport?.client;
  if (typeof client?.core?.getTransaction !== "function") throw new Error("the SDK's Sui client moved");
  return client as { core: { getTransaction: SuiGetTransaction } };
}

// The SDK leaves a Sui tx's sender unset, so a wallet would sign as whichever account is active: native SUI split
// from that account's gas would pay for the quoted sender's swap. A build it can't set one on isn't handed out, nor
// one in another format than the v1 JSON `callsPinned` reads (an SDK on a newer serializer), which is this server's
// to update, not a build calling another program.
function withSender(raw: unknown): unknown {
  const parsed = isRecord(raw) && typeof raw.from === "string" && typeof raw.data === "string" && jsonRecord(raw.data);
  if (!parsed || !suiPtb.safeParse(parsed).success) {
    logger.error("The SDK built a Sui transaction in a shape this server doesn't read");
    throw new ActionError("INTERNAL", "The SDK built a transaction this server doesn't recognize.");
  }
  return { ...raw, data: JSON.stringify({ ...parsed, sender: raw.from }) };
}

function jsonRecord(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}
