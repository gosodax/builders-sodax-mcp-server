import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { API_KEY_HINT } from "./http.js";
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
  it("posts to the SODAX API relay with the caller's key", async () => {
    fetchSpy.mockResolvedValueOnce(new Response('{"success":true,"message":"Transaction registered"}'));
    await runWithRequestContext({ apiKey: "k1" }, () => submitRelayTx(params));
    const [url, init] = fetchSpy.mock.calls[0] ?? [];
    expect(url).toBe("https://api.sodax.com/v1/relay/");
    expect((init as RequestInit).headers).toMatchObject({ "x-api-key": "k1" });
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

  it("tells the agent how to fix a rejected key", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("", { status: 401 }));
    await expect(submitRelayTx(params)).rejects.toThrow(API_KEY_HINT);
  });
});
