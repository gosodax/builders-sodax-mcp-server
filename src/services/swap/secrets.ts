/**
 * Secrets pasted into a swap tool's inputs. Only shapes that are never a legitimate input are
 * matched here, so no chain is needed to judge them. A bare 64-hex value can be an EVM private key
 * or a valid Sui/NEAR value, so it's judged where the chain is known (`rejectHex64`).
 */

import { ActionError } from "./errors.js";

type SecretKind = "api_key" | "seed_phrase" | "private_key";

const BASE58 = "1-9A-HJ-NP-Za-km-z";
const SEED_PHRASE_LENGTHS = [12, 15, 18, 21, 24];

const SHAPES: [SecretKind, (text: string) => boolean][] = [
  // A SODAX key is `sodax_` + base64url; a tool name (`sodax_get_supported_chains`) has no capital, digit or `-`.
  ["api_key", text => /sodax_(?=[A-Za-z0-9_-]*[A-Z0-9-])[A-Za-z0-9_-]{24,}/.test(text)],
  // A BIP39 phrase: 12 to 24 English words of 3 to 8 letters, as wallets show them: any case,
  // spaced, comma-separated, quoted or numbered ("1. abandon 2. ability …").
  [
    "seed_phrase",
    text => {
      const words = text
        .toLowerCase()
        .split(/[\s,;"'`]+/)
        .filter(word => word && !/^\d+[.):]?$/.test(word));
      return SEED_PHRASE_LENGTHS.includes(words.length) && words.every(word => /^[a-z]{3,8}$/.test(word));
    },
  ],
  ["private_key", text => new RegExp(`^[xyzt]prv[${BASE58}]{100,}$`).test(text)],
  // Bitcoin WIF: uncompressed (5…, 51 chars) or compressed (K…/L…, 52); testnet c… / 9….
  ["private_key", text => new RegExp(`^[5KLc9][${BASE58}]{50,51}$`).test(text)],
  // A Solana secret key: 64 bytes in base58 (an address is 32).
  ["private_key", text => new RegExp(`^[${BASE58}]{86,88}$`).test(text)],
  ["private_key", text => /^suiprivkey1[02-9ac-hj-np-z]{50,}$/.test(text)],
  // A Stellar secret seed (an account address starts with G).
  ["private_key", text => /^S[A-Z2-7]{55}$/.test(text)],
];

export function findSecret(value: string): SecretKind | undefined {
  const text = value.trim();
  return SHAPES.find(([, matches]) => matches(text))?.[0];
}

/** Refuses the first string argument that looks like a secret, naming the field, never the value. */
export function screenSecrets(args: Record<string, unknown>): void {
  for (const [field, value] of Object.entries(args)) {
    const kind = typeof value === "string" ? findSecret(value) : undefined;
    if (!kind) continue;
    throw new ActionError(
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
}

/**
 * Refuses a bare 64-hex value that isn't valid on the chain: an EVM private key, or as often a tx hash
 * in the wrong field. Called where the chain is known, after the value failed to be an address or token.
 */
export function rejectHex64(value: string, field: string, chainName: string, expected: "address" | "token"): void {
  if (!/^(?:0x)?[0-9a-fA-F]{64}$/.test(value)) return;
  throw new ActionError(
    "SECRET_REJECTED",
    `That's a 64-hex value, not ${expected === "address" ? "an address" : "a token"} on ${chainName}.`,
    {
      details: { field },
      nextStep:
        "If it was a private key, tell the user to treat it as exposed and move their funds; if it was a transaction hash, pass it to sodax_swap_track.",
    },
  );
}
