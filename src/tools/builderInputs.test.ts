import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearCache } from "../services/sodaxApi.js";
import { mcpClient } from "./__fixtures__/swapClient.js";

type FetchSpy = ReturnType<typeof vi.spyOn<typeof globalThis, "fetch">>;

let fetchSpy: FetchSpy;

const CHAINS = ["sonic", "0x2105.base", "0xa4b1.arbitrum", "0x1.icon"];

/** A stand-in SODAX API: the live chain keys, the relay, and each other route's body by its path's end. */
function stubApi(bodies: Record<string, unknown> = {}, chains: string[] | null = CHAINS) {
  fetchSpy.mockImplementation(async input => {
    const { pathname } = new URL(String(input));
    if (pathname.endsWith("/config/spoke/chains")) {
      return chains ? Response.json(chains) : new Response("down", { status: 503 });
    }
    if (pathname.endsWith("/relay/")) return Response.json({ success: true, data: { conn_sn: "7" } });
    const body = Object.entries(bodies).find(([path]) => pathname.endsWith(path))?.[1];
    return body === undefined ? new Response("not found", { status: 404 }) : Response.json(body);
  });
}

// SODAX API routes only: the docs proxy has calls of its own.
const apiPaths = () =>
  fetchSpy.mock.calls.map(([input]) => new URL(String(input)).pathname).filter(path => !path.endsWith("/mcp"));
const relayParams = () =>
  fetchSpy.mock.calls
    .filter(([input]) => String(input).endsWith("/relay/"))
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)).params);

async function call(name: string, args: Record<string, unknown>) {
  const client = await mcpClient({ builder: true, swap: false });
  try {
    const result = await client.callTool({ name, arguments: args });
    const [first] = result.content as { text: string }[];
    return { isError: result.isError === true, text: first?.text ?? "" };
  } finally {
    await client.close();
  }
}

beforeEach(() => {
  clearCache();
  fetchSpy = vi.spyOn(globalThis, "fetch");
});

afterEach(() => {
  fetchSpy.mockRestore();
});

describe("a chain key argument", () => {
  it("takes the chain's name, as sodax_check_chain_support does", async () => {
    stubApi({ "/config/swap/0x2105.base/tokens": [{ symbol: "USDC" }] });
    const { isError, text } = await call("sodax_get_swap_tokens", { chainId: "Base" });
    expect(isError).toBe(false);
    expect(text).toMatch(/^## Swap Tokens on 0x2105\.base\n/);
    expect(apiPaths().some(path => path.endsWith("/config/swap/0x2105.base/tokens"))).toBe(true);
  });

  it("refuses a chain no key matches, naming the keys but not ICON's, before asking for anything else", async () => {
    stubApi();
    const { isError, text } = await call("sodax_get_hub_assets", { chainId: "Narnia" });
    expect(isError).toBe(true);
    expect(text).toContain("Pass one of these chain keys: sonic, 0x2105.base, 0xa4b1.arbitrum");
    expect(text).not.toContain("icon");
    expect(apiPaths()).toEqual([expect.stringMatching(/\/config\/spoke\/chains$/)]);
  });

  it("keeps an exact key, even when another key ends in it", async () => {
    stubApi({ "/config/swap/sonic/tokens": [] }, ["0x92.sonic", "sonic"]);
    await call("sodax_get_swap_tokens", { chainId: "sonic" });
    expect(apiPaths().some(path => path.endsWith("/config/swap/sonic/tokens"))).toBe(true);
  });

  it("passes the value on as given when the chain list can't be read", async () => {
    stubApi({ "/config/swap/sonic/tokens": [] }, null);
    const { isError } = await call("sodax_get_swap_tokens", { chainId: "sonic" });
    expect(isError).toBe(false);
    expect(apiPaths().some(path => path.endsWith("/config/swap/sonic/tokens"))).toBe(true);
  });

  // The API parses the candles route's chain as an integer.
  it("takes a pool's numeric chain id for its candles, and refuses a name", async () => {
    stubApi({ "/amm/pools/146/0xpool/candles": [] });
    const args = { poolId: "0xpool", interval: "1h", from: 1, to: 2 };
    expect((await call("sodax_get_amm_pool_candles", { ...args, chainId: "146" })).isError).toBe(false);
    const named = await call("sodax_get_amm_pool_candles", { ...args, chainId: "Sonic" });
    expect(named.isError).toBe(true);
    expect(named.text).toContain("'146' for Sonic");
    expect(apiPaths().filter(path => path.includes("/amm/"))).toHaveLength(1);
  });
});

describe("format json", () => {
  it("is the data alone, so it parses", async () => {
    const tokens = [{ symbol: "USDC", address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" }];
    stubApi({ "/config/swap/0x2105.base/tokens": tokens });
    const { text } = await call("sodax_get_swap_tokens", { chainId: "0x2105.base", format: "json" });
    expect(JSON.parse(text)).toEqual(tokens);
  });

  it("answers a lookup that found nothing with null, and the sentence in Markdown", async () => {
    stubApi();
    const json = await call("sodax_get_transaction", { txHash: "0xabc", format: "json" });
    expect(JSON.parse(json.text)).toBeNull();
    const markdown = await call("sodax_get_transaction", { txHash: "0xabc" });
    expect(markdown.text).toBe("Transaction not found: 0xabc");
  });

  // The next page needs the cursor as is: JSON keeps it, and Markdown no longer cuts it short.
  it("keeps the volume's cursor whole, in both formats", async () => {
    const cursor = `c${"x".repeat(60)}`;
    stubApi({ "/solver/volume": { items: [], hasMore: true, nextCursor: cursor } });
    const pair = { inputToken: "0x1", outputToken: "0x2" };
    const json = await call("sodax_get_volume", { ...pair, format: "json" });
    expect(JSON.parse(json.text)).toEqual({ items: [], hasMore: true, nextCursor: cursor });
    const markdown = await call("sodax_get_volume", pair);
    expect(markdown.text).toContain(`Use cursor: \`${cursor}\``);
  });

  it("doesn't call a page the last when the API says there's more but gives no cursor", async () => {
    stubApi({ "/solver/volume": { items: [], hasMore: true } });
    const { text } = await call("sodax_get_volume", { inputToken: "0x1", outputToken: "0x2" });
    expect(text).not.toContain("No more results");
    expect(text).toContain("no cursor");
  });

  it("caches a volume page per filter set, not per token pair", async () => {
    stubApi({ "/solver/volume": { items: [], hasMore: false } });
    const pair = { inputToken: "0x1", outputToken: "0x2" };
    await call("sodax_get_volume", { ...pair, sort: "desc" });
    await call("sodax_get_volume", { ...pair, sort: "asc" });
    expect(apiPaths().filter(path => path.endsWith("/solver/volume"))).toHaveLength(2);
  });
});

describe("the relay tools' arguments", () => {
  it("refuses a packet lookup without its connSn, rather than ask for conn_sn 'undefined'", async () => {
    stubApi();
    const { isError } = await call("sodax_relay_get_packet", { chainId: "146", txHash: "0xabc" });
    expect(isError).toBe(true);
    expect(relayParams()).toEqual([]);
  });

  it("takes connSn as a number or a string of digits, and sends it as a string", async () => {
    stubApi();
    await call("sodax_relay_get_packet", { chainId: "146", txHash: "0xabc", connSn: 7 });
    await call("sodax_relay_get_packet", { chainId: "146", txHash: "0xabc", connSn: "8" });
    expect(relayParams().map(params => params.conn_sn)).toEqual(["7", "8"]);
  });

  it.each([
    { connSn: "seven" },
    { connSn: -1 },
    { connSn: 1.5 },
    { connSn: 1e21 },
    { connSn: 2 ** 53 + 2 },
    { connSn: "1".repeat(21) },
  ])("refuses connSn %o", async ({ connSn }) => {
    stubApi();
    const { isError } = await call("sodax_relay_get_packet", { chainId: "146", txHash: "0xabc", connSn });
    expect(isError).toBe(true);
    expect(relayParams()).toEqual([]);
  });

  it("refuses a chain name where a relay chain id goes, pointing to the id map", async () => {
    stubApi();
    const { isError, text } = await call("sodax_relay_get_transaction_packets", { chainId: "Sonic", txHash: "0xabc" });
    expect(isError).toBe(true);
    expect(text).toContain("sodax_get_relay_chain_id_map");
    expect(relayParams()).toEqual([]);
  });
});
