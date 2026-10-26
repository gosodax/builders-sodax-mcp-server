/**
 * Canary swap E2E: one real swap through the swap tools, the way an agent makes it, signed by a funded
 * test wallet. `.github/workflows/e2e-canary.yml` runs it daily against a server started in the runner;
 * the README says how to run it locally. Canary runs on mainnet chains: this moves real funds.
 *
 * 5 USDC goes from whichever of Arbitrum and Base holds more to the other, so runs alternate and the
 * wallet rebalances itself. It prints only text it builds: never an error object, its message or an env
 * value (Actions logs are public, and GitHub masks secrets but not text derived from them).
 *
 * Env: MCP_URL, SODAX_API_KEY, E2E_WALLET_PRIVATE_KEY; optional AMOUNT (default 5), SODAX_RPC_URL_42161,
 * SODAX_RPC_URL_8453, E2E_DRY_RUN=1 (quote only: nothing is signed, no balance needed).
 *
 * From `src/` it imports types, and the retryable error codes (errors.ts loads nothing else): this process
 * holds the key and never loads the SDK.
 */

import { appendFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { spokeChainConfig } from "@sodax/types";
import {
  http,
  BaseError,
  type Hex,
  RpcError,
  RpcRequestError,
  createWalletClient,
  erc20Abi,
  formatEther,
  formatUnits,
  keccak256,
  parseEther,
  parseUnits,
  publicActions,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrum, base } from "viem/chains";
import { type ActionErrorCode, RETRYABLE_CODES } from "../../src/services/swap/errors.js";
import type { SwapQuote } from "../../src/services/swap/quote.js";
import type { TrackResult } from "../../src/services/swap/track.js";
import type { AfterSend } from "../../src/tools/swap.js";

type Stage = "setup" | "read_wallet" | "balance_floor" | "quote" | "send" | "track" | "arrival";
type ReadyQuote = Extract<SwapQuote, { status: "ready" }> & { afterSend: AfterSend };
type ToolError = { error?: { code: ActionErrorCode; retryAfterSec?: number } };

/** A failure whose reason this script wrote itself; the stage is the one it happened in. */
class Failure extends Error {}

const SIDES = [
  { key: "0xa4b1.arbitrum", chain: arbitrum },
  { key: "0x2105.base", chain: base },
] as const;
// About ten runs' worth of approve + swap gas on these L2s: the job goes red while there's room to top up.
const GAS_FLOOR = parseEther("0.0002");
// `solved` is the fill on the hub; delivery to the destination is one more relay hop (the SDK waits 120 s).
const ARRIVAL_TIMEOUT_MS = 180_000;
const DEFAULT_RETRY_SEC = 15;
// The server's retryable codes, but INTERNAL: a bug should fail the canary, not be waited out.
const RETRYABLE: readonly ActionErrorCode[] = RETRYABLE_CODES.filter(code => code !== "INTERNAL");
const PENDING: readonly TrackResult["status"][] = ["awaiting_source_confirmation", "queued", "in_progress"];

let stage: Stage = "setup";

/** Moves to the next stage, and records it for the workflow's alert even if the job is killed later. */
function enter(next: Stage): void {
  stage = next;
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `stage=${next}\n`);
}

const log = (text: string) => console.log(`[${stage}] ${text}`);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function readEnv() {
  const { MCP_URL, SODAX_API_KEY, E2E_WALLET_PRIVATE_KEY, AMOUNT, E2E_DRY_RUN } = process.env;
  const amount = AMOUNT || "5";
  const dryRun = E2E_DRY_RUN === "1";
  if (!MCP_URL || !SODAX_API_KEY) throw new Failure("MCP_URL and SODAX_API_KEY are required");
  if (!/^\d+(?:\.\d+)?$/.test(amount)) throw new Failure("AMOUNT must be a plain decimal");
  if (!dryRun && !/^0x[0-9a-fA-F]{64}$/.test(E2E_WALLET_PRIVATE_KEY ?? "")) {
    throw new Failure("E2E_WALLET_PRIVATE_KEY must be 0x + 64 hex");
  }
  // A dry run quotes for a throwaway key: nothing is signed.
  const key = (dryRun ? `0x${"1".repeat(64)}` : E2E_WALLET_PRIVATE_KEY) as Hex;
  return { mcpUrl: new URL(MCP_URL), apiKey: SODAX_API_KEY, account: privateKeyToAccount(key), amount, dryRun };
}
type Env = ReturnType<typeof readEnv>;

/** A signer that also reads, per side, on the side's RPC override or viem's default. USDC from the SDK config. */
function wallets(account: Env["account"]) {
  return SIDES.map(({ key, chain }) => ({
    key,
    usdc: spokeChainConfig[key].supportedTokens.USDC,
    client: createWalletClient({
      account,
      chain,
      transport: http(process.env[`SODAX_RPC_URL_${chain.id}`] || undefined),
    }).extend(publicActions),
  }));
}
type Wallet = ReturnType<typeof wallets>[number];

const usdcOf = (wallet: Wallet) =>
  wallet.client.readContract({
    address: wallet.usdc.address,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [wallet.client.account.address],
  });

/** One tool call on a fresh connection: the server is stateless per request, and no stream stays open. */
async function callTool<Out>({ mcpUrl, apiKey }: Env, name: string, args: Record<string, unknown>) {
  const client = new Client({ name: "sodax-canary-e2e", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(mcpUrl, { requestInit: { headers: { "x-api-key": apiKey } } }),
  );
  try {
    const result = await client.callTool({ name, arguments: args });
    return { isError: result.isError === true, out: (result.structuredContent ?? {}) as Out & ToolError };
  } finally {
    await client.close();
  }
}

/** The richer side sends; reads both sides' USDC and ETH at once. */
async function readWallet(sides: Wallet[]) {
  const balances = await Promise.all(
    sides.map(async wallet => {
      const [usdc, eth] = await Promise.all([usdcOf(wallet), wallet.client.getBalance(wallet.client.account)]);
      log(`${wallet.key}: ${formatUnits(usdc, wallet.usdc.decimals)} USDC, ${formatEther(eth)} ETH`);
      return { usdc, eth };
    }),
  );
  const from = balances[0].usdc >= balances[1].usdc ? 0 : 1;
  return { src: sides[from], dst: sides[1 - from], srcBalance: balances[from] };
}

async function quoteSwap(env: Env, src: Wallet, dst: Wallet): Promise<ReadyQuote> {
  const { isError, out } = await callTool<SwapQuote & { afterSend?: AfterSend }>(env, "sodax_swap_quote", {
    fromChain: src.key,
    fromToken: src.usdc.address,
    toChain: dst.key,
    toToken: dst.usdc.address,
    amount: env.amount,
    fromAddress: env.account.address,
  });
  if (isError || out.status !== "ready") throw new Failure(`not ready: ${out.error?.code ?? out.status}`);
  if (!out.afterSend) throw new Failure("a ready quote without afterSend");
  log(`quoteId ${out.quoteId}, at least ${out.to.minimumAmount} USDC, ${out.steps.length} steps`);
  return out as ReadyQuote;
}

/**
 * Sends the quote's steps in order, each mined before the next. The swap is signed and its hash logged
 * before it's sent, so a send that errors after the node took it is still tracked.
 */
async function sendSteps({ client }: Wallet, quote: ReadyQuote): Promise<Hex> {
  // Counted here, not asked per step: a load-balanced public RPC can answer from a node that hasn't
  // seen the approve yet.
  let nonce = await client.getTransactionCount({ address: client.account.address, blockTag: "pending" });
  for (const step of quote.steps) {
    if (step.chainId !== client.chain.id) throw new Failure(`a step on chain ${step.chainId}`);
    const request = await client.prepareTransactionRequest({
      to: step.tx.to as Hex,
      data: step.tx.data as Hex,
      value: BigInt(step.tx.value),
      nonce: nonce++,
    });
    // The prepared request is a full transaction for this chain's account; viem's union type can't say so.
    const serialized = await client.signTransaction(request as never);
    const hash = keccak256(serialized);
    log(`${step.kind}: ${hash}`);
    const sent = client.sendRawTransaction({ serializedTransaction: serialized });
    if (step.kind === "swap") {
      try {
        await sent;
      } catch (error) {
        // The node answered no (nonce, funds, price): nothing was sent. Anything else may have landed.
        if (error instanceof RpcError || error instanceof RpcRequestError) {
          throw new Failure(`the node refused the swap (RPC code ${error.code})`);
        }
        log(`send reported ${describe(error)}; tracking anyway`);
      }
      return hash;
    }
    await sent;
    const receipt = await client.waitForTransactionReceipt({ hash, timeout: 120_000 });
    if (receipt.status !== "success") throw new Failure(`${step.kind} reverted`);
  }
  throw new Failure("the quote had no swap step");
}

/** Calls track through the quote's afterSend until it says solved, up to 5 minutes past the quote's expiry. */
async function track(env: Env, quote: ReadyQuote, txHash: Hex): Promise<void> {
  const deadline = Date.parse(quote.expiresAt) + 5 * 60_000;
  while (Date.now() < deadline) {
    const { isError, out } = await callTool<TrackResult>(env, quote.afterSend.tool, {
      ...quote.afterSend.args,
      txHash,
    });
    if (isError) {
      if (!out.error || !RETRYABLE.includes(out.error.code))
        throw new Failure(`error ${out.error?.code ?? "without a code"}`);
      log(`${out.error.code}, retrying`);
    } else {
      log(`status ${out.status}${out.status === "in_progress" ? ` (${out.stage})` : ""}`);
      if (out.status === "solved") return;
      if (out.status === "failed") throw new Failure(`ended failed: ${out.outcome}, canCancel ${out.canCancel}`);
      if (!PENDING.includes(out.status)) throw new Failure(`ended ${out.status}`);
    }
    const retryAfterSec =
      "retryAfterSec" in out ? Number(out.retryAfterSec) : (out.error?.retryAfterSec ?? DEFAULT_RETRY_SEC);
    await sleep(retryAfterSec * 1000);
  }
  throw new Failure("not solved by 5 minutes past the quote's expiry");
}

async function checkArrival(dst: Wallet, before: bigint, minimum: string): Promise<void> {
  const wanted = before + parseUnits(minimum, dst.usdc.decimals);
  const deadline = Date.now() + ARRIVAL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const now = await usdcOf(dst);
    if (now >= wanted) return log(`arrived: ${formatUnits(now - before, dst.usdc.decimals)} USDC on ${dst.key}`);
    await sleep(5_000);
  }
  throw new Failure(`less than ${minimum} USDC arrived on ${dst.key}`);
}

async function run(): Promise<void> {
  enter("setup");
  const env = readEnv();

  enter("read_wallet");
  const { src, dst, srcBalance } = await readWallet(wallets(env.account));
  log(`route: ${env.amount} USDC ${src.key} -> ${dst.key}`);

  if (!env.dryRun) {
    enter("balance_floor");
    if (srcBalance.usdc < parseUnits(env.amount, src.usdc.decimals)) throw new Failure(`top up USDC on ${src.key}`);
    if (srcBalance.eth < GAS_FLOOR) throw new Failure(`top up ETH on ${src.key}`);
  }

  enter("quote");
  const quote = await quoteSwap(env, src, dst);
  if (env.dryRun) return log("dry run: nothing signed");

  enter("send");
  const before = await usdcOf(dst);
  const swapHash = await sendSteps(src, quote);

  enter("track");
  await track(env, quote, swapHash);

  enter("arrival");
  await checkArrival(dst, before, quote.to.minimumAmount);
}

/** viem errors by name and short message (no URL or request body); anything else by name only. */
function describe(error: unknown): string {
  if (error instanceof BaseError) return `${error.name}: ${error.shortMessage}`;
  return error instanceof Error ? error.name : typeof error;
}

function fail(error: unknown): void {
  console.error(`E2E failed at ${stage}: ${error instanceof Failure ? error.message : describe(error)}`);
  process.exitCode = 1;
}

process.on("unhandledRejection", error => {
  fail(error);
  process.exit(1);
});

run().catch(fail);
