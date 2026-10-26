/**
 * The template every swap tool shares: zod input (the SDK validates it before
 * the handler runs), structured output with a `status` and one `nextStep`
 * sentence, and failures returned as `{ status: "error", error: { code, message },
 * nextStep }` with `isError`. Failures are returned, never thrown, so no caller
 * input reaches analytics (which records a thrown error's message).
 */

import type { McpServer, ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ShapeOutput, ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { logger } from "../services/logger.js";
import { ActionError } from "../services/swap/errors.js";
import { registerAppTool } from "../services/toolRegistry.js";

type ActionOutput = Record<string, unknown> & { status: string; nextStep: string };

export function registerActionTool<Args extends ZodRawShapeCompat>(
  server: McpServer,
  name: string,
  description: string,
  input: Args,
  annotations: ToolAnnotations,
  run: (args: ShapeOutput<Args>) => Promise<ActionOutput>,
): void {
  const handler = async (args: ShapeOutput<Args>): Promise<CallToolResult> => {
    try {
      return toResult(await run(args));
    } catch (error) {
      if (!(error instanceof ActionError)) logger.error({ err: error, tool: name }, "Swap tool failed");
      const failure =
        error instanceof ActionError ? error : new ActionError("INTERNAL", "The tool failed unexpectedly.");
      const out = { error: { ...failure.details, code: failure.code, message: failure.message } };
      return toResult({ status: "error", ...out, nextStep: failure.nextStep }, true);
    }
  };
  // ToolCallback<Args> is a conditional type TypeScript can't narrow while Args is generic;
  // for a zod shape it is exactly (args: ShapeOutput<Args>, extra) => CallToolResult.
  registerAppTool(server, "swap", name, description, input, annotations, handler as unknown as ToolCallback<Args>);
}

function toResult(out: ActionOutput, isError = false): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(out, null, 2) }],
    structuredContent: out,
    ...(isError && { isError }),
  };
}
