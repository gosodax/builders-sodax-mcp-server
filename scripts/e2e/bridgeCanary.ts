/**
 * Canary bridge dry run: the bridge tools, the way an agent calls them, against a server with them on, up to the
 * transactions a wallet would sign. Nothing is signed or sent, so no funded wallet or key is needed: it checks the
 * environment, the API key and that the Bridge API's builds still match the server's SDK, from an EVM and a non-EVM
 * chain. `.github/workflows/e2e-canary.yml` runs it on manual dispatch; locally, see the README.
 *
 * Env: MCP_URL (with `?profile=bridge`), SODAX_API_KEY. It prints only text it builds, as the swap canary does.
 * It imports no SDK code: only the packaged config (`@sodax/types`), for the addresses a build must call.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { spokeChainConfig } from "@sodax/types";

// The sender of the recorded Solana deposit in `src/services/swap/__fixtures__/non-evm-txs.json` (public chain data),
// and a recipient that burns nothing.
const SOLANA_SENDER = "7pDfGNrY3Be2yYW496rYzLQHVJzMDUyTWK2eguhZkPAx";
const EVM_SENDER = "0x000000000000000000000000000000000000dEaD";
const RECIPIENT = "0x1111111111111111111111111111111111111111";

class Failure extends Error {}

interface Result {
  status?: string;
  error?: { code?: string };
  nextAction?: { type?: string; next?: { afterSend?: { tool?: string } } };
  steps?: { kind?: string; chainId?: number; chainType?: string; tx?: { to?: string } }[];
  pairs?: { from?: { symbol?: string }; to?: { symbol?: string } }[];
  maxAmount?: string;
}

function readEnv(): { mcpUrl: URL; apiKey: string } {
  const { MCP_URL, SODAX_API_KEY } = process.env;
  if (!MCP_URL || !URL.canParse(MCP_URL)) throw new Failure("MCP_URL must be the server's /mcp URL");
  if (!SODAX_API_KEY) throw new Failure("SODAX_API_KEY is required: the bridge profile refuses keyless connections");
  return { mcpUrl: new URL(MCP_URL), apiKey: SODAX_API_KEY };
}

/** One tool call on a fresh connection: the server is stateless per request. */
async function callTool(env: { mcpUrl: URL; apiKey: string }, name: string, args: Record<string, unknown>) {
  const client = new Client({ name: "sodax-canary-bridge", version: "1.0.0" });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(env.mcpUrl, { requestInit: { headers: { "x-api-key": env.apiKey } } }),
    );
    const result = await client.callTool({ name, arguments: args });
    const out = (result.structuredContent ?? {}) as Result;
    if (result.isError) throw new Failure(`${name}: ${out.error?.code ?? "error"}`);
    return out;
  } finally {
    await client.close();
  }
}

const expect = (ok: boolean, what: string) => {
  if (!ok) throw new Failure(what);
};

async function run(): Promise<void> {
  const env = readEnv();

  const listed = await callTool(env, "sodax_bridge_tokens", { fromChain: "arbitrum", toChain: "base" });
  expect(
    listed.pairs?.some(pair => pair.from?.symbol === "USDC" && pair.to?.symbol === "USDC") === true,
    "no USDC pair Arbitrum -> Base",
  );
  console.log(`tokens: ${listed.pairs?.length} pairs Arbitrum -> Base`);

  const route = { fromChain: "arbitrum", fromToken: "USDC", toChain: "base", toToken: "USDC", amount: "1" };
  const preview = await callTool(env, "sodax_bridge_preview", route);
  expect(preview.status === "preview" && Number(preview.maxAmount) >= 1, "the route takes less than 1 USDC");
  console.log(`preview: up to ${preview.maxAmount} USDC`);

  const evm = await callTool(env, "sodax_bridge_prepare", { ...route, fromAddress: EVM_SENDER, toAddress: RECIPIENT });
  const deposit = evm.steps?.at(-1);
  expect(evm.status === "ready", "EVM prepare isn't ready");
  expect(deposit?.kind === "bridge" && deposit.chainId === 42161, "EVM deposit isn't a bridge step on Arbitrum");
  expect(
    deposit?.tx?.to?.toLowerCase() === spokeChainConfig["0xa4b1.arbitrum"].addresses.assetManager.toLowerCase(),
    "EVM deposit doesn't call Arbitrum's asset manager",
  );
  expect(evm.nextAction?.next?.afterSend?.tool === "sodax_bridge_submit_and_track", "prepare doesn't lead to track");
  console.log(`prepare EVM: ${evm.steps?.map(step => step.kind).join(", ")}`);

  const solana = await callTool(env, "sodax_bridge_prepare", {
    fromChain: "solana",
    fromToken: "native",
    toChain: "sonic",
    toToken: "SOL",
    amount: "0.01",
    fromAddress: SOLANA_SENDER,
    toAddress: RECIPIENT,
  });
  expect(solana.status === "ready" && solana.steps?.[0]?.chainType === "SOLANA", "Solana prepare isn't ready");
  console.log("prepare Solana: bridge");
  console.log("dry run: nothing signed");
}

run().catch((error: unknown) => {
  // Only text this script builds: an error's own message may carry what the server or a node said.
  console.error(
    error instanceof Failure
      ? `FAILED: ${error.message}`
      : `FAILED: ${error instanceof Error ? error.name : typeof error}`,
  );
  process.exitCode = 1;
});
