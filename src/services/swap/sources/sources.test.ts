import { keccak_256 } from "@noble/hashes/sha3";
import { spokeChainConfig } from "@sodax/types";
import { beforeAll, describe, expect, it } from "vitest";
import { type IntentJson, createIntentPayload, initSodax } from "../../sodax.js";
import fixtures from "../__fixtures__/non-evm-txs.json" with { type: "json" };
import { committedPayload } from "../source.js";
import { checkDeposit, depositMessages, holdsCancel } from "../sourceTx.js";
import { assetManagerSender, pinnedSourceOf } from "./index.js";
import { injectiveEvidence } from "./injective.js";
import { nearEvidence } from "./near.js";
import { solanaEvidence } from "./solana.js";
import { stellarEvidence } from "./stellar.js";
import { suiEvidence } from "./sui.js";
import type { NonEvmSourceType, SourceChain, SpokeEvidence } from "./types.js";

// Real mainnet swap deposits, as each family's reader gets them, trimmed to what it reads, with the hub intents
// they created. Sui's events come from the GraphQL indexer, in the gRPC client's shape, as its node pruned the tx.

beforeAll(() => initSodax());

const sourceOf = (chainKey: string) => pinnedSourceOf(chainKey) as SourceChain;

const addresses = (chainKey: string) =>
  (spokeChainConfig as Record<string, { addresses: { connection: string; assetManager: string } }>)[chainKey].addresses;
const connection = (chainKey: string) => addresses(chainKey).connection;
const base64 = (text: string) => new Uint8Array(Buffer.from(text, "base64"));
const suiRaw = (tx: typeof fixtures.sui.tx) => ({
  ...tx,
  Transaction: {
    ...tx.Transaction,
    events: tx.Transaction.events.map(event => ({ ...event, bcs: base64(event.bcs) })),
  },
});

type Case = { chainKey: string; family: NonEvmSourceType; intent: IntentJson; read: () => SpokeEvidence | null };
const CASES: Record<string, Case> = {
  solana: {
    chainKey: "solana",
    family: "SOLANA",
    intent: fixtures.solana.intent,
    read: () => solanaEvidence(fixtures.solana.tx, connection("solana")),
  },
  stellar: {
    chainKey: "stellar",
    family: "STELLAR",
    intent: fixtures.stellar.intent,
    read: () => stellarEvidence(fixtures.stellar.tx, connection("stellar")),
  },
  sui: {
    chainKey: "sui",
    family: "SUI",
    intent: fixtures.sui.intent,
    read: () => suiEvidence(suiRaw(fixtures.sui.tx), connection("sui")),
  },
  near: {
    chainKey: "near",
    family: "NEAR",
    intent: fixtures.near.intent,
    read: () => nearEvidence(fixtures.near.tx, connection("near")),
  },
  injective: {
    chainKey: "injective-1",
    family: "INJECTIVE",
    intent: fixtures.injective.intent,
    read: () => injectiveEvidence(fixtures.injective.tx, connection("injective-1")),
  },
};

/** What the quote's deposit must say, as track asks it (`depositTerms`). */
function terms({ chainKey, family, intent }: Case, changes: Partial<IntentJson> = {}) {
  const swap = { ...intent, ...changes };
  return {
    assetManager: assetManagerSender(chainKey, family) as string,
    srcChain: swap.srcChain,
    srcAddress: swap.srcAddress,
    to: swap.creator,
    data: committedPayload(sourceOf(chainKey), createIntentPayload(swap) as string),
  };
}

describe("each family's evidence, on a real swap deposit", () => {
  it.each(Object.keys(CASES))("%s: one deposit, binding the intent's sender, hub wallet and payload", name => {
    const swap = CASES[name];
    const evidence = swap.read() as SpokeEvidence;
    expect(evidence.failed).toBe(false);
    expect(depositMessages(evidence.messages, terms(swap).assetManager)).toHaveLength(1);
    expect(checkDeposit(evidence.messages, terms(swap))).toBe("match");
    const another = String(BigInt(swap.intent.intentId) + 1n);
    expect(checkDeposit(evidence.messages, terms(swap, { intentId: another }))).toBe("mismatch");
    expect(checkDeposit(evidence.messages, { ...terms(swap), srcAddress: `0x${"9".repeat(64)}` })).toBe("other_sender");
    expect(checkDeposit(evidence.messages, { ...terms(swap), to: `0x${"9".repeat(40)}` })).toBe("mismatch");
    expect(checkDeposit(evidence.messages, { ...terms(swap), srcChain: "999" })).toBe("not_a_deposit");
    // Sent by another contract than the asset manager: not a deposit at all.
    expect(checkDeposit(evidence.messages, { ...terms(swap), assetManager: "0x01" })).toBe("not_a_deposit");
  });

  it("finds Solana's payload as its keccak only, as the relay checks it against the submitted data", () => {
    const swap = CASES.solana;
    const payload = createIntentPayload(swap.intent) as string;
    const evidence = swap.read() as SpokeEvidence;
    expect(checkDeposit(evidence.messages, { ...terms(swap), data: payload })).toBe("mismatch");
    const hash = `0x${Buffer.from(keccak_256(Buffer.from(payload.slice(2), "hex"))).toString("hex")}`;
    expect(terms(swap).data).toBe(hash);
    expect(committedPayload(sourceOf("sui"), payload)).toBe(payload);
  });

  it("names each asset manager as its deposits' messages do, from the packaged config alone", () => {
    expect(assetManagerSender("near", "NEAR")).toBe(`0x${Buffer.from("asset-manager.sodax.near").toString("hex")}`);
    // A Stellar contract's address as an ScVal, in XDR.
    expect(assetManagerSender("stellar", "STELLAR")).toMatch(/^0x0000001200000001[0-9a-f]{64}$/);
    expect(assetManagerSender("solana", "SOLANA")).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

describe("Solana's evidence", () => {
  const conn = connection("solana");
  const realLogs = fixtures.solana.tx.meta.logMessages;
  const event = realLogs.find(log => log.startsWith("Program data: ")) as string;
  const logs = (...lines: string[]) => ({ meta: { err: null, logMessages: lines } });
  const NOOP = "noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV";

  it("ignores the event's bytes logged by any other program: a Noop carrying the payload's keccak included", () => {
    const keccak = Buffer.from(keccak_256(Buffer.from("01", "hex"))).toString("base64");
    const forged = logs(`Program ${NOOP} invoke [1]`, `Program log: ${keccak}`, event, `Program ${NOOP} success`);
    expect(solanaEvidence(forged, conn)).toEqual({ failed: false, messages: [] });
  });

  it("takes only what the connection logged as the innermost frame, not a caller's line after it returned", () => {
    const caller = "Caller1111111111111111111111111111111111111";
    const tx = logs(
      `Program ${caller} invoke [1]`,
      `Program ${conn} invoke [2]`,
      event,
      `Program ${conn} success`,
      event,
      `Program ${caller} success`,
    );
    expect(solanaEvidence(tx, conn)?.messages).toHaveLength(1);
  });

  it("counts every deposit the connection logged in one tx", () => {
    const tx = logs(`Program ${conn} invoke [1]`, event, event, `Program ${conn} success`);
    expect(solanaEvidence(tx, conn)?.messages).toHaveLength(2);
  });

  it("has no messages from a failed tx, which is rolled back whole, and none before it's confirmed", () => {
    expect(solanaEvidence({ meta: { err: { InstructionError: [0, "Custom"] }, logMessages: realLogs } }, conn)).toEqual(
      { failed: true, messages: [] },
    );
    expect(solanaEvidence(null, conn)).toBeNull();
    expect(solanaEvidence({ meta: null }, conn)).toBeNull();
  });

  it("refuses truncated logs or none, as the relay can't attribute them either", () => {
    expect(() => solanaEvidence(logs(...realLogs.slice(0, 3), "Log truncated"), conn)).toThrow();
    expect(() => solanaEvidence({ meta: { err: null, logMessages: null } }, conn)).toThrow();
  });
});

describe("Stellar's evidence", () => {
  const conn = connection("stellar");
  const [events] = fixtures.stellar.tx.events.contractEventsXdr;
  const message = events.find(event => stellarEvidence(tx([[event]]), conn)?.messages.length) as string;
  function tx(contractEventsXdr: string[][], status = "SUCCESS") {
    return { status, events: { contractEventsXdr } };
  }
  /** The event with `bytes` written at `offset`. */
  const patched = (offset: number, bytes: Buffer) => {
    const xdr = Buffer.from(message, "base64");
    bytes.copy(xdr, offset);
    return xdr.toString("base64");
  };

  it("skips another contract's events, a token's transfer and a copy of the Message included", () => {
    expect(stellarEvidence(fixtures.stellar.tx, conn)?.messages).toHaveLength(1);
    const otherContract = patched(8, Buffer.alloc(32, 7));
    expect(stellarEvidence(tx([[otherContract]]), conn)).toEqual({ failed: false, messages: [] });
  });

  it("counts every Message the connection emitted, over all operations", () => {
    expect(stellarEvidence(tx([[message], [message]]), conn)?.messages).toHaveLength(2);
  });

  it("refuses a value type the connection doesn't emit, rather than skip what may be a deposit", () => {
    // The topic's type, String (14), turned into U32 (3).
    expect(() => stellarEvidence(tx([[patched(52, Buffer.from([0, 0, 0, 3]))]]), conn)).toThrow();
    expect(() => stellarEvidence(tx([[message.slice(0, -8)]]), conn)).toThrow();
  });

  it("reads a failed tx as failed, an unknown one as not yet, and refuses a status or shape it doesn't know", () => {
    expect(stellarEvidence(tx([[message]], "FAILED"), conn)).toEqual({ failed: true, messages: [] });
    expect(stellarEvidence({ status: "NOT_FOUND" }, conn)).toBeNull();
    expect(() => stellarEvidence({ status: "PENDING" }, conn)).toThrow();
    expect(() => stellarEvidence({ status: "SUCCESS" }, conn)).toThrow();
  });
});

describe("Sui's evidence", () => {
  const conn = connection("sui");
  const raw = suiRaw(fixtures.sui.tx);
  const [event] = raw.Transaction.events;
  const withEvents = (events: unknown[]) => ({ ...raw, Transaction: { ...raw.Transaction, events } });

  it("skips a Message of another package, as one any package can define", () => {
    const forged = { ...event, eventType: `0x${"1".repeat(64)}::connectionv3::Message` };
    expect(suiEvidence(withEvents([forged]), conn)).toEqual({ failed: false, messages: [] });
    expect(suiEvidence(withEvents([event, event]), conn).messages).toHaveLength(2);
  });

  it("reads a failed tx as failed, and refuses events it can't read", () => {
    const failed = {
      $kind: "FailedTransaction",
      FailedTransaction: { ...raw.Transaction, status: { success: false } },
    };
    expect(suiEvidence(failed, conn)).toEqual({ failed: true, messages: [] });
    expect(() => suiEvidence(withEvents(undefined as never), conn)).toThrow();
    const longer = { ...event, bcs: new Uint8Array([...event.bcs, 0]) };
    expect(() => suiEvidence(withEvents([longer]), conn)).toThrow();
    expect(() => suiEvidence({ $kind: "Transaction", Transaction: { status: {} } }, conn)).toThrow();
  });
});

describe("NEAR's evidence", () => {
  const conn = connection("near");
  const outcome = fixtures.near.tx;
  const receipts = outcome.receipts_outcome;
  const connectionReceipt = receipts.find(receipt => receipt.outcome.executor_id === conn) as (typeof receipts)[0];
  const withReceipts = (receipts_outcome: typeof receipts) => ({ ...outcome, receipts_outcome });
  const failure = { Failure: { ActionError: { index: 0, kind: { FunctionCallError: {} } } } };

  it("takes only the connection's logs: the same JSON logged by another account isn't a message", () => {
    const forged = { ...connectionReceipt, outcome: { ...connectionReceipt.outcome, executor_id: "evil.near" } };
    expect(nearEvidence(withReceipts([forged]), conn)).toEqual({ failed: false, messages: [] });
  });

  it("fails a tx with any receipt that didn't succeed, keeping what ran: NEAR doesn't roll that back", () => {
    const later = receipts.map((receipt, i) =>
      i === receipts.length - 1 ? { ...receipt, outcome: { ...receipt.outcome, status: failure } } : receipt,
    );
    expect(nearEvidence(withReceipts(later), conn)).toMatchObject({ failed: true, messages: [expect.anything()] });
    const connectionFailed = receipts.map(receipt =>
      receipt === connectionReceipt ? { ...receipt, outcome: { ...receipt.outcome, status: failure } } : receipt,
    );
    expect(nearEvidence(withReceipts(connectionFailed), conn)).toEqual({ failed: true, messages: [] });
  });

  it("waits for a tx in flight, and refuses a stage or a Message it doesn't know", () => {
    expect(nearEvidence({ final_execution_status: "INCLUDED" }, conn)).toBeNull();
    expect(() => nearEvidence({ ...outcome, final_execution_status: "REVERTED" }, conn)).toThrow();
    const odd = { ...connectionReceipt, outcome: { ...connectionReceipt.outcome, logs: ['EVENT_JSON: {"a":1}'] } };
    expect(() => nearEvidence(withReceipts([odd]), conn)).toThrow();
  });
});

describe("Injective's evidence", () => {
  const conn = connection("injective-1");
  const { tx_response } = fixtures.injective.tx;
  const message = tx_response.events.find(event => event.type === "wasm-Message") as (typeof tx_response.events)[0];
  const withEvents = (events: typeof tx_response.events, code = 0) => ({ tx_response: { code, events } });

  it("counts every Message the connection emitted: two deposits in one tx are two", () => {
    const swap = CASES.injective;
    const evidence = injectiveEvidence(withEvents([...tx_response.events, message]), conn);
    expect(depositMessages(evidence.messages, terms(swap).assetManager)).toHaveLength(2);
  });

  it("skips another contract's Message, and refuses the connection's when it can't read it", () => {
    const rename = (contract: string) =>
      message.attributes.map(entry => (entry.key === "_contract_address" ? { ...entry, value: contract } : entry));
    const forged = { ...message, attributes: rename(addresses("injective-1").assetManager) };
    expect(injectiveEvidence(withEvents([forged]), conn)).toEqual({ failed: false, messages: [] });
    const odd = { ...message, attributes: message.attributes.filter(entry => entry.key !== "payload") };
    expect(() => injectiveEvidence(withEvents([odd]), conn)).toThrow();
  });

  it("reads a tx with a non-zero code as failed, with no messages", () => {
    expect(injectiveEvidence(withEvents(tx_response.events, 5), conn)).toEqual({ failed: true, messages: [] });
  });
});

describe("a cancel's evidence", () => {
  it("is the user's own message to their hub wallet, carrying the payload as the chain commits it", () => {
    const message = { srcChainId: 21n, srcAddress: "0xaa", dstChainId: 146n, dstAddress: "0xcc", payload: "0x01" };
    const want = { srcAddress: "0xaa", srcChain: "21", creator: "0xcc", payload: "0x01" };
    expect(holdsCancel([message], want)).toBe(true);
    expect(holdsCancel([], want)).toBe(false);
    for (const change of [{ srcAddress: "0xbb" }, { creator: "0xdd" }, { payload: "0x02" }, { srcChain: "1" }]) {
      expect(holdsCancel([message], { ...want, ...change })).toBe(false);
    }
  });
});
