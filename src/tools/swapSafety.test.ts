/** The ADR's safety rules, one test each, across the swap tools. */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { walletBalance } from "../services/sodax.js";
import { clearCache } from "../services/sodaxApi.js";
import { catalogFetch } from "../services/swap/__fixtures__/catalog.js";
import { clearSwapCatalogCache } from "../services/swap/tokens.js";
import { callTool, swapClient } from "./__fixtures__/swapClient.js";

vi.mock("../services/sodax.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../services/sodax.js")>();
  return { ...actual, walletBalance: vi.fn() };
});

const USER = "0x000000000000000000000000000000000000dEaD";
const TX = `0x${"ab".repeat(32)}`;
const PHRASE = `${"abandon ".repeat(11)}about`;
const API_KEY = `sodax_${"Ab3-".repeat(11)}`;
const QUOTE = { fromChain: "arb", fromToken: "USDC", toChain: "sonic", toToken: "USDC", amount: "5" };

let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  clearSwapCatalogCache();
  clearCache();
  fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(catalogFetch());
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(walletBalance).mockReset();
});

describe("swap tool safety", () => {
  it.each([
    ["sodax_resolve_token", { chain: "arb", query: PHRASE }, "query"],
    ["sodax_get_balance", { chain: "arb", address: API_KEY }, "address"],
    ["sodax_swap_quote", { ...QUOTE, toAddress: PHRASE }, "toAddress"],
    ["sodax_swap_quote", { ...QUOTE, amount: PHRASE }, "amount"],
    ["sodax_swap_quote", { ...QUOTE, amount: TX }, "amount"],
    ["sodax_swap_track", { txHash: TX, chain: API_KEY }, "chain"],
    ["sodax_swap_cancel", { txHash: TX, chain: API_KEY }, "chain"],
  ])("%s refuses a pasted secret before any call, and never repeats it", async (tool, args, field) => {
    const { out } = await callTool(tool, args);
    expect(out.error).toMatchObject({ code: "SECRET_REJECTED", field });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(JSON.stringify(out)).not.toMatch(/abandon|Ab3-|abab/);
  });

  it("tells the agent to rotate a pasted SODAX API key", async () => {
    const { out } = await callTool("sodax_get_balance", { chain: "arb", address: API_KEY });
    expect(out.nextStep).toBe(
      "Tell the user to rotate that SODAX API key and send keys only as the x-api-key header, never as a tool input.",
    );
  });

  // zod checks these fields before the handler, so the refusal comes back as the validation error's text.
  it.each([
    ["sodax_swap_quote", { ...QUOTE, amount: `${"abandon ".repeat(23)}art` }, "amount", "seed phrase"],
    ["sodax_swap_track", { txHash: PHRASE }, "txHash", "seed phrase"],
    ["sodax_swap_track", { txHash: API_KEY }, "txHash", "rotate that SODAX API key"],
    ["sodax_swap_cancel", { txHash: TX, cancelTxHash: PHRASE }, "cancelTxHash", "seed phrase"],
    ["sodax_swap_track", { txHash: TX, quoteId: PHRASE }, "quoteId", "seed phrase"],
    ["sodax_swap_track", { txHash: TX, quoteId: TX }, "quoteId", "64-hex value, not a quoteId"],
  ])("%s refuses a secret in a field zod checks first (%#)", async (tool, args, field, says) => {
    const client = await swapClient();
    const result = await client.callTool({ name: tool, arguments: args });
    await client.close();
    expect(result.isError).toBe(true);
    const text = JSON.stringify(result.content);
    expect(text).toContain("SECRET_REJECTED");
    expect(text).toContain(says);
    expect(text).toContain(`\\"${field}\\"`);
    expect(text).not.toMatch(/abandon|Ab3-|abab/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("gives a plain validation error for a malformed value that isn't a secret", async () => {
    const client = await swapClient();
    const result = await client.callTool({ name: "sodax_swap_track", arguments: { txHash: "0x1234", quoteId: "q-1" } });
    await client.close();
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).not.toContain("SECRET_REJECTED");
  });

  it.each([
    ["sodax_swap_quote", { ...QUOTE, fromAddress: TX }],
    ["sodax_swap_quote", { ...QUOTE, fromAddress: USER, toAddress: TX }],
    ["sodax_resolve_token", { chain: "arb", query: TX }],
    ["sodax_get_balance", { chain: "arb", address: TX }],
  ])("%s refuses a 64-hex value that isn't valid on an EVM chain", async (tool, args) => {
    const { out } = await callTool(tool, args);
    expect(out.error).toMatchObject({ code: "SECRET_REJECTED", message: expect.stringContaining("64-hex") });
    expect(out.nextStep).toContain("sodax_swap_track");
  });

  it("takes a 64-hex address where the chain says it's one (Sui)", async () => {
    vi.mocked(walletBalance).mockResolvedValue(0n);
    const { out } = await callTool("sodax_get_balance", { chain: "sui", address: TX });
    expect(out.status).toBe("ok");
  });

  // Some MCP clients don't resolve `$ref`.
  it("gives every field its own input schema, with no $ref", async () => {
    const client = await swapClient();
    const { tools } = await client.listTools();
    await client.close();
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) expect(JSON.stringify(tool.inputSchema)).not.toContain("$ref");
  });

  it("takes no RPC URL and no partner fee as a tool input", async () => {
    const client = await swapClient();
    const { tools } = await client.listTools();
    await client.close();
    const inputs = tools.flatMap(tool => Object.keys(tool.inputSchema.properties ?? {}));
    expect(inputs.length).toBeGreaterThan(0);
    expect(inputs.filter(name => /rpc|url|fee|partner/i.test(name))).toEqual([]);
  });

  it("has no code that signs or broadcasts a transaction", () => {
    const sources = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
        entry.isDirectory()
          ? sources(join(dir, entry.name))
          : entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")
            ? [join(dir, entry.name)]
            : [],
      );
    const signing = /sendRawTransaction|signTransaction|sendTransaction\(|privateKeyToAccount|mnemonicToAccount/;
    const offenders = sources(new URL("..", import.meta.url).pathname).filter(file =>
      signing.test(readFileSync(file, "utf8")),
    );
    expect(offenders).toEqual([]);
  });

  it("still tells the agent a seed phrase too long for the field is exposed", async () => {
    const longPhrase = `${"abandon ".repeat(23)}art`;
    const client = await swapClient();
    const result = await client.callTool({ name: "sodax_swap_quote", arguments: { ...QUOTE, toAddress: longPhrase } });
    await client.close();
    expect(result.isError).toBe(true);
    const text = JSON.stringify(result.content);
    expect(text).toContain("SECRET_REJECTED");
    expect(text).toContain("treat it as exposed");
    expect(text).not.toContain("abandon");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("calls a 64-hex token query not a token, and a 64-hex address not an address", async () => {
    const token = await callTool("sodax_resolve_token", { chain: "arb", query: TX });
    expect(token.out.error).toMatchObject({
      message: "That's a 64-hex value, not a token on Arbitrum.",
      field: "query",
    });
    const address = await callTool("sodax_get_balance", { chain: "arb", address: TX });
    expect(address.out.error).toMatchObject({ message: "That's a 64-hex value, not an address on Arbitrum." });
  });

  it("calls a 64-hex amount not an amount", async () => {
    const { out } = await callTool("sodax_swap_quote", { ...QUOTE, amount: TX });
    expect(out.error).toMatchObject({ message: "That's a 64-hex value, not an amount.", field: "amount" });
  });
});
