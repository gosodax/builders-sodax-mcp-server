/**
 * The template every swap tool shares: zod input (the SDK validates it before
 * the handler runs), structured output with a `status` and its decision (`nextAction`,
 * `terminal`, `outcome`, and the `nextStep` sentence that says the same), and failures
 * returned as `{ status: "error", error: { code, message }, ...decision }` with `isError`.
 * Failures are returned, never thrown, so no caller input reaches analytics (which
 * records a thrown error's message). Every result carries the call's `requestId`, the
 * `request.id` of its log records, for the user to quote when asking for help.
 */

import type { McpServer, ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ShapeOutput, ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { SWAP_HELP } from "../constants.js";
import { getRequestContext } from "../services/requestContext.js";
import { alertOperator } from "../services/swap/alerts.js";
import { ALERTED_CODES, ActionError } from "../services/swap/errors.js";
import { screenSecrets } from "../services/swap/secrets.js";
import { markFailure } from "../services/toolFailure.js";
import { registerAppTool } from "../services/toolRegistry.js";
import { type Decision, OUTCOMES, type SwapToolName } from "./nextAction.js";
import { errorDecision } from "./swapDecisions.js";

type ActionOutput = Record<string, unknown> & { status: string } & Decision;

/**
 * Every result's contract, errors included, and nothing more: each object passes other fields through, so a new
 * field can't fail the SDK's output check (which replaces the whole result), and the action types' shapes stay in
 * the tests and the README instead of every client's `tools/list`.
 */
const ACTION_OUTPUT = z
  .object({
    status: z.string(),
    nextAction: z.object({ type: z.string() }).passthrough(),
    terminal: z.boolean(),
    outcome: z.enum(OUTCOMES).optional(),
    nextStep: z.string(),
  })
  .passthrough();

export function registerActionTool<Args extends ZodRawShapeCompat>(
  server: McpServer,
  name: SwapToolName,
  description: string,
  input: Args,
  annotations: ToolAnnotations,
  run: (args: ShapeOutput<Args>) => Promise<ActionOutput>,
): void {
  /** A failure as the tool returns it; `bug` (what was thrown) also makes its "Tool call" record the error. */
  const failed = (failure: ActionError, args: ShapeOutput<Args>, bug?: unknown): CallToolResult => {
    if (ALERTED_CODES.includes(failure.code)) {
      // ActionError messages here are fixed text; an unexpected error is named by its class only.
      const reason =
        bug === undefined || bug instanceof ActionError
          ? failure.message
          : bug instanceof Error
            ? bug.name
            : typeof bug;
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
    const decision = errorDecision(failure, { tool: name, args });
    const result = toResult({ status: "error", ...out, ...decision }, true);
    // A bug's "Tool call" record is the error, with its class and stack (never its message: SDK and viem errors can
    // carry what the agent sent).
    return bug === undefined ? result : markFailure(result, { code: failure.code, thrown: bug });
  };

  const handler = async (args: ShapeOutput<Args>): Promise<CallToolResult> => {
    let output: ActionOutput;
    try {
      // After the SDK's zod check, before the handler's own validation, an upstream call or a log.
      screenSecrets(args);
      output = await run(args);
    } catch (error) {
      if (error instanceof ActionError) return failed(error, args);
      return failed(new ActionError("INTERNAL", "The tool failed unexpectedly."), args, error);
    }
    // Checked before the SDK would swap it for text: a result outside the contract, or one JSON can't carry (a
    // bigint, say), is a bug, recorded as one.
    const broken = (thrown?: unknown) => {
      const bug = new ActionError("INTERNAL", "This server built a result outside its contract.", {
        // The same call builds it the same way, and a prepare holds a quote each time.
        retryable: false,
        nextStep: `Tell the user this server can't answer that call right now, and not to repeat it. ${SWAP_HELP}`,
        details: { reason: "output_contract" },
      });
      return failed(bug, args, thrown ?? bug);
    };
    if (!ACTION_OUTPUT.safeParse(output).success) return broken();
    try {
      return toResult(output);
    } catch (error) {
      return broken(error);
    }
  };
  // ToolCallback<Args> is a conditional type TypeScript can't narrow while Args is generic;
  // for a zod shape it is exactly (args: ShapeOutput<Args>, extra) => CallToolResult.
  registerAppTool(
    server,
    "swap",
    name,
    description,
    input,
    annotations,
    handler as unknown as ToolCallback<Args>,
    ACTION_OUTPUT,
  );
}

/** The output as structured content and, for clients that pass only `content` on, as compact JSON text. */
function toResult(output: ActionOutput, isError = false): CallToolResult {
  const { requestId } = getRequestContext();
  const out = requestId ? { ...output, requestId } : output;
  return {
    content: [{ type: "text", text: JSON.stringify(out) }],
    structuredContent: out,
    ...(isError && { isError }),
  };
}
