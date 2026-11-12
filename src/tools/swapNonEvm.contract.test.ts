/**
 * Swaps from non-EVM chains against live chains: `pnpm test:contract`. Reads and unsigned builds only. Only what
 * stays checkable: NEAR builds without a read, Solana's and native Sui's builds need no funded sender, and Solana's
 * public RPC keeps old txs (Stellar's, Sui's and NEAR's public nodes drop them within days).
 */

import { spokeChainConfig } from "@sodax/types";
import { beforeAll, describe, expect, it } from "vitest";
import {
  buildNonEvmDeposit,
  callsPinnedTarget,
  createIntentPayload,
  decodeAddress,
  initSodax,
  intentHash,
  readNonEvmTx,
} from "../services/sodax.js";
import fixtures from "../services/swap/__fixtures__/non-evm-txs.json" with { type: "json" };
import { carriesPayload, toNonEvmStep } from "../services/swap/nonEvmSource.js";
import { getHubIntent } from "../services/swap/swapsApi.js";

beforeAll(async () => {
  await initSodax();
});

describe("swaps from non-EVM chains, live", () => {
  it.each([
    ["near", "NEAR", "NEAR"],
    ["solana", "SOLANA", "11111111111111111111111111111111"],
  ] as const)("builds a %s swap tx with the SDK that track's check takes", async (chainKey, family, token) => {
    const { intent } = fixtures[chainKey];
    const payload = createIntentPayload(intent) as string;
    const srcAddress = decodeAddress(chainKey, intent.srcAddress) as string;
    const raw = await buildNonEvmDeposit({
      srcChainKey: chainKey,
      srcAddress,
      token,
      amount: 1000n,
      to: intent.creator,
      payload,
    });
    const { tx } = toNonEvmStep("swap", family, chainKey, raw) as { tx: Record<string, unknown> };
    const signed =
      family === "NEAR"
        ? {
            failed: false,
            bytes: new Uint8Array(),
            calls: [{ contract: "", args: (raw as { params: { args: unknown } }).params.args }],
          }
        : { failed: false, bytes: Buffer.from(String(tx.data), "base64"), calls: [] };
    expect(carriesPayload(signed, payload, family)).toBe(true);
    // The fields the signing hint names, and the program Solana's build read from the chain.
    if (family === "NEAR") {
      expect(Object.keys(tx.params as object)).toEqual(
        expect.arrayContaining(["contractId", "method", "args", "deposit", "gas"]),
      );
      expect(tx.signerId).toBe(srcAddress);
    } else {
      expect(callsPinnedTarget(chainKey, "swap", raw)).toBe(true);
    }
  });

  it("builds a Sui swap tx with its sender set, so no other account's wallet signs it", async () => {
    const { intent } = fixtures.sui;
    const srcAddress = decodeAddress("sui", intent.srcAddress) as string;
    const raw = (await buildNonEvmDeposit({
      srcChainKey: "sui",
      srcAddress,
      token: spokeChainConfig.sui.nativeToken,
      amount: 1000n,
      to: intent.creator,
      payload: createIntentPayload(intent) as string,
    })) as { from: string; data: string };
    expect(raw.from).toBe(srcAddress);
    expect(JSON.parse(raw.data).sender).toBe(srcAddress);
  });

  // Each reader reaches into the SDK's own client for its family: an SDK upgrade that moves one shows up here, as an
  // error rather than "not found".
  it.each([
    ["solana", "SOLANA", "1".repeat(64)],
    ["stellar", "STELLAR", "0".repeat(64)],
    ["sui", "SUI", "1".repeat(32)],
    ["near", "NEAR", "1".repeat(32)],
    ["injective-1", "INJECTIVE", "0".repeat(64)],
  ] as const)("reads an unknown %s tx as not found", async (chainKey, family, txHash) => {
    await expect(readNonEvmTx(chainKey, family, txHash)).resolves.toBeNull();
  });

  // The relay creates the hub intent from the deposit, so the intent the Swaps API reads from that hub tx must be
  // the one whose payload the deposit carries (Solana: its keccak).
  it("finds the hub intent's payload in a real Solana deposit", async () => {
    const { txHash, hubTxHash } = fixtures.solana;
    const tx = await readNonEvmTx("solana", "SOLANA", txHash);
    const intent = await getHubIntent(hubTxHash);
    expect(tx?.failed).toBe(false);
    expect(intentHash(intent)).toBe(intentHash(fixtures.solana.intent));
    expect(carriesPayload(tx as NonNullable<typeof tx>, createIntentPayload(intent) as string, "SOLANA")).toBe(true);
  });
});
