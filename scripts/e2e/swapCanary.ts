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
 * From `src/` it imports types, `sameHex` and the retryable error codes (errors.ts loads only constants.ts,
 * which loads nothing), so no SDK code runs in the process that holds the key. It isn't isolated from the
 * server, though: on the runner the server runs as the same user and could read this process's environment.
 */

import { appendFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { spokeChainConfig } from "@sodax/types";
import {
  http,
  BaseError,
  ExecutionRevertedError,
  type Hex,
  RpcRequestError,
  createPublicClient,
  createWalletClient,
  decodeFunctionData,
  encodeFunctionData,
  erc20Abi,
  formatEther,
  formatUnits,
  keccak256,
  parseAbi,
  parseEther,
  parseUnits,
  publicActions,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrum, base } from "viem/chains";
import { sameHex } from "../../src/constants.js";
import { type ActionErrorCode, RETRYABLE_CODES } from "../../src/services/swap/errors.js";
import type { SwapQuote, SwapStep } from "../../src/services/swap/quote.js";
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
// A failed swap send is looked up 7 times, 5 s apart, 4 s each: a gateway error or a timeout may come
// after the node took it.
const LOOKUP_TRIES = 7;
const LOOKUP_INTERVAL_MS = 5_000;
const LOOKUP_TIMEOUT_MS = 4_000;
// A node's own message when it refuses a tx outright. Any other send error may come after a node took it.
const REFUSED =
  /insufficient funds|intrinsic gas too low|exceeds block gas limit|less than block base fee|underpriced|exceeds the configured cap|invalid sender/i;
const PREPARE_TRIES = 3;
const PREPARE_INTERVAL_MS = 5_000;
// The server's retryable codes, but INTERNAL: a bug should fail the canary, not be waited out.
const RETRYABLE: readonly ActionErrorCode[] = RETRYABLE_CODES.filter(code => code !== "INTERNAL");
const PENDING: readonly TrackResult["status"][] = ["awaiting_source_confirmation", "queued", "in_progress"];
// The spoke asset manager's deposit, as the SDK's `spokeAssetManagerAbi` has it.
const ASSET_MANAGER_ABI = parseAbi(["function transfer(address token, bytes to, uint256 amount, bytes data) payable"]);

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

/**
 * A signer that also reads, per side, on the side's RPC override or viem's default, and a reader for the
 * swap lookups that tries each once, for 4 s (not viem's 10 s and 3 retries). USDC from the SDK config.
 */
export function wallets(account: Env["account"]) {
  return SIDES.map(({ key, chain }) => {
    const url = process.env[`SODAX_RPC_URL_${chain.id}`] || undefined;
    return {
      key,
      usdc: spokeChainConfig[key].supportedTokens.USDC,
      client: createWalletClient({ account, chain, transport: http(url) }).extend(publicActions),
      lookup: createPublicClient({ chain, transport: http(url, { retryCount: 0, timeout: LOOKUP_TIMEOUT_MS }) }),
    };
  });
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
  try {
    await client.connect(
      new StreamableHTTPClientTransport(mcpUrl, { requestInit: { headers: { "x-api-key": apiKey } } }),
    );
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
  const mismatch = stepMismatch(out.steps, src, parseUnits(env.amount, src.usdc.decimals));
  if (mismatch) throw new Failure(`unexpected ${mismatch}`);
  log(`quoteId ${out.quoteId}, at least ${out.to.minimumAmount} USDC, ${out.steps.length} steps`);
  return out as ReadyQuote;
}

/**
 * The server builds what this key signs, so check the shape this route needs first: all on the source
 * chain with no ETH, a USDC approve of exactly the amount to the asset manager (a reset to 0 before it is
 * allowed), and one swap last: the asset manager's deposit of exactly the amount of USDC (an allowance
 * left by an earlier run could pull more). Names the first field that differs.
 */
export function stepMismatch(steps: SwapStep[], src: Wallet, amount: bigint): string | undefined {
  const { assetManager } = spokeChainConfig[src.key].addresses;
  if (steps.at(-1)?.kind !== "swap" || steps.findIndex(step => step.kind === "swap") !== steps.length - 1) {
    return "steps: one swap, last";
  }
  for (const [i, { kind, chainId, tx }] of steps.entries()) {
    const spend = kind === "approve" ? amount : 0n;
    const approve = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [assetManager, spend] });
    const checks: [string, boolean][] = [
      ["chainId", chainId === src.client.chain.id],
      ["tx.value", BigInt(tx.value) === 0n],
      ["tx.to", sameHex(tx.to, kind === "swap" ? assetManager : src.usdc.address)],
      kind === "swap"
        ? [`tx.data: not transfer(USDC, ${amount})`, deposits(tx.data, src.usdc.address, amount)]
        : [`tx.data: not approve(asset manager, ${spend})`, sameHex(tx.data, approve)],
    ];
    const field = checks.find(([, ok]) => !ok)?.[0];
    if (field) return `step ${i + 1} (${kind}) ${field}`;
  }
}

/** Whether `data` calls the asset manager's deposit of exactly `amount` of `token`. */
function deposits(data: string, token: Hex, amount: bigint): boolean {
  try {
    const { args } = decodeFunctionData({ abi: ASSET_MANAGER_ABI, data: data as Hex });
    return sameHex(args[0], token) && args[2] === amount;
  } catch {
    return false;
  }
}

/**
 * Sends the quote's steps in order, each mined before the next. The swap is signed and its hash logged
 * before it's sent, so a send that errors after the node took it is still tracked.
 */
export async function sendSteps(wallet: Wallet, quote: ReadyQuote): Promise<Hex> {
  const { client } = wallet;
  // Counted here, not asked per step: a load-balanced public RPC can answer from a node that hasn't
  // seen the approve yet.
  let nonce = await client.getTransactionCount({ address: client.account.address, blockTag: "pending" });
  for (const step of quote.steps) {
    const request = await prepare(client, {
      to: step.tx.to as Hex,
      data: step.tx.data as Hex,
      value: BigInt(step.tx.value),
      nonce: nonce++,
    });
    // The prepared request is a full transaction for this chain's account; viem's union type can't say so.
    const serialized = await client.signTransaction(request as never);
    const hash = keccak256(serialized);
    log(`${step.kind}: ${hash}`);
    if (step.kind === "swap") {
      await sendSwap(wallet, serialized, hash);
      return hash;
    }
    await client.sendRawTransaction({ serializedTransaction: serialized });
    const receipt = await client.waitForTransactionReceipt({ hash, timeout: 120_000 });
    if (receipt.status !== "success") throw new Failure(`${step.kind} reverted`);
  }
  throw new Failure("the quote had no swap step");
}

/** Fills gas and fees, again when that reverts: the node may not have seen the step before it yet. */
async function prepare(client: Wallet["client"], tx: { to: Hex; data: Hex; value: bigint; nonce: number }) {
  for (let tries = 1; ; tries++) {
    try {
      return await client.prepareTransactionRequest(tx);
    } catch (error) {
      // viem estimates the gas or has the node fill the tx: a revert in either is in the cause chain.
      // Only that is prepared again; viem has already retried a timeout.
      const reverted = error instanceof BaseError && error.walk(cause => cause instanceof ExecutionRevertedError);
      if (!reverted || tries === PREPARE_TRIES) throw error;
      log(`${describe(error)}; preparing again`);
      await sleep(PREPARE_INTERVAL_MS);
    }
  }
}

/**
 * Sends the swap. A send that errors may still have reached the pool (a gateway 5xx, "already known",
 * a timeout), whatever the error says: the swap is tracked unless the node refused it and no node has it.
 * Tracking a swap that never lands is harmless: the server submits it only after its own receipt check.
 */
async function sendSwap({ client, lookup }: Wallet, serializedTransaction: Hex, hash: Hex): Promise<void> {
  let refused = false;
  try {
    await client.sendRawTransaction({ serializedTransaction });
    return;
  } catch (error) {
    refused =
      error instanceof BaseError &&
      error.walk(cause => cause instanceof RpcRequestError && REFUSED.test(cause.details)) !== null;
    log(`send reported ${describe(error)}; looking the swap up`);
  }
  for (let tries = 1; tries <= LOOKUP_TRIES; tries++) {
    if (tries > 1) await sleep(LOOKUP_INTERVAL_MS);
    const found = await lookup.getTransaction({ hash }).then(
      () => true,
      () => false,
    );
    if (found) return log("a node has the swap; tracking it");
  }
  if (!refused) return log("send outcome unknown; tracking anyway");
  throw new Failure("the node refused the swap and no node had it");
}

/** Calls track through the quote's afterSend until it says solved, up to 5 minutes past the quote's expiry. */
export async function track(env: Env, quote: ReadyQuote, txHash: Hex, call = callTool<TrackResult>): Promise<void> {
  const deadline = Date.parse(quote.expiresAt) + 5 * 60_000;
  const wait = (sec: number) => sleep(Math.min(sec * 1000, deadline - Date.now()));
  while (Date.now() < deadline) {
    const reply = await call(env, quote.afterSend.tool, { ...quote.afterSend.args, txHash }).catch((error: unknown) => {
      // The client's 60 s request timeout, the server's rate limiter, a dropped connection: ask again.
      log(`${describe(error)}, retrying`);
    });
    if (!reply) {
      await wait(DEFAULT_RETRY_SEC);
      continue;
    }
    const { isError, out } = reply;
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
    await wait(retryAfterSec);
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

/**
 * viem errors by name and short message (no URL or request body); anything else by name, and its code if
 * numeric (an MCP error code or an HTTP status).
 */
function describe(error: unknown): string {
  if (error instanceof BaseError) return `${error.name}: ${error.shortMessage}`;
  if (!(error instanceof Error)) return typeof error;
  return "code" in error && typeof error.code === "number" ? `${error.name} ${error.code}` : error.name;
}

function fail(error: unknown): void {
  console.error(`E2E failed at ${stage}: ${error instanceof Failure ? error.message : describe(error)}`);
  process.exitCode = 1;
}

// Imported by its test; run otherwise. Node's default handlers would print the message, which may carry a URL.
if (!process.env.VITEST) {
  const crash = (error: unknown) => {
    fail(error);
    process.exit(1);
  };
  process.on("unhandledRejection", crash);
  process.on("uncaughtException", crash);
  run().catch(fail);
}
