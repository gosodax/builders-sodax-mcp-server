/**
 * Shared response formatters for MCP tool output.
 *
 * Tools accept a `format` argument ('json' | 'markdown'). JSON is a raw
 * pretty-printed dump; markdown renders arrays of objects as tables and
 * single objects as **key:** value lists, with long values truncated.
 */

import { ResponseFormat } from "../types.js";

const TABLE_MAX_COLUMNS = 6;
const TABLE_MAX_ROWS = 20;
const TABLE_CELL_OBJECT_MAX = 30;
const TABLE_CELL_STRING_MAX = 40;

/** Unicode "other" category: newlines, tabs, C0/C1 controls and invisible format characters. */
const CONTROL_CHARS = /\p{C}/gu;

/**
 * Escape an untrusted value for inline Markdown.
 *
 * Values rendered here can be attacker-controlled (e.g. on-chain ERC-20
 * `symbol`/`name`), and the rendered Markdown is fed straight into an LLM
 * context, so a value must not be able to break out of its cell or line:
 * control characters (including newlines) collapse to a single space, runs of
 * whitespace collapse, and `\`, `|` and backticks are backslash-escaped so no
 * value can forge a table column or open/close a code fence.
 *
 * Always escape *before* truncating — see {@link truncateEscaped}.
 */
function escapeInline(value: unknown): string {
  return String(value)
    .replace(CONTROL_CHARS, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/`/g, "\\`");
}

/**
 * Truncate an already-escaped string, never leaving a dangling backslash.
 *
 * Every backslash in an escaped string is either half of `\\` or the escape of
 * the character that follows it, so an odd-length trailing backslash run means
 * the slice cut an escape sequence in half; dropping one backslash restores a
 * balanced (and still fully escaped) string.
 */
function truncateEscaped(value: string, max: number): string {
  if (value.length <= max) return value;
  const sliced = value.slice(0, max);
  const trailing = /\\+$/.exec(sliced);
  return trailing && trailing[0].length % 2 === 1 ? sliced.slice(0, -1) : sliced;
}

/**
 * Neutralise backticks inside ```json fenced blocks. Backslash escapes do not
 * apply inside a fence, so backticks are replaced outright to stop a nested
 * object's stringified content from closing the fence.
 */
function escapeFenced(value: string): string {
  return value.replace(/`/g, "'");
}

export function formatResponse(data: unknown, format: ResponseFormat): string {
  if (format === ResponseFormat.MARKDOWN) {
    return formatAsMarkdown(data);
  }
  return JSON.stringify(data, null, 2);
}

export function formatAsMarkdown(data: unknown): string {
  if (Array.isArray(data)) {
    if (data.length === 0) return "_No data available_";

    if (typeof data[0] === "object" && data[0] !== null) {
      const keys = Object.keys(data[0]).slice(0, TABLE_MAX_COLUMNS);
      let md = `| ${keys.map(escapeInline).join(" | ")} |\n`;
      md += `| ${keys.map(() => "---").join(" | ")} |\n`;
      for (const item of data.slice(0, TABLE_MAX_ROWS)) {
        const values = keys.map(k => {
          const val = (item as Record<string, unknown>)[k];
          if (val === null || val === undefined) return "-";
          if (typeof val === "object") {
            return truncateEscaped(escapeInline(JSON.stringify(val)), TABLE_CELL_OBJECT_MAX);
          }
          return truncateEscaped(escapeInline(val), TABLE_CELL_STRING_MAX);
        });
        md += `| ${values.join(" | ")} |\n`;
      }
      if (data.length > TABLE_MAX_ROWS) {
        md += `\n_... and ${data.length - TABLE_MAX_ROWS} more items_`;
      }
      return md;
    }
    return data.map(item => `- ${escapeInline(item)}`).join("\n");
  }

  if (typeof data === "object" && data !== null) {
    return Object.entries(data)
      .map(([key, value]) => {
        if (typeof value === "object" && value !== null) {
          return `**${escapeInline(key)}:**\n\`\`\`json\n${escapeFenced(JSON.stringify(value, null, 2))}\n\`\`\``;
        }
        return `**${escapeInline(key)}:** ${escapeInline(value)}`;
      })
      .join("\n\n");
  }

  return String(data);
}
