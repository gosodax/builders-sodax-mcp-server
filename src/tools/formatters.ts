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
      let md = `| ${keys.join(" | ")} |\n`;
      md += `| ${keys.map(() => "---").join(" | ")} |\n`;
      for (const item of data.slice(0, TABLE_MAX_ROWS)) {
        const values = keys.map(k => {
          const val = (item as Record<string, unknown>)[k];
          if (val === null || val === undefined) return "-";
          if (typeof val === "object") return JSON.stringify(val).slice(0, TABLE_CELL_OBJECT_MAX);
          return String(val).slice(0, TABLE_CELL_STRING_MAX);
        });
        md += `| ${values.join(" | ")} |\n`;
      }
      if (data.length > TABLE_MAX_ROWS) {
        md += `\n_... and ${data.length - TABLE_MAX_ROWS} more items_`;
      }
      return md;
    }
    return data.map(item => `- ${String(item)}`).join("\n");
  }

  if (typeof data === "object" && data !== null) {
    return Object.entries(data)
      .map(([key, value]) => {
        if (typeof value === "object" && value !== null) {
          return `**${key}:**\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
        }
        return `**${key}:** ${value}`;
      })
      .join("\n\n");
  }

  return String(data);
}
