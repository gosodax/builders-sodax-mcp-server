import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { encodeApprove, encodeCalls, encodeCreateIntent, encodeTransfer, word } from "./__fixtures__/calldata.js";
import { decodeApprove, decodeCreateIntent, decodeSpokeSwap } from "./calldata.js";

/** A live `POST /v1/swaps/intents` response (2026-10-26, nothing signed). */
function recorded(name: "built-intent-usdc-fee.json" | "built-intent-eth.json") {
  return JSON.parse(readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), "utf8"));
}

describe("decodeSpokeSwap", () => {
  it.each(["built-intent-usdc-fee.json", "built-intent-eth.json"] as const)(
    "reads a live swap tx (%s) back to the intent it was built from",
    name => {
      const { tx, intent, relayData } = recorded(name);
      const swap = decodeSpokeSwap(tx.data);
      expect(swap.to.toLowerCase()).toBe(intent.creator.toLowerCase());
      expect(swap.payload.toLowerCase()).toBe(relayData.payload.toLowerCase());
      expect(swap.calls.map(call => call.data.slice(0, 10))).toEqual(["0x095ea7b3", "0x016f02e3"]);
      const signed = decodeCreateIntent(swap.calls[1].data);
      for (const [field, value] of Object.entries(intent)) {
        expect(String(signed[field as keyof typeof signed]).toLowerCase(), field).toBe(String(value).toLowerCase());
      }
    },
  );

  it("decodes the gross amount and the source token, the fee coming out of the intent's input", () => {
    const { tx, intent } = recorded("built-intent-usdc-fee.json");
    const swap = decodeSpokeSwap(tx.data);
    expect(swap.token).toBe("0xaf88d065e77c8cc2239327c5edb3a432268e5831");
    expect(swap.amount).toBe(5000000n);
    expect(intent.inputAmount).toBe("4950000");
    expect(decodeApprove(swap.calls[0].data)).toEqual({ spender: swap.calls[1].to, amount: 5000000n });
  });

  it("matches the test encoder byte for byte, so stubs sign what the live API signs", () => {
    const { tx } = recorded("built-intent-usdc-fee.json");
    const swap = decodeSpokeSwap(tx.data);
    const [approve, create] = swap.calls;
    const { spender, amount } = decodeApprove(approve.data);
    const payload = encodeCalls([
      { to: approve.to, value: 0n, data: encodeApprove(spender, amount) },
      { to: create.to, value: 0n, data: encodeCreateIntent(decodeCreateIntent(create.data)) },
    ]);
    expect(encodeTransfer(swap.token, swap.to, swap.amount, payload)).toBe(tx.data.toLowerCase());
  });

  // Each case breaks one part of a recorded live tx.
  const live = recorded("built-intent-eth.json").tx.data.toLowerCase() as string;
  const head = (index: number) => 10 + index * 64;
  const withWord = (index: number, value: string) =>
    `${live.slice(0, head(index))}${value}${live.slice(head(index) + 64)}`;

  it.each([
    ["another function", `0xa9059cbb${live.slice(10)}`],
    ["a truncated word", live.slice(0, head(3) + 10)],
    ["an offset past the end", withWord(3, word(BigInt(live.length)))],
    ["an address with high bits set", withWord(0, "f".repeat(64))],
    // The `to` bytes start at the offset in word 1; their length is the first word there.
    ["bytes longer than the data", withWord(4, word(BigInt(live.length)))],
  ])("refuses %s", (_case, data) => {
    expect(() => decodeSpokeSwap(data)).toThrow();
  });

  it("refuses a bool that isn't 0 or 1", () => {
    const { tx } = recorded("built-intent-eth.json");
    const create = decodeSpokeSwap(tx.data).calls[1].data;
    const intent = decodeCreateIntent(create);
    const encoded = encodeCreateIntent(intent);
    // allowPartialFill is the 8th word of the tuple, after the selector and the tuple offset.
    const at = 10 + 64 + 7 * 64;
    expect(() => decodeCreateIntent(`${encoded.slice(0, at)}${word(2n)}${encoded.slice(at + 64)}`)).toThrow();
  });
});
