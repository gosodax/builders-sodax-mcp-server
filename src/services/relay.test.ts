import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getRelayTransactionPackets, submitRelayTx } from "./relay.js";
import { runWithRequestContext } from "./requestContext.js";

type FetchSpy = ReturnType<typeof vi.spyOn<typeof globalThis, "fetch">>;

let fetchSpy: FetchSpy;

beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, "fetch");
});

afterEach(() => {
  fetchSpy.mockRestore();
});

const params = { chain_id: "146", tx_hash: "0xabc" };

describe("relay client", () => {
  it("posts to the SODAX API relay route without the caller's key", async () => {
    fetchSpy.mockResolvedValueOnce(new Response('{"success":true,"message":"Transaction registered"}'));
    await runWithRequestContext({ apiKey: "sodax_k1" }, () => submitRelayTx(params));
    const [url, init] = fetchSpy.mock.calls[0] ?? [];
    expect(url).toBe("https://api.sodax.com/v1/relay/");
    expect((init as RequestInit).headers).not.toHaveProperty("x-api-key");
  });

  it("still returns the relay's 404 body", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response('{"success":false,"message":"requested packet not found"}', { status: 404 }),
    );
    await expect(getRelayTransactionPackets(params)).resolves.toEqual({
      success: false,
      message: "requested packet not found",
    });
  });

  it("treats the edge's 429 as an error, not a relay answer", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response('{"ok":false,"error":"rate_limited"}', { status: 429, headers: { "Retry-After": "10" } }),
    );
    await expect(submitRelayTx(params)).rejects.toThrow("HTTP 429 rate limited, retry after 10s");
  });
});
