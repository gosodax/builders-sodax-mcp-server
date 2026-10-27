/**
 * Secrets pasted into a swap tool's inputs. Only shapes that are never a legitimate input are
 * matched here, so no chain is needed to judge them. A bare 64-hex value can be an EVM private key
 * or a valid Sui/NEAR value, so it's judged where the chain is known (`rejectHex64`), or by a field
 * that never takes one.
 */

import { wordlist } from "@scure/bip39/wordlists/english";
import { ActionError } from "./errors.js";
import { AMOUNT_PATTERN } from "./units.js";

type SecretKind = "api_key" | "seed_phrase" | "private_key";

const BASE58 = "1-9A-HJ-NP-Za-km-z";
// 64 bytes in base58: a Solana secret key, or just as well a Solana tx signature.
const BASE58_64_BYTES = new RegExp(`^[${BASE58}]{86,88}$`);
const HEX64 = /^(?:0x)?[0-9a-fA-F]{64}$/;
const BIP39_WORDS = new Set(wordlist);
const SEED_PHRASE_MIN_WORDS = 12;

/** A run of 12 or more BIP39 English words, however they're cased, joined, numbered or prefixed. */
function hasSeedPhrase(text: string): boolean {
  let run = 0;
  for (const word of text.toLowerCase().split(/[^a-z]+/)) {
    if (!word) continue;
    run = BIP39_WORDS.has(word) ? run + 1 : 0;
    if (run >= SEED_PHRASE_MIN_WORDS) return true;
  }
  return false;
}

const SHAPES: [SecretKind, (text: string) => boolean][] = [
  // A SODAX key is `sodax_` + base64url; a tool name (`sodax_get_supported_chains`) has no capital, digit or `-`.
  // Matched in two linear steps: zod hands over values of any length.
  ["api_key", text => (text.match(/sodax_[A-Za-z0-9_-]{24,}/g) ?? []).some(key => /[A-Z0-9-]/.test(key.slice(6)))],
  ["seed_phrase", hasSeedPhrase],
  ["private_key", text => new RegExp(`^[xyzt]prv[${BASE58}]{100,}$`).test(text)],
  // Bitcoin WIF: uncompressed (5…, 51 chars) or compressed (K…/L…, 52); testnet c… / 9….
  ["private_key", text => new RegExp(`^[5KLc9][${BASE58}]{50,51}$`).test(text)],
  // A Solana secret key (an address is 32 bytes).
  ["private_key", text => BASE58_64_BYTES.test(text)],
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

function secretRefusal(kind: SecretKind, field?: string): ActionError {
  return new ActionError(
    "SECRET_REJECTED",
    "That looks like a private key, seed phrase or API key; it wasn't used or stored.",
    {
      details: { field },
      // The default next step covers keys and phrases; a SODAX key belongs in a header.
      ...(kind === "api_key" && {
        nextStep:
          "Tell the user to rotate that SODAX API key and send keys only as the x-api-key header, never as a tool input.",
      }),
    },
  );
}

function hex64Refusal(notA: string, field?: string): ActionError {
  return new ActionError("SECRET_REJECTED", `That's a 64-hex value, not ${notA}.`, {
    details: { field },
    nextStep:
      "If it was a private key, tell the user to treat it as exposed and move their funds; if it was a transaction hash, pass it to sodax_swap_track.",
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
