/**
 * `nextAction` in full, typed as the decisions build it: a schema that drifts from `NextAction` fails to compile, and
 * the decision tests check every decision against it. Served as the `sodax://next-action/schema` resource rather than
 * in each tool's output schema, where its ~15 KB a tool would weigh on every `tools/list`. Objects pass other fields
 * through, so a field added later can't fail the SDK's output check, which replaces the whole result. The rules for
 * running it are the `sodax://next-action` resource.
 */

import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";
import { z } from "zod";
import { BRIDGE_WARNINGS } from "../services/bridge/prepare.js";
import {
  type ConfirmSummary,
  EXTERNAL_REASONS,
  type Exhausted,
  type NextAction,
  OUTCOMES,
  QUOTE_WARNINGS,
  SWAP_TOOL_NAMES,
} from "./nextAction.js";

/** Where the server serves the contract, and this schema. */
export const NEXT_ACTION_URI = "sodax://next-action";
export const NEXT_ACTION_SCHEMA_URI = `${NEXT_ACTION_URI}/schema`;

const amount = z.object({ amount: z.string(), symbol: z.string(), chain: z.string() }).passthrough();
const fee = z.object({ amount: z.string(), symbol: z.string() }).passthrough();
const approve = z.object({ spender: z.string(), amount: z.string(), symbol: z.string() }).passthrough();

const summaryUnion = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("swap"),
      quoteId: z.string(),
      expiresAt: z.string(),
      send: amount,
      receiveAtLeast: amount,
      expected: fee,
      recipient: z.string(),
      partnerFee: fee.optional(),
      usdValue: z.string().nullable(),
      usdOut: z.string().nullable(),
      approve: approve.optional(),
      warnings: z.array(z.enum(QUOTE_WARNINGS)),
    })
    .passthrough(),
  z
    .object({
      kind: z.literal("bridge"),
      bridgeId: z.string(),
      expiresAt: z.string(),
      send: amount,
      receive: amount.describe("What the recipient gets: the amount sent, less the partner fee."),
      recipient: z.string(),
      partnerFee: fee.describe("In the token sent: 0 when the connection charges none."),
      approve: approve.optional(),
      warnings: z.array(z.enum(BRIDGE_WARNINGS)),
    })
    .passthrough(),
  z.object({ kind: z.literal("cancel"), chain: z.string(), txHash: z.string() }).passthrough(),
  z
    .object({ kind: z.literal("unsent_cancel"), chain: z.string(), txHash: z.string(), cancelTxHash: z.string() })
    .passthrough()
    .describe("The wallet shows this cancel can never land, before a new one replaces it."),
  z.object({ kind: z.literal("amount"), amount: z.string(), symbol: z.string() }).passthrough(),
]);
const summarySchema: z.ZodType<ConfirmSummary> = summaryUnion;

const exhaustedSchema: z.ZodType<Exhausted> = z.lazy(() =>
  z
    .object({ nextAction: nextActionSchema, terminal: z.boolean(), outcome: z.enum(OUTCOMES).optional() })
    .passthrough()
    .describe("What follows once a bounded call runs out, or a person declines."),
);

const callTool = z.object({
  type: z.literal("call_tool"),
  tool: z.enum(SWAP_TOOL_NAMES),
  args: z
    .record(z.unknown())
    .optional()
    .describe("The call's arguments: complete when the result found the swap or bridge."),
  sameArgs: z
    .literal(true)
    .optional()
    .describe("The arguments of the call that returned this action, with args and a person's answer on top."),
  afterSec: z.number().describe("Seconds to wait before calling."),
  until: z.string().optional().describe("ISO time: repeat while the result asks again until then."),
  maxAttempts: z.number().int().optional().describe("Repeat at most this many times, counted per retryKey."),
  retryKey: z.string().optional().describe("What the attempts are counted under, across the workflow."),
  consecutive: z.literal(true).optional().describe("Count only calls in a row: any other result starts again."),
  onExhausted: exhaustedSchema.optional(),
});

const optionSchema = z.object({ label: z.string(), args: z.record(z.string()) }).passthrough();

const actionUnion = () =>
  z.discriminatedUnion("type", [
    callTool.passthrough().describe("The agent calls a tool."),
    z
      .object({
        type: z.literal("choose"),
        field: z.string(),
        options: z.array(optionSchema).describe("Each option's args go into next's call."),
        next: nextActionSchema.optional(),
      })
      .passthrough()
      .describe("The user picks one option."),
    z
      .object({
        type: z.literal("provide"),
        fields: z.array(
          z.object({ name: z.string(), format: z.string().optional(), optional: z.literal(true).optional() }),
        ),
        next: nextActionSchema.optional(),
        onDecline: exhaustedSchema.optional(),
      })
      .passthrough()
      .describe("The user gives these values, by field name, for next's call."),
    z
      .object({
        type: z.literal("confirm"),
        summary: summarySchema,
        by: z.literal("wallet").optional().describe("Only the wallet's own record answers, never an agent's yes."),
        next: nextActionSchema,
      })
      .passthrough()
      .describe("The user agrees to summary before next."),
    z
      .object({
        type: z.literal("execute"),
        chain: z.string(),
        stepsAt: z.literal("steps"),
        batchAt: z.literal("batch").optional(),
        waitFor: z.literal("receipt_success"),
        expiresAt: z.string().optional().describe("Never start sending past this ISO time."),
        afterSend: callTool
          .extend({
            on: z.literal("broadcast"),
            needs: z.union([z.tuple([z.literal("txHash")]), z.tuple([z.literal("cancelTxHash")])]),
          })
          .passthrough()
          .describe("Made once the last step is broadcast, with its hash, whatever its receipt says."),
      })
      .passthrough()
      .describe("The wallet sends the result's steps (or its batch) in order, each receipt a success before the next."),
    z
      .object({
        type: z.literal("external"),
        reason: z.enum(EXTERNAL_REASONS),
        next: nextActionSchema.optional(),
        onDecline: exhaustedSchema.optional(),
      })
      .passthrough()
      .describe("A person acts outside these tools, then next; if they don't, onDecline."),
    z
      .object({ type: z.literal("none") })
      .passthrough()
      .describe("The workflow is over."),
  ]);

export const nextActionSchema: z.ZodType<NextAction> = z.lazy(actionUnion);

// A union missing a whole variant still assigns to the wider type: each kind or type the schema leaves out fails here.
type Uncovered<All extends string, Covered> = Record<Exclude<All, Covered>, never>;
const _everyKind: Uncovered<ConfirmSummary["kind"], z.infer<typeof summaryUnion>["kind"]> = {};
const _everyType: Uncovered<NextAction["type"], z.infer<ReturnType<typeof actionUnion>>["type"]> = {};

const ACTION_TYPE_SET: Record<NextAction["type"], true> = {
  call_tool: true,
  choose: true,
  provide: true,
  confirm: true,
  execute: true,
  external: true,
  none: true,
};
const ACTION_TYPES = Object.keys(ACTION_TYPE_SET) as [NextAction["type"], ...NextAction["type"][]];

/** What each tool's output schema states: the action's type, and where its full shape and rules are. */
export const nextActionField = z
  .object({ type: z.enum(ACTION_TYPES) })
  .passthrough()
  .describe(
    `What happens next, and who acts. Each type's fields: the ${NEXT_ACTION_SCHEMA_URI} resource; how to run it: ${NEXT_ACTION_URI}.`,
  );

/** The full schema as JSON Schema, of a result whose `nextAction` it types. */
export const NEXT_ACTION_JSON_SCHEMA = JSON.stringify(
  toJsonSchemaCompat(z.object({ nextAction: nextActionSchema })),
  null,
  2,
);
