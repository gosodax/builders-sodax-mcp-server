/** Test encoders for what `sourceTx` decodes: ABI words and `bytes`, and RLP lists of byte strings. Not built. */

const word = (value: bigint) => value.toString(16).padStart(64, "0");

/** ABI-encodes a tuple: a bigint is a `uint256`, a hex string is `bytes`. */
export function abiEncode(values: (bigint | string)[]): string {
  let head = "";
  let tail = "";
  for (const value of values) {
    if (typeof value === "bigint") {
      head += word(value);
      continue;
    }
    const bytes = value.replace(/^0x/, "").toLowerCase();
    head += word(BigInt(values.length * 32 + tail.length / 2));
    tail += word(BigInt(bytes.length / 2)) + bytes.padEnd(Math.ceil(bytes.length / 64) * 64, "0");
  }
  return `0x${head}${tail}`;
}

/** An RLP list of byte strings, as hex. */
export function rlpList(items: string[]): string {
  const encoded = items.map(item => {
    const bytes = Buffer.from(item.replace(/^0x/, ""), "hex");
    return bytes.length === 1 && bytes[0] < 0x80 ? bytes : Buffer.concat([lengthPrefix(0x80, bytes.length), bytes]);
  });
  const body = Buffer.concat(encoded);
  return `0x${Buffer.concat([lengthPrefix(0xc0, body.length), body]).toString("hex")}`;
}

function lengthPrefix(base: number, length: number): Buffer {
  if (length <= 55) return Buffer.from([base + length]);
  const bytes = Buffer.from(length.toString(16).padStart(length > 0xff ? 4 : 2, "0"), "hex");
  return Buffer.concat([Buffer.from([base + 55 + bytes.length]), bytes]);
}
