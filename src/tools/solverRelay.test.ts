import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ResponseFormat } from "../types.js";
import { quoteErrorHint, registerSolverRelayTools } from "./solverRelay.js";

type ToolResult = { content: { type: string; text: string }[]; isError?: boolean };
type Handler = (args: Record<string, unknown>) => Promise<ToolResult>;

/**
 * Register the real tools against a recording server so the handlers can be
 * invoked directly, with `global.fetch` stubbed — this exercises the whole
 * path (tool handler → services/relay.ts `callRelay` → fetch).
 */
function captureHandlers(): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  const server = {
    tool: (name: string, ..._rest: unknown[]) => {
      handlers.set(name, _rest[_rest.length - 1] as Handler);
      return {};
    },
  } as unknown as McpServer;
  registerSolverRelayTools(server);
  return handlers;
}

function jsonResponse(status: number, body: unknown, statusText = ""): Response {
  return new Response(JSON.stringify(body), { status, statusText });
}

describe("quoteErrorHint", () => {
  it("hints to use a chainId-146 hub address when a token is not compatible", () => {
    // Real upstream shape: `{ detail: { message: "One of the following tokens
    // is not compatible with the quote service: 0x…, 0x…" } }`, surfaced by the
    // http/service layers as part of the thrown Error message. Verified against
    // the live API: this error fires only for spoke-chain / non-chainId-146
    // addresses — every chainId-146 oracle address passes the compatibility check.
    const message =
      "Failed to fetch solver quote: HTTP 400 for https://api.sodax.com/v1/intent/quote - " +
      "One of the following tokens is not compatible with the quote service: 0xabc, 0xdef";

    const hint = quoteErrorHint(message);

    expect(hint).not.toBeNull();
    expect(hint).toContain("chainId 146");
    expect(hint).toContain("sodax_get_solver_oracle");
    // Steer to the reliable set — chainId 146 alone doesn't guarantee a route,
    // so the hint must not regress to overly-broad "any chainId 146" guidance.
    expect(hint).toContain("*_ASSET");
  });

  it("hints that 'no path' is liquidity/amount-dependent and recoverable", () => {
    const message =
      "Failed to fetch solver quote: HTTP 400 for https://api.sodax.com/v1/intent/quote - " +
      "No path was found between 0xeb0393893b5bf98a50073d6740738b08e575058b and 0xaeafa26e43f46cd83efe89b1e57c858eb5685a24";

    const hint = quoteErrorHint(message);

    expect(hint).not.toBeNull();
    expect(hint).toContain("smaller amount");
    expect(hint).toContain("liquid");
  });

  it("is case-insensitive (matches regardless of upstream casing)", () => {
    expect(quoteErrorHint("NOT COMPATIBLE WITH THE QUOTE SERVICE")).not.toBeNull();
    expect(quoteErrorHint("NO PATH WAS FOUND between a and b")).not.toBeNull();
  });

  it("returns null for unrelated errors so no misleading hint is appended", () => {
    expect(quoteErrorHint("Failed to fetch solver quote: HTTP 503 for … - upstream unavailable")).toBeNull();
    expect(quoteErrorHint("The operation was aborted due to timeout")).toBeNull();
    expect(quoteErrorHint("Unknown error")).toBeNull();
  });
});

// audit solver-relay-clients:M-1 — the relay used to throw only on HTTP >= 5xx
// and parse every other status, so a 4xx rejection of the one state-changing
// tool was reported to the caller as a successful submission.
describe("sodax_relay_submit_tx error surfacing", () => {
  let handlers: Map<string, Handler>;
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
    handlers = captureHandlers();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const submit = async (): Promise<ToolResult> => {
    const handler = handlers.get("sodax_relay_submit_tx");
    if (!handler) throw new Error("sodax_relay_submit_tx was not registered");
    return handler({ chainId: "146", txHash: "0xabc", format: ResponseFormat.JSON });
  };

  it("reports a 4xx as an error instead of returning it as success", async () => {
    fetchMock.mockResolvedValue(jsonResponse(400, { success: false, message: "bad chain_id" }, "Bad Request"));

    const result = await submit();

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("HTTP 400");
  });

  it("reports a non-JSON 4xx (edge/WAF page) by status, not a JSON parse error", async () => {
    fetchMock.mockResolvedValue(
      new Response("<html><body>429 Too Many Requests</body></html>", { status: 429, statusText: "Too Many Requests" }),
    );

    const result = await submit();

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("HTTP 429");
    expect(result.content[0]?.text).not.toMatch(/JSON|Unexpected token/i);
  });

  it("still errors on 5xx", async () => {
    fetchMock.mockResolvedValue(new Response("upstream down", { status: 502, statusText: "Bad Gateway" }));

    const result = await submit();

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("HTTP 502");
  });

  it("marks a 200 body with success:false as an error", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { success: false, message: "tx not found on source chain" }));

    const result = await submit();

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("FAILED");
  });

  it("returns a genuine success without isError", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { success: true, message: "submitted" }));

    const result = await submit();

    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain("submitted");
  });

  it("never leaks the upstream response body into the error message", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(403, { success: false, message: "internal-token-abc123 rejected at edge" }, "Forbidden"),
    );

    const result = await submit();

    expect(result.content[0]?.text).not.toContain("internal-token-abc123");
  });
});

describe("relay 404 'not found' stays a normal answer", () => {
  let handlers: Map<string, Handler>;
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
    handlers = captureHandlers();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("surfaces a 404 {success:false} packet lookup without erroring", async () => {
    fetchMock.mockResolvedValue(jsonResponse(404, { success: false, message: "packet not found" }, "Not Found"));

    const handler = handlers.get("sodax_relay_get_transaction_packets");
    if (!handler) throw new Error("sodax_relay_get_transaction_packets was not registered");
    const result = await handler({ chainId: "146", txHash: "0xabc", format: ResponseFormat.JSON });

    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain("packet not found");
  });
});
