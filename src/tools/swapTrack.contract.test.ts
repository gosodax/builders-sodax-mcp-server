/**
 * `sodax_swap_track` and its deposit checks against live chains and the live Swaps API:
 * `pnpm test:contract` (canary by default, `SODAX_ENV=production` for production). Reads only:
 * every POST to the Swaps API is refused here, so nothing is submitted or relayed, and nothing is signed.
 */

import { spokeChainConfig } from "@sodax/types";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { SODAX_SWAPS_BASE_URL } from "../constants.js";
import { evmSpokeFor, getEvmReceipt, initSodax, isHubChain } from "../services/sodax.js";
import { getAllChainsConfigs } from "../services/sodaxApi.js";
import { DEPOSIT_TX } from "../services/swap/__fixtures__/deposit.js";
import { HUB_RELAY_ID, decodeRlpList, depositMessages } from "../services/swap/sourceTx.js";
import { getSwapCatalog } from "../services/swap/tokens.js";
import { cacheQuote } from "./__fixtures__/swapBackend.js";
import { callTool } from "./__fixtures__/swapClient.js";

const ARBITRUM = "0xa4b1.arbitrum";
const BASE = "0x2105.base";
const CANARY = process.env.SODAX_ENV !== "production";

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
// Each host knows only its own swaps: the other host's deposit is a mined one it has no record of.
const TRACKED = CANARY ? CANARY_SWAPS : [PRODUCTION_SWAP];
const UNKNOWN = CANARY ? PRODUCTION_SWAP : CANARY_SWAPS[0];

const track = (args: Record<string, unknown>) => callTool("sodax_swap_track", args);

let fetchSpy: ReturnType<typeof vi.spyOn<typeof globalThis, "fetch">>;
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

describe("sodax_swap_track against live chains and the live Swaps API", () => {
  it.each(TRACKED)("reports the swap from $chain as solved, with its hub and fill txs, each call", async swap => {
    for (let i = 0; i < 3; i++) {
      const { out } = await track({ txHash: swap.txHash, chain: swap.chain });
      expect(out).toMatchObject({ status: "solved", hubTxHash: swap.hubTxHash, fillTxHash: swap.fillTxHash });
      expect(out.retryAfterSec).toBeUndefined();
    }
    expect(swapsPosts()).toEqual([]);
  });

  it("reports a mined deposit it has no record of, without a quote, as unknown: no submit, no alert", async () => {
    const { out } = await track({ txHash: UNKNOWN.txHash, chain: UNKNOWN.chain });
    expect(out).toMatchObject({ status: "not_submitted_unknown_quote", isDeposit: true, alerted: false });
    expect(swapsPosts()).toEqual([]);
  });

  it("decodes the Arbitrum deposit against the live connection and asset manager", async () => {
    const configs = (await getAllChainsConfigs()) as Record<string, { addresses: Record<string, string> }>;
    const { connection, assetManager } = configs[ARBITRUM].addresses;
    const receipt = await getEvmReceipt(ARBITRUM, CANARY_SWAPS[0].txHash);
    expect(receipt?.reverted).toBe(false);
    if (!receipt) return;
    // One `Message` log (MESSAGE_TOPIC) from the asset manager, to the hub.
    const messages = depositMessages(receipt, connection, assetManager);
    expect(messages).toHaveLength(1);
    const [message] = messages;
    expect(message.dstChainId).toBe(HUB_RELAY_ID);
    const items = decodeRlpList(message.payload);
    expect(items).toHaveLength(5);

    // The sender's deposit, under a quote that carries another intent: never this quote's to submit.
    const deadline = String(Math.floor(Date.now() / 1000) + 15 * 60);
    const { quoteId } = cacheQuote({ srcAddress: items?.[1], deadline });
    const { out } = await track({ txHash: CANARY_SWAPS[0].txHash, quoteId });
    expect(out).toMatchObject({ status: "not_submitted", reason: "deposit_mismatch" });
    expect(swapsPosts()).toEqual([]);
  });

  it("finds a connection and an https RPC in the SDK config for every EVM source chain", async () => {
    const catalog = await getSwapCatalog();
    const configs = (await getAllChainsConfigs()) as Record<string, { addresses?: { connection?: string } }>;
    const rpcs = spokeChainConfig as Record<string, { rpcUrl?: string }>;
    const sources = Object.keys(catalog.chains).filter(key => catalog.chains[key]?.type === "EVM" && !isHubChain(key));
    expect(sources.length).toBeGreaterThan(5);
    for (const key of sources) {
      const packaged = evmSpokeFor(key);
      expect(packaged, key).toBeDefined();
      expect(packaged?.connection.toLowerCase(), key).toBe(configs[key]?.addresses?.connection?.toLowerCase());
      expect(new URL(String(rpcs[key]?.rpcUrl)).protocol, key).toBe("https:");
    }
  });
});
