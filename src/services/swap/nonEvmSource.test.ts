import { encodeAddress } from "@sodax/sdk";
import { spokeChainConfig } from "@sodax/types";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type IntentJson,
  type NonEvmSourceType,
  assetManagerMarker,
  createIntentPayload,
  initSodax,
} from "../sodax.js";
import fixtures from "./__fixtures__/non-evm-txs.json" with { type: "json" };
import {
  type NonEvmTx,
  callsAssetManager,
  carriesPayload,
  injectiveTxFrom,
  isAnyTxHash,
  jsonSafe,
  nearTxFrom,
  normalizeTxHash,
  solanaTxFrom,
  stellarTxFrom,
  suiTxFrom,
  toNonEvmStep,
} from "./nonEvmSource.js";

// Real mainnet swap deposits, as each family's reader gets them, with the hub intents they created: what the relay
// carried is the payload the SDK builds for that intent.
const base64 = (text: string) => Buffer.from(text, "base64");
const solanaTx = (err: unknown) => ({
  meta: { err },
  transaction: { message: { serialize: () => base64(fixtures.solana.message) } },
});
const RAW_TXS: Record<"solana" | "stellar" | "sui", NonEvmTx> = {
  solana: solanaTxFrom(solanaTx(null)) as NonEvmTx,
  stellar: stellarTxFrom({ status: "SUCCESS", envelopeXdr: fixtures.stellar.envelopeXdr }) as NonEvmTx,
  sui: { failed: false, bytes: base64(fixtures.sui.bcs), calls: [] },
};
const near = nearTxFrom(fixtures.near.outcome);
const injective = injectiveTxFrom(fixtures.injective.body);

beforeAll(async () => {
  await initSodax();
});

const payloadOf = (intent: IntentJson) => {
  const payload = createIntentPayload(intent);
  if (!payload) throw new Error("the SDK didn't encode the fixture's intent");
  return payload;
};
const anotherIntent = (intent: IntentJson) => ({ ...intent, intentId: String(BigInt(intent.intentId) + 1n) });

describe("carriesPayload, on real deposits", () => {
  const cases: [string, NonEvmTx | null, IntentJson, NonEvmSourceType][] = [
    ["solana (the payload's keccak only)", RAW_TXS.solana, fixtures.solana.intent, "SOLANA"],
    ["stellar (in the envelope XDR)", RAW_TXS.stellar, fixtures.stellar.intent, "STELLAR"],
    ["sui (in the transaction BCS)", RAW_TXS.sui, fixtures.sui.intent, "SUI"],
    ["near (a native transfer's args)", near, fixtures.near.intent, "NEAR"],
    [
      "injective (a transfer's data, from an EIP-712 wallet's Compat message)",
      injective,
      fixtures.injective.intent,
      "INJECTIVE",
    ],
  ];

  it.each(cases)("finds the hub intent's payload in the %s deposit", (_case, tx, intent, family) => {
    expect(tx).not.toBeNull();
    expect(carriesPayload(tx as NonEvmTx, payloadOf(intent), family)).toBe(true);
  });

  it.each(cases)("doesn't find another intent's payload in the %s deposit", (_case, tx, intent, family) => {
    expect(carriesPayload(tx as NonEvmTx, payloadOf(anotherIntent(intent)), family)).toBe(false);
  });

  it("takes a payload's keccak from Solana only: another family's relay reads the payload itself", () => {
    const hashOnly = { failed: false, bytes: RAW_TXS.solana.bytes, calls: [] };
    expect(carriesPayload(hashOnly, payloadOf(fixtures.solana.intent), "SOLANA")).toBe(true);
    expect(carriesPayload(hashOnly, payloadOf(fixtures.solana.intent), "STELLAR")).toBe(false);
  });

  it("finds it in the SDK's own Injective message as well, whose msg is JSON, not text", () => {
    const [message] = fixtures.injective.body.tx.body.messages;
    const sdkMessage = { ...message, "@type": "/cosmwasm.wasm.v1.MsgExecuteContract", msg: JSON.parse(message.msg) };
    const tx = injectiveTxFrom({ ...fixtures.injective.body, tx: { body: { messages: [sdkMessage] } } });
    expect(carriesPayload(tx, payloadOf(fixtures.injective.intent), "INJECTIVE")).toBe(true);
  });

  it("finds an ft_transfer_call's payload in its msg", () => {
    const data = [1, 2, 3];
    const args = { receiver_id: "asset-manager.sodax.near", msg: JSON.stringify({ to: [9], data }) };
    const tx = nearTxFrom({
      ...fixtures.near.outcome,
      transaction: {
        receiver_id: "token.near",
        actions: [
          {
            FunctionCall: {
              method_name: "ft_transfer_call",
              args: Buffer.from(JSON.stringify(args)).toString("base64"),
            },
          },
        ],
      },
    });
    expect(tx?.calls.map(call => call.contract)).toEqual(["token.near", "asset-manager.sodax.near"]);
    expect(carriesPayload(tx as NonEvmTx, "0x010203", "NEAR")).toBe(true);
    expect(carriesPayload(tx as NonEvmTx, "0x0102", "NEAR")).toBe(false);
  });

  it("never matches an empty payload", () => {
    expect(carriesPayload(RAW_TXS.stellar, "0x", "STELLAR")).toBe(false);
  });
});

describe("callsAssetManager, on real deposits", () => {
  it.each([
    ["solana", RAW_TXS.solana],
    ["stellar", RAW_TXS.stellar],
    ["sui", RAW_TXS.sui],
    ["near", near],
    ["injective-1", injective],
  ] as const)("finds %s's asset manager", (chainKey, tx) => {
    const family = {
      solana: "SOLANA",
      stellar: "STELLAR",
      sui: "SUI",
      near: "NEAR",
      "injective-1": "INJECTIVE",
    } as const;
    const marker = assetManagerMarker(chainKey, family[chainKey]);
    expect(marker).toBeDefined();
    expect(callsAssetManager(tx as NonEvmTx, marker as Uint8Array | string)).toBe(true);
  });

  // Worked out from the packaged config without the SDK, so they must be the bytes the SDK's own encoding holds.
  it("names Solana's and Stellar's asset manager by the bytes the SDK encodes them as", () => {
    const sdkBytes = (chainKey: "solana" | "stellar") =>
      Buffer.from(encodeAddress(chainKey, spokeChainConfig[chainKey].addresses.assetManager).slice(2), "hex");
    expect(Buffer.from(assetManagerMarker("solana", "SOLANA") as Uint8Array)).toEqual(sdkBytes("solana"));
    expect(Buffer.from(assetManagerMarker("stellar", "STELLAR") as Uint8Array)).toEqual(
      sdkBytes("stellar").subarray(-32),
    );
  });

  it("doesn't find it in a tx that never calls it", () => {
    const marker = assetManagerMarker("solana", "SOLANA") as Uint8Array;
    expect(callsAssetManager({ failed: false, bytes: new Uint8Array(64), calls: [] }, marker)).toBe(false);
  });
});

describe("the readers' parsers", () => {
  it("reads a Solana tx's outcome, and waits for one not confirmed yet", () => {
    expect(solanaTxFrom(solanaTx({ InstructionError: [2, "Custom"] }))?.failed).toBe(true);
    expect(solanaTxFrom({ meta: null, transaction: { message: { serialize: () => new Uint8Array() } } })).toBeNull();
    expect(solanaTxFrom(null)).toBeNull();
  });

  it("reads a Stellar envelope as base64 or as XDR, and fails on a status it doesn't know", () => {
    const bytes = base64(fixtures.stellar.envelopeXdr);
    expect(stellarTxFrom({ status: "FAILED", envelopeXdr: { toXDR: () => bytes } })).toEqual({
      failed: true,
      bytes,
      calls: [],
    });
    expect(stellarTxFrom({ status: "NOT_FOUND" })).toBeNull();
    expect(() => stellarTxFrom({ status: "PENDING" })).toThrow();
  });

  it("fails on a NEAR stage it doesn't know rather than wait for it", () => {
    expect(nearTxFrom({ final_execution_status: "NONE" })).toBeNull();
    expect(() => nearTxFrom({ ...fixtures.near.outcome, final_execution_status: "REVERTED" })).toThrow();
  });

  it("reads a NEAR deposit's calls", () => {
    expect(near).toMatchObject({ failed: false, calls: [{ contract: "asset-manager.sodax.near" }] });
  });

  it("waits for a NEAR tx still in flight, which comes back with its stage alone", () => {
    expect(nearTxFrom({ final_execution_status: "INCLUDED" })).toBeNull();
    expect(nearTxFrom({ ...fixtures.near.outcome, final_execution_status: "INCLUDED_FINAL" })).toBeNull();
  });

  const withStatus = (index: number) => {
    const receipts = fixtures.near.outcome.receipts_outcome.map((receipt, i) =>
      i === index ? { ...receipt, outcome: { ...receipt.outcome, status: { Failure: { ActionError: {} } } } } : receipt,
    );
    return nearTxFrom({ ...fixtures.near.outcome, receipts_outcome: receipts });
  };

  it("fails a NEAR tx whose first call failed: nothing moved", () => {
    expect(withStatus(0)?.failed).toBe(true);
  });

  it("leaves a NEAR tx whose later receipt failed to the relay: NEAR doesn't roll that back", () => {
    expect(withStatus(1)?.failed).toBe(false);
  });

  // The receipt graph of a live `tx` answer, as the RPC returns it (executor_id and receipt_ids per receipt).
  const AM = "asset-manager.sodax.near";
  const receipt = (id: string, executor: string, children: string[], failed = false) => ({
    id,
    outcome: {
      executor_id: executor,
      receipt_ids: children,
      status: failed ? { Failure: { ActionError: {} } } : { SuccessValue: "" },
    },
  });
  const graph = (firstId: string, receipts: ReturnType<typeof receipt>[]) => ({
    ...fixtures.near.outcome,
    transaction_outcome: { outcome: { status: { SuccessReceiptId: firstId }, receipt_ids: [firstId] } },
    receipts_outcome: receipts,
  });

  it("fails a NEAR token deposit the asset manager rejected: the token refunds it", () => {
    const rejected = graph("ft", [
      receipt("ft", "usdc.near", ["onTransfer", "resolve"]),
      receipt("onTransfer", AM, [], true),
      receipt("resolve", "usdc.near", []),
    ]);
    expect(nearTxFrom(rejected, AM)?.failed).toBe(true);
  });

  it("fails a NEAR meta-transaction whose delegated deposit the asset manager rejected", () => {
    const rejected = graph("delegate", [
      receipt("delegate", "user.near", ["deposit"]),
      receipt("deposit", AM, [], true),
    ]);
    expect(nearTxFrom(rejected, AM)?.failed).toBe(true);
  });

  it("fails a NEAR meta-transaction whose inner call failed before the asset manager ran: nothing moved", () => {
    const delegate = {
      Delegate: {
        delegate_action: {
          sender_id: "alice.near",
          receiver_id: AM,
          actions: [{ FunctionCall: { method_name: "transfer", args: Buffer.from("{}").toString("base64") } }],
        },
      },
    };
    const stopped = {
      ...graph("delegate", [receipt("delegate", "alice.near", ["inner"]), receipt("inner", "alice.near", [], true)]),
      transaction: { signer_id: "relayer.near", receiver_id: "alice.near", actions: [delegate] },
    };
    expect(nearTxFrom(stopped, AM)).toMatchObject({ failed: true, signer: "alice.near" });
  });

  it("names a NEAR tx's signer, a meta-transaction's own sender rather than its relayer", () => {
    expect(nearTxFrom(fixtures.near.outcome)?.signer).toBe(fixtures.near.outcome.transaction.signer_id);
  });

  it("doesn't fail a NEAR deposit whose asset manager callback failed after it sent the message", () => {
    const later = graph("deposit", [
      receipt("deposit", AM, ["send", "callback"]),
      receipt("send", "connection.sodax.near", []),
      receipt("callback", AM, [], true),
    ]);
    expect(nearTxFrom(later, AM)?.failed).toBe(false);
  });

  it("reads a NEAR meta-transaction's delegated calls", () => {
    const args = Buffer.from(JSON.stringify({ data: [1, 2, 3] })).toString("base64");
    const delegate = {
      Delegate: {
        delegate_action: {
          receiver_id: "asset-manager.sodax.near",
          actions: [{ FunctionCall: { method_name: "transfer", args } }],
        },
      },
    };
    const tx = nearTxFrom({
      ...fixtures.near.outcome,
      transaction: { receiver_id: "user.near", actions: [delegate] },
    });
    expect(tx?.calls).toEqual([{ contract: "asset-manager.sodax.near", args: { data: [1, 2, 3] } }]);
  });

  it("reads a Sui tx's status and bytes, and fails on a shape it doesn't know rather than call it failed", () => {
    const bcs = new Uint8Array([1, 2]);
    const ran = { $kind: "Transaction", Transaction: { status: { success: true, error: null }, bcs } };
    expect(suiTxFrom(ran)).toEqual({ failed: false, bytes: bcs, calls: [] });
    const failed = { $kind: "FailedTransaction", FailedTransaction: { status: { success: false }, bcs } };
    expect(suiTxFrom(failed).failed).toBe(true);
    expect(() => suiTxFrom({ $kind: "Transaction", Transaction: { status: "ok" } })).toThrow();
  });

  it("fails an Injective tx with a non-zero code", () => {
    const body = { ...fixtures.injective.body, tx_response: { code: 5 } };
    expect(injectiveTxFrom(body).failed).toBe(true);
    expect(injective.failed).toBe(false);
  });
});

describe("normalizeTxHash", () => {
  const evm = `0x${"Ab".repeat(32)}`;
  it.each([
    ["EVM", evm, evm.toLowerCase()],
    ["EVM", "ab".repeat(32), undefined],
    ["STELLAR", fixtures.stellar.txHash, fixtures.stellar.txHash],
    ["STELLAR", `0x${fixtures.stellar.txHash.toUpperCase()}`, fixtures.stellar.txHash],
    ["INJECTIVE", fixtures.injective.txHash.toLowerCase(), fixtures.injective.txHash],
    ["INJECTIVE", `0x${fixtures.injective.txHash}`, fixtures.injective.txHash],
    ["NEAR", fixtures.near.txHash, fixtures.near.txHash],
    ["NEAR", fixtures.stellar.txHash, undefined],
    ["SUI", fixtures.sui.txHash, fixtures.sui.txHash],
    ["SOLANA", fixtures.solana.txHash, fixtures.solana.txHash],
    ["SOLANA", fixtures.sui.txHash, undefined],
    // The right length in characters, but 88 and 44 bytes: a node answers those with an error.
    ["SOLANA", "1".repeat(88), undefined],
    ["NEAR", "1".repeat(44), undefined],
  ] as const)("takes %s %s as %s", (family, value, expected) => {
    expect(normalizeTxHash(family, value)).toBe(expected);
  });

  it("lets every family's hash through the tool argument, and nothing with spaces or too short", () => {
    for (const { txHash } of Object.values(fixtures)) expect(isAnyTxHash(txHash)).toBe(true);
    expect(isAnyTxHash(`0x${"a".repeat(64)}`)).toBe(true);
    for (const value of ["0x1234", "abandon ability able", "a".repeat(63)]) {
      expect(isAnyTxHash(value)).toBe(false);
    }
  });
});

describe("toNonEvmStep", () => {
  it("keeps the SDK's raw tx, bigints as decimal strings and bytes as base64", () => {
    const raw = { from: "a", signedDoc: { bodyBytes: new Uint8Array([1, 2]), accountNumber: 7n }, list: [3n] };
    expect(toNonEvmStep("swap", "INJECTIVE", "injective-1", raw)).toEqual({
      kind: "swap",
      chainKey: "injective-1",
      chainType: "INJECTIVE",
      tx: { from: "a", signedDoc: { bodyBytes: "AQI=", accountNumber: "7" }, list: ["3"] },
    });
    expect(jsonSafe(Buffer.from([255]))).toBe("/w==");
  });

  it("refuses a raw tx that isn't an object", () => {
    expect(() => toNonEvmStep("swap", "SUI", "sui", "0x1234")).toThrow(expect.objectContaining({ code: "INTERNAL" }));
  });
});
