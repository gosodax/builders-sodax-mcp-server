/** Bytes as messages carry them (`0x` hex), and a bounds-checked reader for the chains' binary layouts. */

import { hexToBytes } from "@noble/hashes/utils";

/** Throws on anything but whole hex bytes, rather than drop what follows a bad character. */
export const hexBytes = (hex: string) => hexToBytes(hex.replace(/^0x/, ""));

export const hex = (bytes: Uint8Array) => `0x${Buffer.from(bytes).toString("hex")}`;
/** An account or object name as messages carry it: its UTF-8 bytes. */
export const utf8Hex = (text: string) => hex(Buffer.from(text, "utf8"));

/** Reads fixed layouts front to back; reading past the end throws, so a short or odd input is refused. */
export class ByteReader {
  constructor(
    private readonly bytes: Uint8Array,
    private at = 0,
  ) {}

  get done(): boolean {
    return this.at === this.bytes.length;
  }

  take(length: number): Uint8Array {
    if (!Number.isSafeInteger(length) || length < 0 || this.at + length > this.bytes.length) {
      throw new Error("read past the end");
    }
    const bytes = this.bytes.subarray(this.at, this.at + length);
    this.at += length;
    return bytes;
  }

  /** A little-endian unsigned integer of `size` bytes (Borsh, BCS). */
  uintLE(size: number): bigint {
    return BigInt(`0x${Buffer.from(this.take(size)).reverse().toString("hex") || "0"}`);
  }

  uintLE32(): number {
    return Number(this.uintLE(4));
  }

  /** A big-endian unsigned integer of `size` bytes (XDR). */
  uintBE(size: number): bigint {
    return BigInt(`0x${Buffer.from(this.take(size)).toString("hex") || "0"}`);
  }

  uintBE32(): number {
    return Number(this.uintBE(4));
  }

  /** XDR's count of what follows, each at least `minSize` bytes: one the rest can't hold throws. */
  count(minSize: number): number {
    const count = this.uintBE32();
    if (count * minSize > this.bytes.length - this.at) throw new Error("read past the end");
    return count;
  }

  /** BCS's ULEB128 length. */
  uleb128(): number {
    let value = 0;
    for (let shift = 0; shift < 32; shift += 7) {
      const [byte] = this.take(1);
      value += (byte & 0x7f) * 2 ** shift;
      if (byte < 0x80) return value;
    }
    throw new Error("ULEB128 too long");
  }
}
