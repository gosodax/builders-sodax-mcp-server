/**
 * `sodax_swap_submit_and_track` and its deposit checks against live chains and the live Swaps API:
 * `pnpm test:contract` (production by default, `SODAX_ENV=canary` for canary). Reads only:
 * every POST to the Swaps API is refused here, so nothing is submitted or relayed, and nothing is signed.
 */

import { IntentsAbi } from "@sodax/sdk";
import { solverConfig, spokeChainConfig } from "@sodax/types";
import { http, type Hex, createPublicClient, decodeFunctionData } from "viem";
import { type MockInstance, afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { SODAX_ENV, SODAX_SWAPS_BASE_URL } from "../constants.js";
import { getEvmReceipt, hubIntentClosed, initSodax, intentHash, isHubChain } from "../services/sodax.js";
import { getAllChainsConfigs } from "../services/sodaxApi.js";
import { DEPOSIT_TX } from "../services/swap/__fixtures__/deposit.js";
import {
  HUB_RELAY_ID,
  INTENT_CREATED_TOPIC,
  connectionMessages,
  decodeRlpList,
  depositMessages,
  hubIntentHashes,
} from "../services/swap/sourceTx.js";
import { pinnedSourceOf } from "../services/swap/sources/index.js";
import { getHubIntent, getSubmitTxStatus } from "../services/swap/swapsApi.js";
import { getSwapCatalog } from "../services/swap/tokens.js";
import { cacheQuote } from "./__fixtures__/swapBackend.js";
import { callTool } from "./__fixtures__/swapClient.js";

const ARBITRUM = "0xa4b1.arbitrum";
const BASE = "0x2105.base";
const CANARY = SODAX_ENV === "canary";

/** Swaps tracked on canary: their deposit, hub and fill txs. */
const CANARY_SWAPS = [
  {
    chain: ARBITRUM,
    txHash: "0xb2d6b9666f0628a272649b99f1ec8777fe92f33ba2c79c50552244cc91798439",
    hubTxHash: "0x9255bd013a2173b94150c30e44d0efecc0a6cb4f0709745d1d1d0fde94ab4212",
    fillTxHash: "0xe594b7313a58c97cf48404e59f944f7f32a4b9b584aa6a988f410c6b9db36b26",
  },
  {
    chain: BASE,
    txHash: "0xdad436c587bf0158d1a44f5910bdc36d94ecb0e8501c40eb77ebea45370ea50b",
    hubTxHash: "0xdea241e5a1f08b811a04aa4f22eaac3dc92b8f3a931ff11d5c594ab2fb1e4773",
    fillTxHash: "0xb51eb8a5613ecdb5033059720ae577d1e21345afffc7eeaeadd97ed8f3bda316",
  },
];
/** The recorded Arbitrum deposit (unit-test fixture), a swap tracked on production. */
const PRODUCTION_SWAP = {
  chain: ARBITRUM,
  txHash: DEPOSIT_TX,
  hubTxHash: "0x561e78fe41cf684b29c7dc3b41fd441af253ccac616d89a7e3d366ee748b70a7",
  fillTxHash: "0xe4330ffda4485f6f7c7b10ed72a8090f406872ecceb28ef7110d0f633ada1480",
};
// Each host knows only its own swaps, and answers for them from its records.
const TRACKED = CANARY ? CANARY_SWAPS : [PRODUCTION_SWAP];

// The tests that read a tx's receipt or its intent take a recent one: a fixed tx ages out of what upstream serves.
const ARBITRUM_BLOCKS = 1_000_000n; // about three days
// Not the last minutes: the app behind a deposit that new may still be handing it to a Swaps API.
const ARBITRUM_SETTLED_BLOCKS = 4_000n;
const SONIC_BLOCKS = 50_000n; // about a day

const sonic = createPublicClient({ transport: http(spokeChainConfig.sonic.rpcUrl) });

const arbitrumAddresses = async () =>
  ((await getAllChainsConfigs()) as Record<string, { addresses: Record<string, string> }>)[ARBITRUM].addresses;

/** Loads once for every test that asks; a failed load is tried again by the next. */
function once<T>(load: () => Promise<T>): () => Promise<T> {
  let loaded: Promise<T> | undefined;
  return () => {
    loaded ??= load().catch(error => {
      loaded = undefined;
      throw error;
    });
    return loaded;
  };
}

/** The logs of each tx, in block order. */
function byTx<T extends { transactionHash: Hex }>(logs: T[]): Map<Hex, T[]> {
  const groups = new Map<Hex, T[]>();
  for (const log of logs) groups.set(log.transactionHash, [...(groups.get(log.transactionHash) ?? []), log]);
  return groups;
}

/** Arbitrum txs of the last days whose one deposit (a `Message` from the asset manager) went to the hub, newest first. */
const recentDeposits = once(async () => {
  const { connection, assetManager } = await arbitrumAddresses();
  const client = createPublicClient({ transport: http(spokeChainConfig[ARBITRUM].rpcUrl) });
  const toBlock = (await client.getBlockNumber()) - ARBITRUM_SETTLED_BLOCKS;
  const logs = await client.getLogs({ address: connection as Hex, fromBlock: toBlock - ARBITRUM_BLOCKS, toBlock });
  const found = [...byTx(logs)].flatMap(([txHash, txLogs]) => {
    const receipt = { reverted: false, blockNumber: 0n, txIndex: 0, logs: txLogs };
    const deposits = depositMessages(connectionMessages(receipt, connection), assetManager);
    return deposits.length === 1 && deposits[0].dstChainId === HUB_RELAY_ID ? [txHash] : [];
  });
  if (found.length === 0) throw new Error(`No deposit from Arbitrum to the hub in ${ARBITRUM_BLOCKS} blocks`);
  return found.reverse();
});

/**
 * A hub tx of the last hours that created one intent, filled in full in a later block. Read through the SDK's ABI,
 * not this server's log parsing, so a solved intent is known without the hub's state.
 */
const recentFilledHubTx = once(async () => {
  const toBlock = await sonic.getBlockNumber();
  const address = solverConfig.intentsContract as Hex;
  const range = { address, abi: IntentsAbi, fromBlock: toBlock - SONIC_BLOCKS, toBlock };
  const [created, filled] = await Promise.all([
    sonic.getContractEvents({ ...range, eventName: "IntentCreated" }),
    sonic.getContractEvents({ ...range, eventName: "IntentFilled" }),
  ]);
  // The event carries the state before the contract deletes it: a full fill leaves nothing to fill or pay.
  const goneIn = new Map(
    filled
      .filter(({ args }) => args.intentState?.remainingInput === 0n && !args.intentState.pendingPayment)
      .map(log => [log.args.intentHash, log.blockNumber]),
  );
  const log = [...byTx(created).values()]
    .flatMap(txLogs => (txLogs.length === 1 ? txLogs : []))
    .reverse()
    .find(log => (goneIn.get(log.args.intentHash) ?? 0n) > log.blockNumber);
  if (!log) throw new Error(`No intent created and filled in full on the hub in ${SONIC_BLOCKS} blocks`);
  return { hubTxHash: log.transactionHash, blockNumber: log.blockNumber };
});

const track = (args: Record<string, unknown>) => callTool("sodax_swap_submit_and_track", args);

let fetchSpy: MockInstance<typeof fetch>;
/** Every POST this server tried on the Swaps API (all refused). */
const swapsPosts = () =>
  fetchSpy.mock.calls.filter(([url, init]) => init?.method === "POST" && String(url).startsWith(SODAX_SWAPS_BASE_URL));

beforeAll(async () => {
  await initSodax();
  // An alert stays in the (silent) log.
  vi.stubEnv("DISCORD_WEBHOOK_URL", "");
  const realFetch = globalThis.fetch;
  fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    if (init?.method === "POST" && String(input).startsWith(SODAX_SWAPS_BASE_URL)) {
      return Promise.reject(new Error("POST refused in contract tests"));
    }
    return realFetch(input, init);
  });
});

afterAll(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("sodax_swap_submit_and_track against live chains and the live Swaps API", () => {
  it.each(TRACKED)("reports the swap from $chain as solved, with its hub and fill txs, each call", async swap => {
    for (let i = 0; i < 3; i++) {
      const { out } = await track({ txHash: swap.txHash, chain: swap.chain });
      expect(out).toMatchObject({ status: "solved", hubTxHash: swap.hubTxHash, fillTxHash: swap.fillTxHash });
      expect(out.retryAfterSec).toBeUndefined();
    }
    expect(swapsPosts()).toEqual([]);
  });

  it("reports a mined deposit it has no record of, without a quote, as unknown: no submit, no alert", async () => {
    // Another app's deposit, or a swap this host never saw.
    let txHash: Hex | undefined;
    for (const candidate of await recentDeposits()) {
      if ((await getSubmitTxStatus(candidate, ARBITRUM)) === null) {
        txHash = candidate;
        break;
      }
    }
    expect(txHash, "a recent deposit this host has no record of").toBeDefined();
    const { out } = await track({ txHash, chain: ARBITRUM });
    expect(out).toMatchObject({ status: "not_submitted_unknown_quote", isDeposit: true, alerted: false });
    expect(swapsPosts()).toEqual([]);
  });

  it("decodes an Arbitrum deposit against the live connection and asset manager", async () => {
    const { connection, assetManager } = await arbitrumAddresses();
    const [txHash] = await recentDeposits();
    const receipt = await getEvmReceipt(ARBITRUM, txHash);
    expect(receipt?.reverted).toBe(false);
    if (!receipt) return;
    // One `Message` log (MESSAGE_TOPIC) from the asset manager, to the hub.
    const messages = depositMessages(connectionMessages(receipt, connection), assetManager);
    expect(messages).toHaveLength(1);
    const [message] = messages;
    expect(message.dstChainId).toBe(HUB_RELAY_ID);
    const items = decodeRlpList(message.payload);
    expect(items).toHaveLength(5);

    // The sender's deposit, under a quote that carries another intent: never this quote's to submit.
    const deadline = String(Math.floor(Date.now() / 1000) + 15 * 60);
    const { quoteId } = await cacheQuote({ srcAddress: items?.[1], deadline });
    const { out } = await track({ txHash, quoteId });
    expect(out).toMatchObject({ status: "not_submitted", reason: "deposit_mismatch" });
    expect(swapsPosts()).toEqual([]);
  });

  // A swap from Sonic is proven by this log, so its layout is checked on real hub txs: the topic, the contract, and
  // the hash as its first data word, equal to the SDK's hash of the intent the Swaps API reads from the same tx.
  it("finds the intent's hash in the IntentCreated log of a recent hub tx", async () => {
    const { hubTxHash } = await recentFilledHubTx();
    const receipt = await getEvmReceipt("sonic", hubTxHash);
    const intent = await getHubIntent(hubTxHash);
    const logged = hubIntentHashes(
      receipt ?? { reverted: true, blockNumber: 0n, txIndex: 0, logs: [] },
      solverConfig.intentsContract,
      INTENT_CREATED_TOPIC,
    );
    expect(logged).toEqual([intentHash(intent).toLowerCase()]);
  });

  // Track and cancel ask the hub whether it still holds an intent; a solved one is gone from intentStates.
  it("reads the intent of a recent hub tx under its hash: held once created, gone once solved", async () => {
    const { hubTxHash, blockNumber } = await recentFilledHubTx();
    const hash = intentHash(await getHubIntent(hubTxHash)) as Hex;
    expect(await hubIntentClosed(hash, hubTxHash)).toBe(true);
    // Any unknown key reads as gone too: at its own block the intent is there, so the key and the decoding are right.
    const [exists] = await sonic.readContract({
      address: solverConfig.intentsContract as Hex,
      abi: IntentsAbi,
      functionName: "intentStates",
      args: [hash],
      blockNumber,
    });
    expect(exists).toBe(true);
  });

  // A wallet's own swap from Sonic: the hash logged is of the intent in its createIntent calldata, as sent.
  it("finds the hash of the intent a wallet sent from Sonic in its IntentCreated log", async () => {
    const hash = "0x01ff71f704e9d91a76b787c36d10a466e071224be547dd295b36b7db267ba002";
    const tx = await sonic.getTransaction({ hash });
    expect(tx.to?.toLowerCase()).toBe(solverConfig.intentsContract.toLowerCase());
    const { functionName, args } = decodeFunctionData({ abi: IntentsAbi, data: tx.input });
    expect(functionName).toBe("createIntent");
    const sent = Object.fromEntries(
      Object.entries(args?.[0] ?? {}).map(([key, value]) => [key, typeof value === "bigint" ? String(value) : value]),
    ) as unknown as Parameters<typeof intentHash>[0];
    expect(sent.srcChain).toBe("146");
    const receipt = await getEvmReceipt("sonic", hash);
    const logged = hubIntentHashes(
      receipt ?? { reverted: true, blockNumber: 0n, txIndex: 0, logs: [] },
      solverConfig.intentsContract,
      INTENT_CREATED_TOPIC,
    );
    expect(logged).toEqual([intentHash(sent).toLowerCase()]);
  });

  it("finds a connection and an https RPC in the SDK config for every EVM source chain", async () => {
    const catalog = await getSwapCatalog();
    const configs = (await getAllChainsConfigs()) as Record<string, { addresses?: { connection?: string } }>;
    const rpcs = spokeChainConfig as Record<string, { rpcUrl?: string }>;
    const sources = Object.keys(catalog.chains).filter(key => catalog.chains[key]?.type === "EVM" && !isHubChain(key));
    expect(sources.length).toBeGreaterThan(5);
    for (const key of sources) {
      const packaged = pinnedSourceOf(key);
      expect(packaged?.kind, key).toBe("spoke");
      const connection = packaged?.kind === "spoke" ? packaged.connection : undefined;
      expect(connection?.toLowerCase(), key).toBe(configs[key]?.addresses?.connection?.toLowerCase());
      expect(new URL(String(rpcs[key]?.rpcUrl)).protocol, key).toBe("https:");
    }
  });
});
