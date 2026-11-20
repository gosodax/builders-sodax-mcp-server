/** The contract every swap tool decision keeps, as a list of what breaks it, for tests to assert empty. */

import type { CallTool, Decision, NextAction } from "../nextAction.js";

/** Every way `decision` breaks the contract; empty when it keeps it. */
export function contractBreaks(decision: Decision): string[] {
  const breaks: string[] = [];
  const { nextAction, terminal, outcome } = decision;
  if (nextAction.type === "none" && !terminal) breaks.push("none must be terminal");
  if (terminal && nextAction.type !== "none" && nextAction.type !== "external") {
    breaks.push(`terminal with a ${nextAction.type}`);
  }
  if (outcome && !terminal) breaks.push("an outcome on a result that isn't terminal");
  if (!decision.nextStep) breaks.push("no nextStep");
  for (const action of actionsOf(nextAction)) breaks.push(...actionBreaks(action));
  return breaks;
}

function actionBreaks(action: NextAction): string[] {
  switch (action.type) {
    case "call_tool":
      return callBreaks(action);
    case "choose":
      return action.options.length === 0 || action.options.some(option => Object.keys(option.args).length === 0)
        ? ["a choose needs options, each setting args"]
        : [];
    case "provide":
      return action.fields.length === 0 ? ["a provide needs fields"] : [];
    case "execute":
      return action.afterSend.on === "broadcast" ? [] : ["afterSend must run on broadcast"];
    case "confirm":
    case "external":
    case "none":
      return [];
  }
}

function callBreaks(call: CallTool): string[] {
  const breaks: string[] = [];
  if (call.until !== undefined && call.maxAttempts !== undefined) breaks.push("both until and maxAttempts");
  if (call.maxAttempts !== undefined && !call.retryKey) breaks.push("maxAttempts without a retryKey");
  if ((call.until !== undefined || call.maxAttempts !== undefined) && !call.onExhausted) {
    breaks.push("a bounded call without onExhausted");
  }
  if (!call.sameArgs && !call.args) breaks.push("a call with no arguments");
  return breaks;
}

/** A call at the top of a decision, made without a person or a bound in between. */
export function unboundedTopCall(decision: Decision): CallTool | undefined {
  const { nextAction } = decision;
  if (nextAction.type !== "call_tool") return undefined;
  return nextAction.until === undefined && nextAction.maxAttempts === undefined ? nextAction : undefined;
}

/** Every action a decision holds, nested ones included. */
export function actionsOf(action: NextAction): NextAction[] {
  const nested: NextAction[] = [];
  if ("next" in action && action.next) nested.push(action.next);
  if ("onExhausted" in action && action.onExhausted) nested.push(action.onExhausted.nextAction);
  if ("onDecline" in action && action.onDecline) nested.push(action.onDecline.nextAction);
  if (action.type === "execute") nested.push(action.afterSend);
  return [action, ...nested.flatMap(actionsOf)];
}
