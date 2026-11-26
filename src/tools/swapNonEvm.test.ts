import { keccak_256 } from "@noble/hashes/sha3";
import { spokeChainConfig } from "@sodax/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "../services/logger.js";
import {
  type IntentJson,
  buildNonEvmCancel,
  cancelPayload,
  createIntentPayload,
  decodeAddress,
  getEvmReceipt,
  hubIntentClosed,
  initSodax,
  intentHash,
  userHubWallet,
} from "../services/sodax.js";
import { clearCache } from "../services/sodaxApi.js";
import builds from "../services/swap/__fixtures__/non-evm-builds.json" with { type: "json" };
import fixtures from "../services/swap/__fixtures__/non-evm-txs.json" with { type: "json" };
import { clearAlerts } from "../services/swap/alerts.js";
import { claimDeposit, clearQuoteCache, getCachedQuote } from "../services/swap/quoteCache.js";
import { INJECTIVE, injectiveEvidence } from "../services/swap/sources/injective.js";
import { NEAR, nearEvidence } from "../services/swap/sources/near.js";
import { SOLANA, solanaEvidence } from "../services/swap/sources/solana.js";
import { STELLAR, stellarEvidence } from "../services/swap/sources/stellar.js";
import { SUI, suiEvidence } from "../services/swap/sources/sui.js";
import type { ConnectionMessage, SpokeEvidence } from "../services/swap/sources/types.js";
import { clearSwapCatalogCache } from "../services/swap/tokens.js";
import { clearUnseenMemo, trackWait } from "../services/swap/track.js";
import { CREATOR, NOW, cacheQuote, callTool, stubBackend } from "./__fixtures__/swapBackend.js";

// Unit tests don't reach a chain: each source tx is a real one's response, or one changed from it, read by its
// family's reader; the SDK's cancel build is scripted per test.
vi.mock("../services/sodax.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../services/sodax.js")>();
  return {
    ...actual,
    getEvmReceipt: vi.fn(),
    buildNonEvmCancel: vi.fn(),
    hubIntentClosed: vi.fn(),
    userHubWallet: vi.fn(),
  };
});

await initSodax();

/** What a non-EVM chain's read finds, scripted per test: a tx's evidence, or `null` while the chain doesn't know it. */
const readSpoke = vi.fn<(chainKey: string, txHash: string, sender?: string) => Promise<SpokeEvidence | null>>();
/** Whether a Solana or NEAR node knows a tx it has no evidence for yet: by default, it doesn't. */
const seenSpoke = vi.fn<(chainKey: string, txHash: string, sender?: string) => Promise<boolean>>();

const connection = (chainKey: string) =>
  (spokeChainConfig as Record<string, { addresses: { connection: string } }>)[chainKey].addresses.connection;
const base64 = (text: string) => new Uint8Array(Buffer.from(text, "base64"));

interface RealSwap {
  chainKey: string;
  txHash: string;
  intent: IntentJson;
  /** What its family's reader made of the real tx. */
  evidence: () => SpokeEvidence;
}

/** A real mainnet swap deposit of each family (`non-evm-txs.json`). */
const REAL: Record<"solana" | "stellar" | "sui" | "near" | "injective", RealSwap> = {
  solana: {
    chainKey: "solana",
    txHash: fixtures.solana.txHash,
    intent: fixtures.solana.intent,
    evidence: () => solanaEvidence(fixtures.solana.tx, connection("solana")) as SpokeEvidence,
  },
  stellar: {
    chainKey: "stellar",
    txHash: fixtures.stellar.txHash,
    intent: fixtures.stellar.intent,
    evidence: () => stellarEvidence(fixtures.stellar.tx, connection("stellar")) as SpokeEvidence,
  },
  sui: {
    chainKey: "sui",
    txHash: fixtures.sui.txHash,
    intent: fixtures.sui.intent,
    evidence: () => {
      const { Transaction } = fixtures.sui.tx;
      const events = Transaction.events.map(event => ({ ...event, bcs: base64(event.bcs) }));
      return suiEvidence({ ...fixtures.sui.tx, Transaction: { ...Transaction, events } }, connection("sui"));
    },
  },
  near: {
    chainKey: "near",
    txHash: fixtures.near.txHash,
    intent: fixtures.near.intent,
    evidence: () => nearEvidence(fixtures.near.tx, connection("near")) as SpokeEvidence,
  },
  injective: {
    chainKey: "injective-1",
    txHash: fixtures.injective.txHash,
    intent: fixtures.injective.intent,
    evidence: () => injectiveEvidence(fixtures.injective.tx, connection("injective-1")),
  },
};

const SENDERS = Object.fromEntries(
  Object.values(REAL).map(swap => [swap.chainKey, decodeAddress(swap.chainKey, swap.intent.srcAddress) as string]),
);

/** Before the swap's deadline, as when its user tracks it. */
const beforeDeadline = (swap: RealSwap) => vi.setSystemTime((Number(swap.intent.deadline) - 600) * 1000);
/**
 * The quote the swap was made from, as quote caches it, at a time before its deadline; `intent` changes it, as for
 * another quote.
 */
const quoteOf = (swap: RealSwap, intent: IntentJson = swap.intent) => {
  beforeDeadline(swap);
  return cacheQuote({
    srcChainKey: swap.chainKey,
    srcAddress: decodeAddress(swap.chainKey, intent.srcAddress) as string,
    deadline: intent.deadline,
    intent,
    relayData: { address: intent.creator, payload: createIntentPayload(intent) as string },
  });
};
const anotherIntent = (intent: IntentJson) => ({ ...intent, intentId: String(BigInt(intent.intentId) + 1n) });

const track = (args: Record<string, unknown>) => callTool("sodax_swap_submit_and_track", args);
const cancel = (args: Record<string, unknown>) => callTool("sodax_swap_cancel", args);
const submits = (calls: { path: string; body?: Record<string, unknown> }[]) =>
  calls.filter(call => call.path === "/submit-tx");
const relays = (calls: { path: string; body?: Record<string, unknown> }[]) =>
  calls.filter(call => call.path === "/intents/submit");

beforeEach(() => {
  for (const adapter of [SOLANA, STELLAR, SUI, NEAR, INJECTIVE]) {
    vi.spyOn(adapter, "read").mockImplementation(async (source, txHash, sender) => {
      const evidence = await readSpoke(source.chain.key, txHash, sender);
      return evidence && { kind: "spoke", ...evidence };
    });
  }
  seenSpoke.mockResolvedValue(false);
  for (const adapter of [SOLANA, NEAR]) {
    vi.spyOn(adapter, "seen").mockImplementation(async (source, txHash, sender) =>
      seenSpoke(source.chain.key, txHash, sender),
    );
  }
  Object.assign(trackWait, { stepMs: 1, maxMs: 0 });
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  clearSwapCatalogCache();
  clearCache();
  clearQuoteCache();
  clearAlerts();
  clearUnseenMemo();
  // The hub still holds every intent here: a cancel is built.
  vi.mocked(hubIntentClosed).mockResolvedValue(false);
  vi.spyOn(logger, "error").mockImplementation(() => undefined);
  vi.spyOn(logger, "info").mockImplementation(() => undefined);
});

afterEach(() => {
  Object.assign(trackWait, { stepMs: 5_000, maxMs: 20_000 });
  vi.useRealTimers();
  vi.restoreAllMocks();
  readSpoke.mockReset();
  seenSpoke.mockReset();
  vi.mocked(buildNonEvmCancel).mockReset();
  vi.mocked(hubIntentClosed).mockReset();
});

describe("a swap from a non-EVM spoke", () => {
  it.each(Object.keys(REAL) as (keyof typeof REAL)[])(
    "is submitted from %s once its connection's message binds the quote, keyed on the hash as its chain spells it",
    async name => {
      const swap = REAL[name];
      readSpoke.mockResolvedValue(swap.evidence());
      const calls = stubBackend();
      const quote = quoteOf(swap);
      const { out } = await track({ txHash: swap.txHash, quoteId: quote.quoteId });
      expect(out).toMatchObject({ status: "queued", txHash: swap.txHash, chain: { key: swap.chainKey } });
      expect(readSpoke).toHaveBeenCalledWith(swap.chainKey, swap.txHash, SENDERS[swap.chainKey]);
      expect(submits(calls)).toEqual([
        expect.objectContaining({
          body: expect.objectContaining({ txHash: swap.txHash, relayData: quote.relayData.payload }),
        }),
      ]);
      expect(getEvmReceipt).not.toHaveBeenCalled();
    },
  );

  it("isn't claimed by a Solana tx that only logs the payload's hash from another program, and takes the real one after", async () => {
    const swap = REAL.solana;
    const payload = createIntentPayload(swap.intent) as string;
    const keccak = Buffer.from(keccak_256(Buffer.from(payload.slice(2), "hex"))).toString("base64");
    const event = fixtures.solana.tx.meta.logMessages.find(log => log.startsWith("Program data: ")) as string;
    const noop = "noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV";
    const forged = [`Program ${noop} invoke [1]`, `Program log: ${keccak}`, event, `Program ${noop} success`];
    readSpoke.mockResolvedValueOnce(solanaEvidence({ meta: { err: null, logMessages: forged } }, connection("solana")));
    const calls = stubBackend();
    const quote = quoteOf(swap);
    const fake = `${"5".repeat(87)}`;
    const { out } = await track({ txHash: fake, quoteId: quote.quoteId });
    expect(out).toMatchObject({ status: "not_submitted", reason: "not_a_deposit" });
    expect(getCachedQuote(quote.quoteId, quote.keyHash)).not.toHaveProperty("depositTxHash");
    readSpoke.mockResolvedValueOnce(swap.evidence());
    expect((await track({ txHash: swap.txHash, quoteId: quote.quoteId })).out.status).toBe("queued");
    expect(submits(calls)).toHaveLength(1);
  });

  it("isn't claimed by an Injective tx with two deposits, though one is the quote's, and takes the real one after", async () => {
    const swap = REAL.injective;
    const { tx_response } = fixtures.injective.tx;
    const message = tx_response.events.find(event => event.type === "wasm-Message") as (typeof tx_response.events)[0];
    // Another quote's deposit first: the backend would take that one.
    const other = createIntentPayload(anotherIntent(swap.intent)) as string;
    const evidence = swap.evidence();
    const payload = (evidence.messages[0] as ConnectionMessage).payload;
    const first = {
      ...message,
      attributes: message.attributes.map(entry =>
        entry.key === "payload"
          ? {
              ...entry,
              value: payload.slice(2).replace(createIntentPayload(swap.intent)?.slice(2) as string, other.slice(2)),
            }
          : entry,
      ),
    };
    const twoDeposits = { tx_response: { code: 0, events: [first, ...tx_response.events] } };
    readSpoke.mockResolvedValueOnce(injectiveEvidence(twoDeposits, connection("injective-1")));
    const calls = stubBackend();
    const quote = quoteOf(swap);
    const bundle = "B".repeat(64);
    const { out } = await track({ txHash: bundle, quoteId: quote.quoteId });
    expect(out).toMatchObject({ status: "not_submitted", reason: "multiple_deposits", alerted: true });
    expect(getCachedQuote(quote.quoteId, quote.keyHash)).not.toHaveProperty("depositTxHash");
    readSpoke.mockResolvedValueOnce(evidence);
    expect((await track({ txHash: swap.txHash, quoteId: quote.quoteId })).out.status).toBe("queued");
    expect(submits(calls)).toHaveLength(1);
  });

  it("isn't submitted when its deposit carries another intent: the sender's other quote, which alerts", async () => {
    const swap = REAL.sui;
    readSpoke.mockResolvedValue(swap.evidence());
    const calls = stubBackend();
    const { out } = await track({ txHash: swap.txHash, quoteId: quoteOf(swap, anotherIntent(swap.intent)).quoteId });
    expect(out).toMatchObject({ status: "not_submitted", reason: "deposit_mismatch", alerted: true });
    expect(out.nextStep).toContain("track it with the quoteId it was made from");
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ alert: "other_quote_deposit" }),
      expect.any(String),
    );
    expect(submits(calls)).toEqual([]);
  });

  it.each(["near", "injective", "stellar"] as const)(
    "isn't submitted when a %s wallet sent the quote's deposit from another account",
    async name => {
      const swap = REAL[name];
      readSpoke.mockResolvedValue(swap.evidence());
      const calls = stubBackend();
      // The quote's intent, sent from someone else's account: the message names the real sender.
      const quote = cacheQuote({
        ...quoteOf(swap),
        srcAddress: "someone",
        intent: { ...swap.intent, srcAddress: `0x${"9".repeat(40)}` },
      });
      const { out } = await track({ txHash: swap.txHash, quoteId: quote.quoteId });
      expect(out).toMatchObject({ status: "not_submitted", reason: "other_sender", alerted: true });
      expect(submits(calls)).toEqual([]);
    },
  );

  it.each([
    ["solana", { meta: { err: { InstructionError: [0, "Custom"] }, logMessages: [] } }],
    ["stellar", { status: "FAILED" }],
    ["sui", { $kind: "FailedTransaction", FailedTransaction: { status: { success: false }, events: [] } }],
    ["injective", { tx_response: { code: 5, events: [] } }],
  ] as const)("is reported failed when its %s tx failed: nothing moved", async (name, raw) => {
    const swap = REAL[name];
    const read = { solana: solanaEvidence, stellar: stellarEvidence, sui: suiEvidence, injective: injectiveEvidence }[
      name
    ] as (raw: unknown, connection: string) => SpokeEvidence;
    readSpoke.mockResolvedValue(read(raw, connection(swap.chainKey)));
    const calls = stubBackend();
    const { out } = await track({ txHash: swap.txHash, quoteId: quoteOf(swap).quoteId });
    expect(out).toEqual(expect.objectContaining({ status: "source_failed" }));
    expect(out).not.toHaveProperty("depositHeld");
    expect(out.nextStep).toContain("nothing was swapped");
    expect(submits(calls)).toEqual([]);
  });

  it("is reported held, and alerts, when its NEAR tx failed after the deposit ran", async () => {
    const swap = REAL.near;
    const { receipts_outcome } = fixtures.near.tx;
    const failure = { Failure: { ActionError: { index: 0, kind: { FunctionCallError: {} } } } };
    const last = receipts_outcome.length - 1;
    const failedLater = receipts_outcome.map((receipt, i) =>
      i === last ? { ...receipt, outcome: { ...receipt.outcome, status: failure } } : receipt,
    );
    const raw = { ...fixtures.near.tx, receipts_outcome: failedLater };
    readSpoke.mockResolvedValue(nearEvidence(raw, connection("near")));
    const calls = stubBackend();
    const { out } = await track({ txHash: swap.txHash, quoteId: quoteOf(swap).quoteId });
    expect(out).toMatchObject({ status: "source_failed", depositHeld: true, alerted: true });
    expect(out.nextStep).toContain("SODAX has been alerted");
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ alert: "failed_tx_deposit" }),
      expect.any(String),
    );
    expect(submits(calls)).toEqual([]);
  });

  it("is waited for while its chain doesn't know it, until the quote's stop time", async () => {
    const swap = REAL.sui;
    readSpoke.mockResolvedValue(null);
    stubBackend();
    const { out } = await track({ txHash: swap.txHash, quoteId: quoteOf(swap).quoteId });
    expect(out).toMatchObject({ status: "awaiting_source_confirmation", seenOnChain: false });
    expect(out.stopAfter).toBe(new Date(Number(swap.intent.deadline) * 1000 + 5 * 60_000).toISOString());
    // Its node can't say whether it knows a tx still in flight.
    expect(out.nextStep).toContain("Sui hasn't confirmed this transaction yet");
  });

  it("refuses a hash that can't be its chain's, before reading anything", async () => {
    const calls = stubBackend();
    const { out } = await track({ txHash: `0x${"a".repeat(64)}`, quoteId: quoteOf(REAL.sui).quoteId });
    expect(out.error).toMatchObject({ code: "INVALID_TX_HASH", format: "a base58 digest" });
    // A batch id is EVM's.
    expect(out.nextStep).not.toContain("batch");
    expect(readSpoke).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it("is relayed past its deadline for refund; from Solana with the relay data its message has the hash of", async () => {
    const swap = REAL.solana;
    readSpoke.mockResolvedValue(swap.evidence());
    const calls = stubBackend();
    const quote = quoteOf(swap);
    vi.setSystemTime(Number(swap.intent.deadline) * 1000 + 1000);
    const { out } = await track({ txHash: swap.txHash, quoteId: quote.quoteId });
    expect(out.status).toBe("expired_refunding");
    expect(relays(calls)).toEqual([
      { path: "/intents/submit", body: { chainId: "1", txHash: swap.txHash, data: quote.relayData } },
    ]);
  });

  it("is relayed for refund from Sui with no relay data: the relay reads the deposit itself", async () => {
    const swap = REAL.sui;
    readSpoke.mockResolvedValue(swap.evidence());
    const calls = stubBackend();
    const { quoteId } = quoteOf(swap);
    vi.setSystemTime(Number(swap.intent.deadline) * 1000 + 1000);
    await track({ txHash: swap.txHash, quoteId });
    expect(relays(calls)).toEqual([{ path: "/intents/submit", body: { chainId: "21", txHash: swap.txHash } }]);
  });

  it("is reported, not submitted, without its quote: a deposit if the asset manager sent a message", async () => {
    const swap = REAL.sui;
    readSpoke.mockResolvedValue(swap.evidence());
    const calls = stubBackend();
    const { out } = await track({ txHash: swap.txHash, chain: "sui" });
    expect(out).toMatchObject({ status: "not_submitted_unknown_quote", isDeposit: true, alerted: false });
    readSpoke.mockResolvedValue({ failed: false, messages: [] });
    clearUnseenMemo();
    expect((await track({ txHash: swap.txHash, chain: "sui" })).out).toMatchObject({ isDeposit: false });
    expect(submits(calls)).toEqual([]);
  });

  it("doesn't say an unknown tx was never sent: public nodes drop old ones", async () => {
    readSpoke.mockResolvedValue(null);
    stubBackend();
    const { out } = await track({ txHash: REAL.sui.txHash, chain: "sui" });
    expect(out.status).toBe("source_not_found");
    expect(out.nextStep).toContain("older than the node keeps");
    expect(out.nextStep).not.toContain("hasn't seen");
  });
});

describe("a swap from a non-EVM spoke, cancelled", () => {
  const HUB_TX = `0x${"b".repeat(64)}`;
  const row = { status: "failed", result: { dstIntentTxHash: HUB_TX } };
  const CANCEL_TX = "FushAhTwsQY8eqnFPVbjPXjZhM8kpAyHbK8JiG47FwCp";
  const SOLANA_CANCEL_TX = `${"4".repeat(87)}`;
  const claimed = (swap: RealSwap) => {
    const quote = quoteOf(swap);
    claimDeposit(quote.quoteId, swap.txHash);
    return quote.quoteId;
  };
  /** The user's cancel as their connection emits it: from their address to their hub wallet. */
  const cancelMessage = (swap: RealSwap, payload: string): ConnectionMessage => ({
    srcChainId: BigInt(swap.intent.srcChain),
    srcAddress: swap.intent.srcAddress,
    dstChainId: 146n,
    dstAddress: swap.intent.creator,
    payload,
  });

  it("isn't built once the hub no longer holds the intent, read past the hub tx that created it", async () => {
    const swap = REAL.sui;
    vi.mocked(hubIntentClosed).mockResolvedValue(true);
    stubBackend({ row, hubIntent: swap.intent });
    const { out } = await cancel({ txHash: swap.txHash, quoteId: claimed(swap) });
    expect(out).toMatchObject({ status: "not_cancellable", reason: "closed" });
    expect(hubIntentClosed).toHaveBeenCalledWith(intentHash(swap.intent), HUB_TX);
    expect(buildNonEvmCancel).not.toHaveBeenCalled();
  });

  it("is built by the SDK from the hub's intent, as the family's wallet takes it", async () => {
    const swap = REAL.sui;
    // The SDK's live build of a Sui cancel: its sender left unset.
    const built = builds.sui.cancel;
    vi.mocked(buildNonEvmCancel).mockResolvedValue({ ...built, value: 0n });
    stubBackend({ row, hubIntent: swap.intent });
    const { out } = await cancel({ txHash: swap.txHash, quoteId: claimed(swap) });
    expect(out.status).toBe("ready");
    expect(out.steps).toEqual([
      {
        kind: "cancel",
        chainKey: "sui",
        chainType: "SUI",
        tx: { ...built, value: "0", data: JSON.stringify({ ...JSON.parse(built.data), sender: built.from }) },
      },
    ]);
    expect(buildNonEvmCancel).toHaveBeenCalledWith("sui", swap.intent);
    expect(out.nextStep).toContain("Transaction.from");
  });

  it("is built without its quote for the intent the tracked deposit carries, by its sender's hub wallet", async () => {
    const swap = REAL.sui;
    readSpoke.mockResolvedValue(swap.evidence());
    vi.mocked(userHubWallet).mockResolvedValue(swap.intent.creator);
    vi.mocked(buildNonEvmCancel).mockResolvedValue(builds.sui.cancel);
    stubBackend({ row, hubIntent: swap.intent });
    const { out } = await cancel({ txHash: swap.txHash, chain: "sui" });
    expect(out.status).toBe("ready");
    expect(userHubWallet).toHaveBeenCalledWith("sui", SENDERS.sui);
  });

  it("says, without its quote, when the node has dropped the deposit: calling again won't help", async () => {
    readSpoke.mockResolvedValue(null);
    stubBackend({ row, hubIntent: REAL.sui.intent });
    const { out } = await cancel({ txHash: REAL.sui.txHash, chain: "sui" });
    expect(out.error.code).toBe("QUOTE_NOT_FOUND");
    expect(out.nextStep).toContain("its transaction hash");
    expect(out.nextStep).toContain("https://www.sodax.com/discord");
    expect(buildNonEvmCancel).not.toHaveBeenCalled();
  });

  it.each([
    ["the deposit carries another intent", true, undefined],
    ["its creator isn't the sender's hub wallet", false, `0x${"9".repeat(40)}`],
  ])("isn't built without its quote when %s", async (_case, other, hubWallet) => {
    const swap = REAL.sui;
    readSpoke.mockResolvedValue(swap.evidence());
    vi.mocked(userHubWallet).mockResolvedValue(hubWallet ?? swap.intent.creator);
    stubBackend({ row, hubIntent: other ? anotherIntent(swap.intent) : swap.intent });
    const { out } = await cancel({ txHash: swap.txHash, chain: "sui" });
    expect(out.error.code).toBe("SWAP_MISMATCH");
    expect(buildNonEvmCancel).not.toHaveBeenCalled();
  });

  it("refuses a Solana cancel the SDK built to another program than the packaged connection", async () => {
    vi.mocked(buildNonEvmCancel).mockResolvedValue({ from: SENDERS.solana, to: "Fake1111111111111111111111111111" });
    stubBackend({ row, hubIntent: REAL.solana.intent });
    const { out } = await cancel({ txHash: REAL.solana.txHash, quoteId: claimed(REAL.solana) });
    expect(out.error.code).toBe("SWAP_MISMATCH");
  });

  it("says what to check when the SDK can't build the cancel", async () => {
    vi.mocked(buildNonEvmCancel).mockRejectedValue(new Error("SDK call failed"));
    stubBackend({ row, hubIntent: REAL.sui.intent });
    const { out } = await cancel({ txHash: REAL.sui.txHash, quoteId: claimed(REAL.sui) });
    expect(out.error).toMatchObject({
      code: "CHAIN_UNAVAILABLE",
      message: "Couldn't prepare the cancel on Sui right now.",
    });
  });

  it.each(["sui", "near", "stellar", "injective"] as const)(
    "is relayed from %s once the user's connection message carries the intent's cancel",
    async name => {
      const swap = REAL[name];
      const payload = cancelPayload(swap.intent) as string;
      readSpoke.mockResolvedValue({ failed: false, messages: [cancelMessage(swap, payload)] });
      const calls = stubBackend({ row, hubIntent: swap.intent });
      const cancelTx = name === "sui" || name === "near" ? CANCEL_TX : "C".repeat(64);
      const { out } = await cancel({ txHash: swap.txHash, quoteId: claimed(swap), cancelTxHash: cancelTx });
      expect(out.status).toBe("cancel_relayed");
      expect(relays(calls)).toEqual([
        { path: "/intents/submit", body: { chainId: swap.intent.srcChain, txHash: expect.any(String) } },
      ]);
    },
  );

  it("is relayed from Solana once its message carries the cancel's keccak, with the cancel as relay data", async () => {
    const swap = REAL.solana;
    const payload = cancelPayload(swap.intent) as string;
    const keccak = `0x${Buffer.from(keccak_256(Buffer.from(payload.slice(2), "hex"))).toString("hex")}`;
    // The SDK's Solana cancel sends the payload's hash; the full payload is no cancel there.
    readSpoke.mockResolvedValue({ failed: false, messages: [cancelMessage(swap, payload)] });
    const calls = stubBackend({ row, hubIntent: swap.intent });
    const quoteId = claimed(swap);
    const first = await cancel({ txHash: swap.txHash, quoteId, cancelTxHash: SOLANA_CANCEL_TX });
    expect(first.out.status).toBe("not_a_cancel_tx");
    readSpoke.mockResolvedValue({ failed: false, messages: [cancelMessage(swap, keccak)] });
    const { out } = await cancel({ txHash: swap.txHash, quoteId, cancelTxHash: SOLANA_CANCEL_TX });
    expect(out.status).toBe("cancel_relayed");
    expect(relays(calls)).toEqual([
      {
        path: "/intents/submit",
        body: { chainId: "1", txHash: SOLANA_CANCEL_TX, data: { address: swap.intent.creator, payload } },
      },
    ]);
  });

  it("isn't relayed from a tx that holds the cancel's payload but no message of the user's to their hub wallet", async () => {
    const swap = REAL.sui;
    const payload = cancelPayload(swap.intent) as string;
    const quoteId = claimed(swap);
    const calls = stubBackend({ row, hubIntent: swap.intent });
    for (const messages of [
      [],
      // The asset manager's, another hub wallet's, another source chain's.
      [
        {
          ...cancelMessage(swap, payload),
          srcAddress: `0x${Buffer.from(spokeChainConfig.sui.addresses.assetManager).toString("hex")}`,
        },
      ],
      [{ ...cancelMessage(swap, payload), dstAddress: CREATOR }],
      [{ ...cancelMessage(swap, payload), srcChainId: 1n }],
    ]) {
      readSpoke.mockResolvedValue({ failed: false, messages });
      const { out } = await cancel({ txHash: swap.txHash, quoteId, cancelTxHash: CANCEL_TX });
      expect(out.status).toBe("not_a_cancel_tx");
    }
    expect(relays(calls)).toEqual([]);
  });

  it("is reported failed when the cancel tx failed, and isn't relayed", async () => {
    const swap = REAL.near;
    const payload = cancelPayload(swap.intent) as string;
    readSpoke.mockResolvedValue({ failed: true, messages: [cancelMessage(swap, payload)] });
    const calls = stubBackend({ row, hubIntent: swap.intent });
    const { out } = await cancel({ txHash: swap.txHash, quoteId: claimed(swap), cancelTxHash: CANCEL_TX });
    expect(out.status).toBe("cancel_failed");
    expect(relays(calls)).toEqual([]);
  });

  it("is reported failed when the cancel tx failed though its events can't be read, and isn't relayed", async () => {
    const swap = REAL.near;
    readSpoke.mockResolvedValue({ failed: false, messages: [], unreadable: { failed: true } });
    const calls = stubBackend({ row, hubIntent: swap.intent });
    const { out } = await cancel({ txHash: swap.txHash, quoteId: claimed(swap), cancelTxHash: CANCEL_TX });
    expect(out.status).toBe("cancel_failed");
    expect(relays(calls)).toEqual([]);
  });

  it("is relayed when the cancel tx's events can't be read, but says nothing here checked it", async () => {
    const swap = REAL.sui;
    readSpoke.mockResolvedValue({ failed: false, messages: [], unreadable: { failed: false } });
    const calls = stubBackend({ row, hubIntent: swap.intent });
    const { out } = await cancel({ txHash: swap.txHash, quoteId: claimed(swap), cancelTxHash: CANCEL_TX });
    expect(out).toMatchObject({ status: "cancel_relayed", unverified: true });
    expect(out.nextStep).toContain("couldn't confirm it's this swap's cancel");
    expect(relays(calls)).toHaveLength(1);
  });

  it("isn't built without its quote when the deposit's events can't be read: no mismatch, nothing to retry", async () => {
    const swap = REAL.sui;
    readSpoke.mockResolvedValue({ failed: false, messages: [], unreadable: { failed: false } });
    stubBackend({ row, hubIntent: swap.intent });
    const { out } = await cancel({ txHash: swap.txHash, chain: "sui" });
    expect(out).toMatchObject({ status: "not_cancellable", reason: "unverified" });
    expect(out.nextStep).toContain("its transaction hash");
    expect(out.nextStep).toContain("https://www.sodax.com/discord");
    expect(logger.error).not.toHaveBeenCalled();
    expect(buildNonEvmCancel).not.toHaveBeenCalled();
  });
});

describe("a non-EVM swap whose evidence is incomplete", () => {
  const unreadable: SpokeEvidence = { failed: false, messages: [], unreadable: { failed: false } };

  it("isn't claimed or called anything else when its events can't be read, and alerts with its quote", async () => {
    const swap = REAL.solana;
    readSpoke.mockResolvedValue(unreadable);
    const calls = stubBackend();
    const quote = quoteOf(swap);
    const { out } = await track({ txHash: swap.txHash, quoteId: quote.quoteId });
    expect(out).toMatchObject({ status: "not_submitted", reason: "unverified", alerted: true });
    expect(out.nextStep).toContain("can't tell whether it holds this swap");
    expect(getCachedQuote(quote.quoteId, quote.keyHash)).not.toHaveProperty("depositTxHash");
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ alert: "unverified_tx" }), expect.any(String));
    expect(submits(calls)).toEqual([]);
  });

  it("stays unverified, not failed, when a NEAR tx failed with events it can't read: a deposit may be held", async () => {
    const swap = REAL.near;
    readSpoke.mockResolvedValue({ failed: false, messages: [], unreadable: { failed: true } });
    stubBackend();
    const quote = quoteOf(swap);
    const { out } = await track({ txHash: swap.txHash, quoteId: quote.quoteId });
    expect(out).toMatchObject({ status: "not_submitted", reason: "unverified", alerted: true });
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ alert: "unverified_tx", reason: "the tx failed" }),
      expect.any(String),
    );
  });

  it("says a Solana tx its node has but hasn't finalized is on chain, with no time to stop waiting for it", async () => {
    readSpoke.mockResolvedValue(null);
    seenSpoke.mockResolvedValue(true);
    stubBackend();
    const { out } = await track({ txHash: REAL.solana.txHash, quoteId: quoteOf(REAL.solana).quoteId });
    expect(out).toMatchObject({ status: "awaiting_source_confirmation", seenOnChain: true });
    expect(out).not.toHaveProperty("stopAfter");
    // Asked with the quote's sender, which routes a NEAR lookup.
    expect(seenSpoke).toHaveBeenCalledWith("solana", REAL.solana.txHash, SENDERS.solana);
  });

  it("reads a quoted tx a node can't say it has at most every 10 s, and has a just-sent one retried", async () => {
    const swap = REAL.sui;
    readSpoke.mockResolvedValue(null);
    stubBackend();
    const quote = quoteOf(swap);
    for (let call = 0; call < 2; call++) {
      const { out } = await track({ txHash: swap.txHash, quoteId: quote.quoteId });
      expect(out).toMatchObject({ status: "awaiting_source_confirmation", seenOnChain: false });
    }
    expect(readSpoke).toHaveBeenCalledTimes(1);
    expect(seenSpoke).not.toHaveBeenCalled();
    const { out } = await track({ txHash: swap.txHash, chain: "sui" });
    expect(out.status).toBe("source_not_found");
    expect(out.nextStep).toContain("sent less than a minute ago");
  });

  it("says the same without a quote, alerting no one", async () => {
    readSpoke.mockResolvedValue(unreadable);
    stubBackend();
    const { out } = await track({ txHash: REAL.sui.txHash, chain: "sui" });
    expect(out).toMatchObject({ status: "not_submitted", reason: "unverified", alerted: false });
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("alerts on a failed NEAR tx's held deposit, saying when it isn't the named quote's", async () => {
    const swap = REAL.near;
    // A NEAR tx that failed after its deposit ran: the deposit's messages stay.
    readSpoke.mockResolvedValue({ failed: true, messages: swap.evidence().messages });
    stubBackend();
    const alertOf = () => vi.mocked(logger.error).mock.calls.at(-1)?.[0];
    const other = await track({ txHash: swap.txHash, quoteId: quoteOf(swap, anotherIntent(swap.intent)).quoteId });
    expect(other.out).toMatchObject({ status: "source_failed", depositHeld: true, alerted: true, notThisQuote: true });
    // The agent asks for this swap's own hash rather than call it safe.
    expect(other.out.nextStep).toContain("Ask the user for this swap's transaction hash");
    expect(alertOf()).toMatchObject({ alert: "failed_tx_deposit", reason: "not this quote's" });
    clearAlerts();
    const own = await track({ txHash: swap.txHash, quoteId: quoteOf(swap).quoteId });
    expect(own.out).toMatchObject({ status: "source_failed", depositHeld: true, alerted: true });
    expect(own.out).not.toHaveProperty("notThisQuote");
    expect(alertOf()).toMatchObject({ alert: "failed_tx_deposit" });
    expect(alertOf()).not.toHaveProperty("reason");
  });

  it("doesn't alert on a held deposit named by a quoteId this server doesn't hold", async () => {
    // A tx that failed after its deposit ran, as only NEAR's can.
    readSpoke.mockResolvedValue({ failed: true, messages: REAL.sui.evidence().messages });
    stubBackend();
    const quoteId = "8f5e3c1a-2b4d-4e6f-8a9b-0c1d2e3f4a5b";
    const { out } = await track({ txHash: REAL.sui.txHash, chain: "sui", quoteId });
    expect(out).toMatchObject({ status: "source_failed", depositHeld: true, alerted: false });
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("submits a checked deposit its node has since dropped, without reading it again", async () => {
    const swap = REAL.sui;
    const calls = stubBackend({
      submit: () => new Response("", { status: 503 }),
      status: () => Response.json({ message: "Swap transaction not found" }, { status: 404 }),
    });
    const quote = quoteOf(swap);
    readSpoke.mockResolvedValue(swap.evidence());
    await track({ txHash: swap.txHash, quoteId: quote.quoteId });
    expect(getCachedQuote(quote.quoteId, quote.keyHash)).toMatchObject({ depositTxHash: swap.txHash });
    readSpoke.mockReset().mockResolvedValue(null);
    vi.setSystemTime(Number(swap.intent.deadline) * 1000 + 1000);
    const { out } = await track({ txHash: swap.txHash, quoteId: quote.quoteId });
    expect(out.status).toBe("expired_refunding");
    expect(readSpoke).not.toHaveBeenCalled();
    expect(relays(calls)).toHaveLength(1);
    expect(submits(calls)).toHaveLength(1);
  });

  it("is cancelled toward its refund once checked, though its node has dropped it", async () => {
    const swap = REAL.injective;
    const quote = quoteOf(swap);
    claimDeposit(quote.quoteId, swap.txHash);
    readSpoke.mockResolvedValue(null);
    stubBackend({ row: null });
    const { out } = await cancel({ txHash: swap.txHash, quoteId: quote.quoteId });
    expect(out.status).toBe("deposit_unsubmitted");
    expect(readSpoke).not.toHaveBeenCalled();
  });

  it("isn't called never sent when a node that drops old txs doesn't have it after the quote's deadline", async () => {
    const quote = quoteOf(REAL.sui);
    vi.setSystemTime(Number(REAL.sui.intent.deadline) * 1000 + 1000);
    readSpoke.mockResolvedValue(null);
    stubBackend({ row: null });
    const { out } = await cancel({ txHash: REAL.sui.txHash, quoteId: quote.quoteId });
    expect(out).toMatchObject({ status: "not_cancellable", reason: "not_submitted" });
  });

  // Track would submit it once it lands, so cancel mustn't send the agent there.
  it("waits for a tx its node doesn't have yet before the quote's deadline, rather than send it to track", async () => {
    const swap = REAL.sui;
    const quote = quoteOf(swap);
    readSpoke.mockResolvedValue(null);
    stubBackend({ row: null });
    const { out } = await cancel({ txHash: swap.txHash, quoteId: quote.quoteId });
    expect(out).toMatchObject({ status: "not_cancellable", reason: "not_sent" });
    expect(out.nextStep).not.toContain("sodax_swap_submit_and_track");
  });
});
