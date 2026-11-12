/**
 * Secrets pasted into a swap tool's inputs. Only shapes that are never a legitimate input are
 * matched here, so no chain is needed to judge them. A bare 64-hex value can be an EVM private key
 * or a valid Sui/NEAR value, so it's judged where the chain is known (`rejectHex64`), or by a field
 * that never takes one.
 */

import { wordlist as czech } from "@scure/bip39/wordlists/czech";
import { wordlist as english } from "@scure/bip39/wordlists/english";
import { wordlist as french } from "@scure/bip39/wordlists/french";
import { wordlist as italian } from "@scure/bip39/wordlists/italian";
import { wordlist as portuguese } from "@scure/bip39/wordlists/portuguese";
import { wordlist as spanish } from "@scure/bip39/wordlists/spanish";
import { SODAX_KEY_PATTERN, isSodaxKey } from "../../constants.js";
import { ActionError } from "./errors.js";
import { AMOUNT_PATTERN } from "./units.js";

// A 64-byte base58 value is a Solana secret key or, as often, a Solana tx signature: refused, but hedged.
type SecretKind = "api_key" | "seed_phrase" | "private_key" | "solana_key_or_signature";

const BASE58 = "1-9A-HJ-NP-Za-km-z";
// 64 bytes in base58: a Solana secret key, or just as well a Solana tx signature.
const BASE58_64_BYTES = new RegExp(`^[${BASE58}]{86,88}$`);
const HEX64 = /^(?:0x)?[0-9a-fA-F]{64}$/;
const SEED_PHRASE_MIN_WORDS = 12;

/** Lowercase with accents dropped ("Ábaco" → "abaco"): every Latin-script BIP39 word is then a-z only. */
const fold = (text: string) => text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
const BIP39_LISTS = [english, spanish, french, italian, portuguese, czech].map(list => new Set(list.map(fold)));

/** A run of 12 or more words from one BIP39 list, however they're cased, accented, joined, numbered or prefixed. */
function hasSeedPhrase(text: string): boolean {
  const runs = BIP39_LISTS.map(() => 0);
  for (const word of fold(text).split(/[^a-z]+/)) {
    if (!word) continue;
    for (const [i, list] of BIP39_LISTS.entries()) {
      runs[i] = list.has(word) ? runs[i] + 1 : 0;
      if (runs[i] >= SEED_PHRASE_MIN_WORDS) return true;
    }
  }
  return false;
}

const SHAPES: [SecretKind, (text: string) => boolean][] = [
  // Matched in two linear steps: zod hands over values of any length.
  ["api_key", text => (text.match(SODAX_KEY_PATTERN) ?? []).some(isSodaxKey)],
  ["seed_phrase", hasSeedPhrase],
  ["private_key", text => new RegExp(`^[xyzt]prv[${BASE58}]{100,}$`).test(text)],
  // Bitcoin WIF: uncompressed (5…, 51 chars) or compressed (K…/L…, 52); testnet c… / 9….
  ["private_key", text => new RegExp(`^[5KLc9][${BASE58}]{50,51}$`).test(text)],
  // A Solana secret key or tx signature (an address is 32 bytes).
  ["solana_key_or_signature", text => BASE58_64_BYTES.test(text)],
  ["private_key", text => /^suiprivkey1[02-9ac-hj-np-z]{50,}$/.test(text)],
  // A Stellar secret seed (an account address starts with G).
  ["private_key", text => /^S[A-Z2-7]{55}$/.test(text)],
];

/** `txHash`: the value is in a tx-hash field, where a Solana signature's shape is a hash (the ADR exempts them). */
export function findSecret(value: string, { txHash = false } = {}): SecretKind | undefined {
  const text = value.trim();
  if (txHash && BASE58_64_BYTES.test(text)) return undefined;
  return SHAPES.find(([, matches]) => matches(text))?.[0];
}

/** For a value that is a key or, as often, something else of the same shape. */
const ifKeyElse = (other: string) =>
  `If it was a private key, tell the user to treat it as exposed and move their funds; if it was ${other}.`;

function secretRefusal(kind: SecretKind, field?: string): ActionError {
  const solana = kind === "solana_key_or_signature";
  return new ActionError(
    "SECRET_REJECTED",
    solana
      ? "That's a 64-byte base58 value, a Solana secret key or a transaction signature; it wasn't used or stored."
      : "That looks like a private key, seed phrase or API key; it wasn't used or stored.",
    {
      details: { field },
      // The default next step covers keys and phrases; a SODAX key belongs in a header.
      ...(kind === "api_key" && {
        nextStep:
          "Tell the user to rotate that SODAX API key in the partner portal (https://portal.sodax.com) and send keys only as the x-api-key header, never as a tool input.",
      }),
      ...(solana && {
        nextStep: ifKeyElse("a transaction signature, this field doesn't take one, so ask for what it needs"),
      }),
    },
  );
}

function hex64Refusal(notA: string, field?: string): ActionError {
  return new ActionError("SECRET_REJECTED", `That's a 64-hex value, not ${notA}.`, {
    details: { field },
    nextStep: ifKeyElse("a transaction hash, pass it to sodax_swap_submit_and_track"),
  });
}

// A value that passed a tx-hash field's own check is a tx hash, which the ADR exempts.
const TX_HASH_FIELDS = new Set(["txHash", "cancelTxHash"]);
// Fields whose zod check lets a bare 64-hex value through, though they never take one.
const NOT_HEX64_FIELDS = new Map([["amount", "an amount"]]);

/** Refuses the first string argument that looks like a secret, naming the field, never the value. */
export function screenSecrets(args: Record<string, unknown>): void {
  for (const [field, value] of Object.entries(args)) {
    if (typeof value !== "string" || TX_HASH_FIELDS.has(field)) continue;
    const kind = findSecret(value);
    if (kind) throw secretRefusal(kind, field);
    const notA = NOT_HEX64_FIELDS.get(field);
    // 64 decimal digits are an amount, if a huge one.
    if (notA && HEX64.test(value) && !AMOUNT_PATTERN.test(value)) throw hex64Refusal(notA, field);
  }
}

/**
 * Refuses a bare 64-hex value that isn't valid on the chain: an EVM private key, or as often a tx hash
 * in the wrong field. Called where the chain is known, after the value failed to be an address or token.
 */
export function rejectHex64(value: string, field: string, chainName: string, expected: "address" | "token"): void {
  if (!HEX64.test(value)) return;
  throw hex64Refusal(`${expected === "address" ? "an address" : "a token"} on ${chainName}`, field);
}

/**
 * The same for a 64-hex token query that is a valid account on the chain (a NEAR contract account, a Sui
 * package id): a token this list doesn't have, or a private key; the refusal says it may be either.
 */
export function rejectHex64Account(value: string, field: string, chainName: string): void {
  if (!HEX64.test(value)) return;
  throw new ActionError(
    "SECRET_REJECTED",
    `That's a 64-hex value: no token SODAX swaps on ${chainName} has that address, and it may be a private key.`,
    {
      details: { field },
      nextStep: ifKeyElse(`a token's address, SODAX doesn't swap that token on ${chainName}: ask the user for another`),
    },
  );
}

/** `notHex64` names what a field that never holds a bare 64-hex value takes instead ("a quoteId"). */
export interface SecretField {
  txHash?: boolean;
  notHex64?: string;
}

/**
 * The same refusal as text, for a value that failed its field's own check: zod runs before the handler's
 * screening and can only answer in text.
 */
export function secretRefusalText(value: string, field: SecretField): string | undefined {
  const kind = findSecret(value, { txHash: field.txHash });
  const refusal = kind
    ? secretRefusal(kind)
    : field.notHex64 && HEX64.test(value.trim())
      ? hex64Refusal(field.notHex64)
      : undefined;
  return refusal && `${refusal.code}: ${refusal.message} ${refusal.nextStep}`;
}
