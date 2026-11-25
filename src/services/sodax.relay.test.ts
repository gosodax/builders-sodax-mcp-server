import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { hubRelayPackets, initSodax } from "./sodax.js";

const HUB_TX = `0x${"cd".repeat(32)}`;
const PACKET = {
  src_chain_id: 146,
  src_tx_hash: "cd".repeat(32),
  src_address: "60c5681bd1db4e50735c4ca3386005a4ba4937c0",
  status: "executed",
  dst_chain_id: 30,
  conn_sn: 1,
  dst_address: "ab",
  dst_tx_hash: "ef".repeat(32),
  signatures: [],
  payload: "c0",
};

beforeAll(() => initSodax());
afterEach(() => {
  vi.restoreAllMocks();
});

const relayAnswers = (response: () => Response) =>
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => response());

describe("hubRelayPackets", () => {
  it("keeps the packets the relay sends well formed, and leaves the rest out", async () => {
    relayAnswers(() => Response.json({ success: true, data: [PACKET, { ...PACKET, src_chain_id: null }, "x"] }));
    expect(await hubRelayPackets(HUB_TX)).toEqual([
      expect.objectContaining({ src_chain_id: 146, dst_tx_hash: "ef".repeat(32) }),
    ]);
  });

  it("is none when the relay holds no packet of the tx yet, or answers without a list", async () => {
    relayAnswers(() => new Response("not found", { status: 404 }));
    expect(await hubRelayPackets(HUB_TX)).toEqual([]);
    relayAnswers(() => Response.json({ success: true, data: null }));
    expect(await hubRelayPackets(HUB_TX)).toEqual([]);
  });

  it("fails, carrying none of the relay's text, on any other answer", async () => {
    relayAnswers(() => new Response("secret upstream detail", { status: 500 }));
    const error = await hubRelayPackets(HUB_TX).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain("secret upstream detail");
  });
});
