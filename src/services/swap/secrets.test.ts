import { describe, expect, it } from "vitest";
import { findSecret } from "./secrets.js";

// Test secrets are built here, never real-looking keys: base58 / base32 filler of the right length.
const base58 = (length: number) => "9".repeat(length);
const ABANDON = `${"abandon ".repeat(11)}about`;

describe("findSecret", () => {
  it.each([
    ["a SODAX API key", `sodax_${"Ab3-".repeat(11)}`, "api_key"],
    ["a SODAX API key inside other text", `key is sodax_${"Ab3-".repeat(11)} ok`, "api_key"],
    ["a 12-word seed phrase", ABANDON, "seed_phrase"],
    ["a 24-word seed phrase", `${"abandon ".repeat(23)}art`, "seed_phrase"],
    ["an extended private key", `xprv${base58(107)}`, "private_key"],
    ["a compressed Bitcoin WIF", `K${base58(51)}`, "private_key"],
    ["an uncompressed Bitcoin WIF", `5${base58(50)}`, "private_key"],
    ["a Solana secret key", base58(88), "private_key"],
    ["a Sui private key", `suiprivkey1${"q".repeat(59)}`, "private_key"],
    ["a Stellar secret seed", `S${"A".repeat(55)}`, "private_key"],
  ])("finds %s", (_case, value, kind) => {
    expect(findSecret(value)).toBe(kind);
  });

  it.each([
    ["a tool name", "sodax_get_money_market_reserve_assets"],
    ["a 13-word phrase", `${ABANDON} again`],
    ["a token name", "USD Coin"],
    ["an EVM address", "0x000000000000000000000000000000000000dEaD"],
    ["a tx hash (judged where the chain is known)", `0x${"ab".repeat(32)}`],
    ["a Solana address", base58(44)],
    ["a Stellar account", `G${"A".repeat(55)}`],
    ["a NEAR account", "alice.near"],
    ["a Bitcoin address", "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq"],
  ])("passes %s", (_case, value) => {
    expect(findSecret(value)).toBeUndefined();
  });

  it.each([
    ["capitalized", `Abandon ${"abandon ".repeat(10)}about`],
    ["uppercase", `${"ABANDON ".repeat(11)}ABOUT`],
    ["comma-separated", `${"abandon, ".repeat(11)}about`],
    ["numbered", Array.from({ length: 12 }, (_, i) => `${i + 1}. ${i === 11 ? "about" : "abandon"}`).join(" ")],
    ["quoted", `"${"abandon ".repeat(11)}about"`],
  ])("finds a seed phrase written %s", (_case, value) => {
    expect(findSecret(value)).toBe("seed_phrase");
  });
});
