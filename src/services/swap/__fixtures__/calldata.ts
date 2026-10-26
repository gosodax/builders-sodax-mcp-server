/**
 * A minimal ABI encoder for the swap calldata the Swaps API builds, so a test stub can return what
 * the live API signs (calldata.test.ts checks it reproduces a recorded live tx byte for byte).
 * Independent of the decoder in calldata.ts on purpose. Not built.
 */

import type { SignedIntent } from "../calldata.js";

/** A 32-byte ABI word: a number, or a hex value left-padded. */
export const word = (value: bigint | string) =>
  (typeof value === "bigint" ? value.toString(16) : value.replace(/^0x/, "")).toLowerCase().padStart(64, "0");

/** `bytes`: its length, then the data right-padded to whole words. */
function bytes(hex: string): string {
  const data = hex.replace(/^0x/, "").toLowerCase();
  return word(BigInt(data.length / 2)) + data.padEnd(Math.ceil(data.length / 64) * 64, "0");
}

type Part = { word: string } | { tail: string };

/** Head words in order; each dynamic part as an offset into the tail after the head. */
function tuple(parts: Part[]): string {
  let head = "";
  let tail = "";
  for (const part of parts) {
    if ("word" in part) {
      head += part.word;
    } else {
      head += word(BigInt(parts.length * 32 + tail.length / 2));
      tail += part.tail;
    }
  }
  return head + tail;
}

export function encodeApprove(spender: string, amount: bigint): string {
  return `0x095ea7b3${word(spender)}${word(amount)}`;
}

export function encodeCreateIntent(intent: SignedIntent): string {
  const fields = tuple([
    { word: word(BigInt(intent.intentId)) },
    { word: word(intent.creator) },
    { word: word(intent.inputToken) },
    { word: word(intent.outputToken) },
    { word: word(BigInt(intent.inputAmount)) },
    { word: word(BigInt(intent.minOutputAmount)) },
    { word: word(BigInt(intent.deadline)) },
    { word: word(intent.allowPartialFill ? 1n : 0n) },
    { word: word(BigInt(intent.srcChain)) },
    { word: word(BigInt(intent.dstChain)) },
    { tail: bytes(intent.srcAddress) },
    { tail: bytes(intent.dstAddress) },
    { word: word(intent.solver) },
    { tail: bytes(intent.data) },
  ]);
  return `0x016f02e3${tuple([{ tail: fields }])}`;
}

/** The hub wallet's call list, `(address,uint256,bytes)[]`. */
export function encodeCalls(calls: { to: string; value: bigint; data: string }[]): string {
  const elements = calls.map(call =>
    tuple([{ word: word(call.to) }, { word: word(call.value) }, { tail: bytes(call.data) }]),
  );
  const list = word(BigInt(calls.length)) + tuple(elements.map(element => ({ tail: element })));
  return `0x${tuple([{ tail: list }])}`;
}

/** `transfer(token, to, amount, data)` on a spoke asset manager. */
export function encodeTransfer(token: string, to: string, amount: bigint, data: string): string {
  return `0xc6b4180b${tuple([{ word: word(token) }, { tail: bytes(to) }, { word: word(amount) }, { tail: bytes(data) }])}`;
}
