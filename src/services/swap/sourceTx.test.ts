import { describe, expect, it } from "vitest";
import {
  ASSET_MANAGER,
  CONNECTION,
  CREATOR,
  DEPOSIT_MESSAGE as MESSAGE,
  DEPOSIT_RECEIPT as RECEIPT,
  DEPOSIT_RELAY_DATA as RELAY_DATA,
  USER,
  messageReceipt as receiptWith,
} from "./__fixtures__/deposit.js";
import { abiEncode, rlpList } from "./__fixtures__/encode.js";
import {
  SEND_MESSAGE_SELECTOR,
  checkDeposit,
  decodeMessage,
  decodeRlpList,
  decodeSendMessage,
  holdsCancel,
} from "./sourceTx.js";

const WANT = { connection: CONNECTION, assetManager: ASSET_MANAGER, srcChain: "23", relayData: RELAY_DATA };

describe("decodeMessage", () => {
  it("decodes the live deposit: from Arbitrum's asset manager to the hub, with an RLP payload of 5 items", () => {
    expect(MESSAGE).toMatchObject({ srcChainId: 23n, dstChainId: 146n, srcAddress: ASSET_MANAGER.toLowerCase() });
    expect(decodeRlpList(MESSAGE?.payload ?? "")).toHaveLength(5);
  });

  it.each([
    ["truncated data", RECEIPT.logs[0].data.slice(0, -64)],
    ["an odd length", `${RECEIPT.logs[0].data}0`],
    ["not hex", `0x${"zz".repeat(32 * 6)}`],
    ["an offset past the end", `0x${"0".repeat(64)}${10_000n.toString(16).padStart(64, "0")}${"0".repeat(64 * 4)}`],
    ["an empty log", "0x"],
  ])("refuses %s", (_case, data) => {
    expect(decodeMessage(data)).toBeUndefined();
  });
});

describe("decodeRlpList", () => {
  it("round-trips a list of byte strings, short and long", () => {
    const items = ["0x01", "0x", `0x${"ab".repeat(60)}`, `0x${"cd".repeat(300)}`];
    expect(decodeRlpList(rlpList(items))).toEqual(items);
  });

  it.each([
    ["a nested list", `0x${"c3c201"}02`],
    ["bytes after the list", `${rlpList(["0x01"])}00`],
    ["an item running past the list", "0xc2830102"],
    ["a length field over 4 bytes", `0xfd${"00".repeat(4)}05`],
    ["a byte string, not a list", "0x8401020304"],
    ["not hex", "0xzz"],
  ])("refuses %s", (_case, hex) => {
    expect(decodeRlpList(hex)).toBeUndefined();
  });
});

describe("checkDeposit", () => {
  it("matches the quote's own deposit", () => {
    expect(checkDeposit(RECEIPT, WANT)).toBe("match");
  });

  it("calls a different payload, recipient, source chain or destination a mismatch", () => {
    const flipped = `${RELAY_DATA.payload.slice(0, -2)}${RELAY_DATA.payload.endsWith("00") ? "01" : "00"}`;
    expect(checkDeposit(RECEIPT, { ...WANT, relayData: { ...RELAY_DATA, payload: flipped } })).toBe("mismatch");
    expect(checkDeposit(RECEIPT, { ...WANT, relayData: { ...RELAY_DATA, address: CREATOR } })).toBe("mismatch");
    expect(checkDeposit(RECEIPT, { ...WANT, srcChain: "30" })).toBe("mismatch");
    const toAnotherHub = receiptWith({ dstChainId: 147n, payload: MESSAGE?.payload ?? "0x" });
    expect(checkDeposit(toAnotherHub, WANT)).toBe("mismatch");
  });

  it("finds no deposit from another contract, another sender (an approve's case) or another event", () => {
    expect(checkDeposit(RECEIPT, { ...WANT, connection: ASSET_MANAGER })).toBe("not_a_deposit");
    expect(checkDeposit(RECEIPT, { ...WANT, assetManager: USER })).toBe("not_a_deposit");
    const otherEvent = { reverted: false, logs: [{ ...RECEIPT.logs[0], topics: [`0x${"1".repeat(64)}`] }] };
    expect(checkDeposit(otherEvent, WANT)).toBe("not_a_deposit");
    expect(checkDeposit({ reverted: false, logs: [] }, WANT)).toBe("not_a_deposit");
  });
});

describe("holdsCancel", () => {
  const PAYLOAD = `0x${"ef".repeat(40)}`;
  const want = { connection: CONNECTION, srcAddress: USER, srcChain: "23", creator: CREATOR, payload: PAYLOAD };

  it("finds the user's message to their hub wallet with the cancel payload", () => {
    expect(holdsCancel(receiptWith({ srcAddress: USER, payload: PAYLOAD }), want)).toBe(true);
  });

  it("refuses another payload, sender, recipient or contract", () => {
    expect(holdsCancel(receiptWith({ srcAddress: USER, payload: "0x01" }), want)).toBe(false);
    expect(holdsCancel(receiptWith({ payload: PAYLOAD }), want)).toBe(false);
    expect(holdsCancel(receiptWith({ srcAddress: USER, dstAddress: USER, payload: PAYLOAD }), want)).toBe(false);
    expect(holdsCancel(receiptWith({ srcAddress: USER, payload: PAYLOAD }, ASSET_MANAGER), want)).toBe(false);
  });
});

describe("decodeSendMessage", () => {
  it("decodes sendMessage calldata", () => {
    const data = `${SEND_MESSAGE_SELECTOR}${abiEncode([146n, CREATOR, "0x0102"]).slice(2)}`;
    expect(decodeSendMessage(data)).toEqual({ dstChainId: 146n, dstAddress: CREATOR, payload: "0x0102" });
  });

  it("refuses another function or cut-off arguments", () => {
    expect(decodeSendMessage(`0xa9059cbb${abiEncode([146n, CREATOR, "0x0102"]).slice(2)}`)).toBeUndefined();
    expect(decodeSendMessage(SEND_MESSAGE_SELECTOR)).toBeUndefined();
  });
});
