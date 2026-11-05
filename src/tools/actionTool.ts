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
import { alertOperator } from "../services/swap/alerts.js";
import { ALERTED_CODES, ActionError, RETRYABLE_CODES } from "../services/swap/errors.js";
import { screenSecrets } from "../services/swap/secrets.js";
import { registerAppTool } from "../services/toolRegistry.js";

type ActionOutput = Record<string, unknown> & { status: string; nextStep: string };

const DEFAULT_RETRY_AFTER_SEC = 30;

export function registerActionTool<Args extends ZodRawShapeCompat>(
  server: McpServer,
  name: string,
  description: string,
  input: Args,
  annotations: ToolAnnotations,
  run: (args: ShapeOutput<Args>) => Promise<ActionOutput>,
  /** What to tell the agent on a retryable failure instead of the code's default (e.g. funds are on chain). */
  retryAdvice?: (retryAfterSec: number) => string,
): void {
  const handler = async (args: ShapeOutput<Args>): Promise<CallToolResult> => {
    try {
      // After the SDK's zod check, before the handler's own validation, an upstream call or a log.
      screenSecrets(args);
      return toResult(await run(args));
    } catch (error) {
      // The logger strips URLs from `err`: SDK and viem errors carry the RPC URL.
      if (!(error instanceof ActionError)) logger.error({ err: error, tool: name }, "Swap tool failed");
      const failure =
        error instanceof ActionError ? error : new ActionError("INTERNAL", "The tool failed unexpectedly.");
      if (ALERTED_CODES.includes(failure.code)) {
        // ActionError messages here are fixed text; an unexpected error is named by its class only.
        const reason =
          error instanceof ActionError ? error.message : error instanceof Error ? error.name : typeof error;
        // Per chain too: one chain's config or builds going wrong doesn't silence another's.
        const chainKey = failure.details?.chainKey;
        alertOperator("swap_error", {
          tool: name,
          code: failure.code,
          reason,
          chainKey: typeof chainKey === "string" ? chainKey : undefined,
        });
      }
      const out = { error: { ...failure.details, code: failure.code, message: failure.message } };
      const nextStep =
        retryAdvice && RETRYABLE_CODES.includes(failure.code)
          ? retryAdvice(Number(failure.details?.retryAfterSec ?? DEFAULT_RETRY_AFTER_SEC))
          : failure.nextStep;
      return toResult({ status: "error", ...out, nextStep }, true);
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
