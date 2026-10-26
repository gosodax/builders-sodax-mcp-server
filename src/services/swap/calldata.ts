/**
 * Reads the swap calldata the Swaps API builds, by ABI position, so what the user signs can be
 * compared field by field with the quote. From a spoke chain the swap is
 * `transfer(token, to, amount, data)` on the asset manager; `data` is the call list the hub
 * wallet runs, `(address,uint256,bytes)[]`: approves of the hub asset, then `createIntent(intent)`.
 * Anything malformed throws.
 */

export const APPROVE_SELECTOR = "0x095ea7b3";
// transfer(address,bytes,uint256,bytes)
const TRANSFER_SELECTOR = "0xc6b4180b";
// createIntent((uint256,address,address,address,uint256,uint256,uint256,bool,uint256,uint256,bytes,bytes,address,bytes))
const CREATE_INTENT_SELECTOR = "0x016f02e3";

/** The intent as `createIntent` encodes it: numbers as decimal strings, addresses and bytes as `0x` hex. */
export interface SignedIntent {
  intentId: string;
  creator: string;
  inputToken: string;
  outputToken: string;
  inputAmount: string;
  minOutputAmount: string;
  deadline: string;
  allowPartialFill: boolean;
  srcChain: string;
  dstChain: string;
  srcAddress: string;
  dstAddress: string;
  solver: string;
  data: string;
}

export interface HubCall {
  to: string;
  value: bigint;
  data: string;
}

export interface SpokeSwap {
  token: string;
  /** The hub wallet the deposit goes to. */
  to: string;
  amount: bigint;
  /** The hub wallet's call list, as `relayData.payload` carries it. */
  payload: string;
  calls: HubCall[];
}

/** ABI words read by position from a region of hex (no `0x`); offsets are relative to that region. */
class AbiReader {
  constructor(private readonly hex: string) {}

  word(index: number): string {
    const start = index * 64;
    if (index < 0 || start + 64 > this.hex.length) throw new Error("ABI read past the end");
    return this.hex.slice(start, start + 64);
  }

  uint(index: number): bigint {
    return BigInt(`0x${this.word(index)}`);
  }

  address(index: number): string {
    const word = this.word(index);
    if (!/^0{24}/.test(word)) throw new Error("ABI address with high bits set");
    return `0x${word.slice(24)}`;
  }

  bool(index: number): boolean {
    const value = this.uint(index);
    if (value > 1n) throw new Error("ABI bool out of range");
    return value === 1n;
  }

  /** The region the offset in word `index` points at. */
  at(index: number): AbiReader {
    return new AbiReader(this.hex.slice(this.offset(index) * 2));
  }

  /** The region starting at word `index` (the elements after an array's length). */
  from(index: number): AbiReader {
    return new AbiReader(this.hex.slice(index * 64));
  }

  /** The `bytes` the offset in word `index` points at, as `0x` hex. */
  bytes(index: number): string {
    const region = this.at(index);
    const length = Number(region.uint(0));
    if (64 + length * 2 > region.hex.length) throw new Error("ABI bytes past the end");
    return `0x${region.hex.slice(64, 64 + length * 2)}`;
  }

  private offset(index: number): number {
    const offset = this.uint(index);
    if (offset * 2n > BigInt(this.hex.length)) throw new Error("ABI offset past the end");
    return Number(offset);
  }
}

/** The arguments of a call with the given selector. */
function args(calldata: string, selector: string): AbiReader {
  const hex = calldata.toLowerCase();
  if (!hex.startsWith(selector)) throw new Error("Unexpected function selector");
  return new AbiReader(hex.slice(10));
}

export function decodeSpokeSwap(calldata: string): SpokeSwap {
  const transfer = args(calldata, TRANSFER_SELECTOR);
  const payload = transfer.bytes(3);
  const list = new AbiReader(payload.slice(2)).at(0);
  const count = Number(list.uint(0));
  const elements = list.from(1);
  const calls = Array.from({ length: count }, (_, i) => {
    const call = elements.at(i);
    return { to: call.address(0), value: call.uint(1), data: call.bytes(2) };
  });
  return { token: transfer.address(0), to: transfer.bytes(1), amount: transfer.uint(2), payload, calls };
}

export function decodeApprove(calldata: string): { spender: string; amount: bigint } {
  const approve = args(calldata, APPROVE_SELECTOR);
  return { spender: approve.address(0), amount: approve.uint(1) };
}

export function decodeCreateIntent(calldata: string): SignedIntent {
  const intent = args(calldata, CREATE_INTENT_SELECTOR).at(0);
  return {
    intentId: intent.uint(0).toString(),
    creator: intent.address(1),
    inputToken: intent.address(2),
    outputToken: intent.address(3),
    inputAmount: intent.uint(4).toString(),
    minOutputAmount: intent.uint(5).toString(),
    deadline: intent.uint(6).toString(),
    allowPartialFill: intent.bool(7),
    srcChain: intent.uint(8).toString(),
    dstChain: intent.uint(9).toString(),
    srcAddress: intent.bytes(10),
    dstAddress: intent.bytes(11),
    solver: intent.address(12),
    data: intent.bytes(13),
  };
}
