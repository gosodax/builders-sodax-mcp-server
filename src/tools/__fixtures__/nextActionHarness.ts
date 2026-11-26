/** A scripted host shared by swap and bridge runtime tests. It refuses to read nextStep. */

import type { NextAction } from "../nextAction.js";
import { nextActionSchema } from "../nextActionSchema.js";
import type { Host, Saved, ToolResult } from "./nextActionRuntime.js";

type Args = Record<string, unknown>;
type Asked = Extract<NextAction, { type: "choose" | "provide" | "confirm" | "external" }>;

export interface Script {
  respond: (tool: string, args: Args, nth: number, now: number) => ToolResult | Promise<ToolResult>;
  answers?: { [Type in Asked["type"]]?: (action: Extract<Asked, { type: Type }>) => Args | boolean | undefined };
  wallet?: (
    action: Extract<NextAction, { type: "execute" }>,
    result: ToolResult,
  ) => { hash: string } | { batchId: string };
  batch?: (batchId: string) => string | undefined;
  /** Whether the wallet's record shows what a `by: "wallet"` confirm asks. */
  walletShows?: () => boolean;
  saved?: Saved;
}

// Far past any bound: a runtime that gets here never stops on its own.
const RUNAWAY = 200;

/** Fails the test if the runtime reads the sentence instead of the action. */
const actionOnly = (result: ToolResult) =>
  new Proxy(result, {
    get(target, field) {
      if (field === "nextStep") throw new Error("the runtime read nextStep");
      return Reflect.get(target, field);
    },
  });

export function harness(script: Script, startTime: number, defaultHash: string) {
  const calls: { tool: string; args: Args }[] = [];
  const asked: string[] = [];
  let sends = 0;
  let now = startTime;
  const host: Host = {
    async call(tool, args) {
      calls.push({ tool, args });
      if (calls.length > RUNAWAY) throw new Error("the runtime never stopped");
      const result = await script.respond(tool, args, calls.filter(made => made.tool === tool).length, now);
      // Every action a flow meets, errors from real throws included, is one the published schema types.
      const issues = result.nextAction && nextActionSchema.safeParse(result.nextAction).error?.issues;
      if (issues) throw new Error(`${tool} returned a nextAction off the schema: ${JSON.stringify(issues)}`);
      return actionOnly(result);
    },
    async sleep(seconds) {
      now += seconds * 1000;
    },
    now: () => now,
    async ask(action) {
      asked.push(action.type === "external" ? `external:${action.reason}` : action.type);
      const answer = script.answers?.[action.type] as ((asked: Asked) => Args | boolean | undefined) | undefined;
      return answer ? answer(action) : action.type === "external";
    },
    async send(action, result) {
      sends++;
      return script.wallet?.(action, result) ?? { hash: defaultHash };
    },
    async batchHash(batchId) {
      return script.batch?.(batchId);
    },
    async walletShows() {
      asked.push("wallet");
      return script.walletShows?.() ?? false;
    },
    saved: script.saved ?? {},
  };
  const of = (tool: string) => calls.filter(made => made.tool === tool);
  return { host, calls, asked, of, sends: () => sends, now: () => now };
}
