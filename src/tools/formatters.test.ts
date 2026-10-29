import { describe, expect, it } from "vitest";
import { formatAsMarkdown } from "./formatters.js";

describe("formatAsMarkdown tables", () => {
  it("keeps addresses and hashes whole", () => {
    const address = "0xdb7bda65c3a1c51d64dc4444e418684677334109";
    const txHash = `0x${"ab".repeat(32)}`;
    const md = formatAsMarkdown([{ address, txHash }]);
    expect(md).toContain(`| ${address} | ${txHash} |`);
  });

  it("marks a nested object it shortens", () => {
    const md = formatAsMarkdown([{ meta: { note: "x".repeat(40) } }]);
    expect(md).toContain(`| ${'{"note":"xxxxxxxxxxxxxxxxxxxxx'}… |`);
  });

  it("leaves a short nested object as it is", () => {
    expect(formatAsMarkdown([{ meta: { a: 1 } }])).toContain('| {"a":1} |');
  });
});
