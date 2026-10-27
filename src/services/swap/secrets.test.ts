import { wordlist as czech } from "@scure/bip39/wordlists/czech";
import { wordlist as french } from "@scure/bip39/wordlists/french";
import { wordlist as italian } from "@scure/bip39/wordlists/italian";
import { wordlist as portuguese } from "@scure/bip39/wordlists/portuguese";
import { wordlist as spanish } from "@scure/bip39/wordlists/spanish";
import { describe, expect, it } from "vitest";
import { findSecret, screenSecrets, secretRefusalText } from "./secrets.js";

// Test secrets are built here, never real-looking keys: base58 / base32 filler of the right length.
const base58 = (length: number) => "9".repeat(length);
const ABANDON = `${"abandon ".repeat(11)}about`;

describe("findSecret", () => {
  it.each([
    ["a SODAX API key", `sodax_${"Ab3-".repeat(11)}`, "api_key"],
    ["a SODAX API key inside other text", `key is sodax_${"Ab3-".repeat(11)} ok`, "api_key"],
    ["a 12-word seed phrase", ABANDON, "seed_phrase"],
    ["a 13-word phrase (a passphrase word or a typo)", `${ABANDON} again`, "seed_phrase"],
    ["a 24-word seed phrase", `${"abandon ".repeat(23)}art`, "seed_phrase"],
    ["a 25-word phrase", `${"abandon ".repeat(23)}art zoo`, "seed_phrase"],
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
    ["11 BIP39 words", `${"abandon ".repeat(10)}about`],
    ["12 short words not in the BIP39 list", "foo bar baz qux quux corge grault garply waldo fred plugh xyzzy"],
    ["12 BIP39 words broken by one that isn't", `${"abandon ".repeat(6)}xyzzy ${"abandon ".repeat(5)}about`],
    ["12 BIP39 words no one list holds", `${"abandon ".repeat(6)}${"ábaco ".repeat(6)}`],
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
    ["with a trailing period", `${ABANDON}.`],
    ["hyphen-joined", `${"abandon-".repeat(11)}about`],
    [
      "numbered (1) word",
      Array.from({ length: 12 }, (_, i) => `(${i + 1}) ${i === 11 ? "about" : "abandon"}`).join(" "),
    ],
    ["after a prefix", `my seed: ${ABANDON}`],
    [
      "on numbered lines",
      Array.from({ length: 12 }, (_, i) => `${i + 1}.${i === 11 ? "about" : "abandon"}`).join("\n"),
    ],
  ])("finds a seed phrase written %s", (_case, value) => {
    expect(findSecret(value)).toBe("seed_phrase");
  });

  it.each([
    ["Czech", czech],
    ["French", french],
    ["Italian", italian],
    ["Portuguese", portuguese],
    ["Spanish", spanish],
  ])("finds a seed phrase in %s", (_language, list) => {
    expect(findSecret(list.slice(-12).join(" "))).toBe("seed_phrase");
  });

  it.each([
    ["as typed", "ácido acné aéreo afición ágil agonía águila alacrán álbum algodón almíbar ámbar"],
    ["decomposed", "ácido acné aéreo afición ágil agonía águila alacrán álbum algodón almíbar ámbar".normalize("NFD")],
    ["without its accents", "acido acne aereo aficion agil agonia aguila alacran album algodon almibar ambar"],
    ["uppercase", "ACADÉMIE ACQUÉRIR ADÉQUAT ADHÉSIF AÉRER AÉRONEF AGRÉABLE ALGÈBRE ALIÉNER ALLÉGER ALVÉOLE AMÉNAGER"],
  ])("finds an accented seed phrase written %s", (_case, value) => {
    expect(findSecret(value)).toBe("seed_phrase");
  });

  it("takes a Solana signature's shape for a tx hash in a tx-hash field, and nothing else", () => {
    expect(findSecret(base58(88), { txHash: true })).toBeUndefined();
    expect(findSecret(ABANDON, { txHash: true })).toBe("seed_phrase");
  });
});

describe("screenSecrets", () => {
  it("names the field and never the value, and tells the agent to rotate a SODAX key", () => {
    const refusal = (args: Record<string, unknown>) => {
      try {
        screenSecrets(args);
      } catch (error) {
        return error;
      }
    };
    expect(refusal({ chain: "arb", query: ABANDON })).toMatchObject({
      code: "SECRET_REJECTED",
      details: { field: "query" },
      nextStep: expect.stringContaining("treat it as exposed"),
    });
    expect(refusal({ address: `sodax_${"Ab3-".repeat(11)}` })).toMatchObject({
      code: "SECRET_REJECTED",
      nextStep: expect.stringContaining("rotate that SODAX API key"),
    });
    expect(JSON.stringify(refusal({ query: ABANDON }))).not.toContain("abandon");
  });

  it("refuses a 64-hex amount, but not a 64-digit decimal or a 64-hex value in a field that takes one", () => {
    const hex64 = "ab".repeat(32);
    expect(() => screenSecrets({ amount: hex64 })).toThrow(
      expect.objectContaining({ code: "SECRET_REJECTED", details: { field: "amount" } }),
    );
    expect(() => screenSecrets({ amount: "1".repeat(64) })).not.toThrow();
    expect(() => screenSecrets({ address: hex64 })).not.toThrow();
  });

  it("skips tx-hash fields: a value that passed their check is a tx hash", () => {
    expect(() => screenSecrets({ txHash: base58(88), cancelTxHash: base58(87) })).not.toThrow();
    expect(() => screenSecrets({ chain: base58(88) })).toThrow(expect.objectContaining({ code: "SECRET_REJECTED" }));
  });
});

describe("secretRefusalText", () => {
  it("gives the same refusal as text, a 64-hex value only where the field never takes one", () => {
    expect(secretRefusalText(ABANDON, {})).toBe(
      "SECRET_REJECTED: That looks like a private key, seed phrase or API key; it wasn't used or stored. Tell the user to treat it as exposed and move their funds, and never to paste it into a chat; ask for the wallet's public address instead.",
    );
    const hex64 = "ab".repeat(32);
    expect(secretRefusalText(hex64, { notHex64: "an amount" })).toMatch(
      /^SECRET_REJECTED: That's a 64-hex value, not an amount\. If it was a private key/,
    );
    expect(secretRefusalText(hex64, {})).toBeUndefined();
    expect(secretRefusalText("1,000", { notHex64: "an amount" })).toBeUndefined();
  });
});
