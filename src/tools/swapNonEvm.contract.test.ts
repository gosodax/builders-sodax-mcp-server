/**
 * Swaps from non-EVM chains against live chains: `pnpm test:contract`. Reads and unsigned builds only. The builds
 * stay checkable where they need no funded sender (NEAR, Solana, native Sui); the readers are checked on the newest
 * messages the relay carried from each chain, which every public node still has, and on Solana's fixture deposit,
 * whose public RPC keeps old txs.
 */

import { getIntentRelayChainId, spokeChainConfig } from "@sodax/types";
import { beforeAll, describe, expect, it } from "vitest";
import { buildNonEvmDeposit, createIntentPayload, decodeAddress, initSodax } from "../services/sodax.js";
import fixtures from "../services/swap/__fixtures__/non-evm-txs.json" with { type: "json" };
import { toChain } from "../services/swap/resolver.js";
import { committedPayload } from "../services/swap/source.js";
import { HUB_RELAY_ID, checkDeposit, decodeRlpList, depositMessages } from "../services/swap/sourceTx.js";
import { pinnedSourceOf } from "../services/swap/sources/index.js";
import type { NonEvmStep, SwapSource, SwapToBuild } from "../services/swap/sources/types.js";

beforeAll(async () => {
  await initSodax();
});

const sourceOf = (chainKey: string): SwapSource => {
  const source = pinnedSourceOf(chainKey);
  if (source?.kind !== "spoke") throw new Error(`no spoke source for ${chainKey}`);
  return { ...source, chain: toChain(chainKey) };
};
/** The fixture's swap, rebuilt live for 1000 base units of `token`; `to` is what the Swaps API's build calls. */
function swapOf(chainKey: keyof typeof fixtures, token: string, to?: string): SwapToBuild {
  const { intent } = fixtures[chainKey];
  const srcAddress = decodeAddress(sourceOf(chainKey).chain.key, intent.srcAddress) as string;
  return {
    request: { srcChainKey: chainKey, srcAddress, inputToken: token, inputAmount: 1000n },
    built: { intent, relayData: { address: intent.creator, payload: createIntentPayload(intent) }, tx: { to } },
    approved: true,
    symbol: "TKN",
  } as unknown as SwapToBuild;
}

// SODAX's explorer, which lists what the relay carried from each chain, newest first, by relay id.
const EXPLORER = "https://sodaxscan.com/api/messages";

/** The source txs of the newest messages the relay carried from the chain. */
async function newestRelayed(chainKey: string, count: number): Promise<string[]> {
  const network = String(getIntentRelayChainId(chainKey as never));
  const response = await fetch(`${EXPLORER}?limit=100&skip=0&src_network=${network}`);
  const { data } = (await response.json()) as { data: { status: string; src_tx_hash: string | null }[] };
  const hashes = data.flatMap(row => (row.status === "executed" && row.src_tx_hash ? [row.src_tx_hash] : []));
  return [...new Set(hashes)].slice(0, count);
}

describe("swaps from non-EVM chains, live", () => {
  // Through the adapter: Solana's build must call the packaged programs it read from the chain.
  it.each([
    ["near", "NEAR"],
    ["solana", "11111111111111111111111111111111"],
  ] as const)("builds a %s swap tx with the SDK, as its wallet signs it", async (chainKey, token) => {
    const source = sourceOf(chainKey);
    const swap = swapOf(chainKey, token);
    const { steps } = await source.adapter.prepareSwap(source, swap);
    const { tx } = steps[0] as NonEvmStep & { tx: Record<string, unknown> };
    // The fields the signing hint names.
    if (chainKey === "near") {
      expect(Object.keys(tx.params as object)).toEqual(
        expect.arrayContaining(["contractId", "method", "args", "deposit", "gas"]),
      );
      expect(tx.signerId).toBe(swap.request.srcAddress);
    } else {
      expect(Object.keys(tx)).toEqual(expect.arrayContaining(["from", "to", "data"]));
    }
  });

  it("builds a Sui swap tx with its sender set, so no other account's wallet signs it", async () => {
    const source = sourceOf("sui");
    const token = spokeChainConfig.sui.nativeToken;
    const swap = swapOf("sui", token);
    // The package the SDK reads from the chain, as the Swaps API's own build would name it.
    const { to } = (await buildNonEvmDeposit({
      srcChainKey: "sui",
      srcAddress: swap.request.srcAddress,
      token,
      amount: 1000n,
      to: swap.built.intent.creator,
      payload: swap.built.relayData.payload,
    })) as { to: string };
    const { steps } = await source.adapter.prepareSwap(source, swapOf("sui", token, to));
    const { tx } = steps[0] as NonEvmStep & { tx: { from: string; data: string } };
    expect(tx.from).toBe(swap.request.srcAddress);
    expect(JSON.parse(tx.data).sender).toBe(swap.request.srcAddress);
  });

  // Each reader reaches into the SDK's own client for its family: an SDK upgrade that moves one shows up here, as an
  // error rather than "not found".
  it.each([
    ["solana", "SOLANA", "1".repeat(64)],
    ["stellar", "STELLAR", "0".repeat(64)],
    ["sui", "SUI", "1".repeat(32)],
    ["near", "NEAR", "1".repeat(32)],
    ["injective-1", "INJECTIVE", "0".repeat(64)],
  ] as const)("reads an unknown %s tx as not found", async (chainKey, _family, txHash) => {
    const source = sourceOf(chainKey);
    await expect(source.adapter.read(source, txHash)).resolves.toBeNull();
  });

  // What the relay carried, the reader must find: a message from that chain to the hub in each tx, and among them
  // the asset manager's deposits, named as `assetManagerSender` says, with their 5-item RLP payload.
  it.each(["solana", "stellar", "sui", "near", "injective-1"])(
    "finds the messages the relay carried in the newest %s txs",
    async chainKey => {
      const relayId = BigInt(getIntentRelayChainId(chainKey as never));
      const source = sourceOf(chainKey);
      const depositor = source.kind === "spoke" ? source.depositor : "";
      let read = 0;
      let deposits = 0;
      for (const txHash of await newestRelayed(chainKey, 5)) {
        const evidence = await source.adapter.read(source, txHash);
        // Past the public node's history (Injective's keeps under a day): unknown, as the README says.
        if (evidence === null) continue;
        read++;
        if (evidence.kind !== "spoke") throw new Error("a spoke read as the hub");
        expect(evidence.failed, txHash).toBe(false);
        const { messages } = evidence;
        expect(messages.length, txHash).toBeGreaterThan(0);
        for (const message of messages) expect(message.srcChainId, txHash).toBe(relayId);
        for (const deposit of depositMessages(messages, depositor)) {
          expect(deposit.dstChainId).toBe(HUB_RELAY_ID);
          expect(decodeRlpList(deposit.payload)).toHaveLength(5);
          deposits++;
        }
      }
      expect(read).toBeGreaterThan(0);
      expect(deposits).toBeGreaterThan(0);
    },
    60_000,
  );

  // The fixture's deposit read live: the RPC's answer must still be what the fixture holds.
  it("finds the fixture's Solana swap deposit live, binding its intent", async () => {
    const { txHash, intent } = fixtures.solana;
    const source = sourceOf("solana");
    const evidence = await source.adapter.read(source, txHash);
    if (evidence?.kind !== "spoke") throw new Error("no Solana deposit");
    expect(evidence.failed).toBe(false);
    const terms = {
      assetManager: source.kind === "spoke" ? source.depositor : "",
      srcChain: intent.srcChain,
      srcAddress: intent.srcAddress,
      to: intent.creator,
      data: committedPayload(source, createIntentPayload(intent) as string),
    };
    expect(checkDeposit(evidence.messages, terms)).toBe("match");
  });
});
