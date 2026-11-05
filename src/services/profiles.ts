/**
 * Tool profiles: which toolsets a connection gets (see `describeProfiles`).
 *
 * Pure: callers read the request, argv and env and pass the values in.
 */

import { parseArgs } from "node:util";
import { API_KEYS_DOCS_URL } from "../constants.js";
import { MAX_API_KEY_LENGTH, parseApiKey } from "./requestContext.js";

const PROFILES = ["builder", "swap", "all"] as const;
type Profile = (typeof PROFILES)[number];

export interface Toolsets {
  builder: boolean;
  swap: boolean;
}

/** The toolsets a connection gets, plus a line for the agent when its key was dropped or would add the swap tools. */
export interface ToolSelection extends Toolsets {
  keyHint?: string;
}

/** What each profile serves. `swapToolsEnabled` is the server's rollout switch. */
export function describeProfiles(swapToolsEnabled: boolean): Record<Profile, string> {
  return {
    builder: "Data, relay and SDK docs tools",
    swap: swapToolsEnabled ? "Swap tools; needs an x-api-key header" : "Not enabled on this server yet",
    all: swapToolsEnabled
      ? "Both; the swap tools only with an x-api-key header"
      : "The builder tools; swap tools aren't enabled yet",
  };
}

/** The caller's key as the swap gate sees it: a SODAX key, a value that isn't one, or none (blank counts as none). */
export type ApiKeyStatus = "valid" | "malformed" | "missing";

export function apiKeyStatus(raw: string | undefined): ApiKeyStatus {
  if (parseApiKey(raw)) return "valid";
  return raw?.trim() ? "malformed" : "missing";
}

/**
 * A connection setting the server refuses. Sent as a JSON-RPC error before any server is built:
 * 400 is invalid params (-32602), 403 the generic server error (-32000) the MCP SDK uses for its own 403s.
 */
export class ConnectionError extends Error {
  readonly rpcCode: -32602 | -32000;

  constructor(
    readonly httpStatus: 400 | 403,
    message: string,
  ) {
    super(message);
    this.name = "ConnectionError";
    this.rpcCode = httpStatus === 400 ? -32602 : -32000;
  }
}

/** `SODAX_SWAP_TOOLS_ENABLED`: `true` turns the swap tools on; unset, empty or `false` keeps them off. */
export function parseSwapToolsEnabled(value: string | undefined): boolean {
  const flag = value?.trim().toLowerCase() || "false";
  if (flag === "true" || flag === "false") return flag === "true";
  throw new Error('SODAX_SWAP_TOOLS_ENABLED must be "true" or "false"');
}

// What's wrong with the caller's key and how to fix it. The value is never echoed.
const SEND_A_KEY = `Send it in the x-api-key header (SODAX_API_KEY on stdio): ${API_KEYS_DOCS_URL}`;
const NOT_A_SODAX_KEY = `The x-api-key value (SODAX_API_KEY on stdio) isn't a SODAX API key (a sodax_… key alone, at most ${MAX_API_KEY_LENGTH} characters)`;
const KEY_DROPPED = `${NOT_A_SODAX_KEY}, so calls go out without one: ${API_KEYS_DOCS_URL}`;

interface SelectOptions {
  apiKey: ApiKeyStatus;
  swapToolsEnabled: boolean;
}

function parseProfile(requested: unknown): Profile | undefined {
  if (requested === undefined) return "all";
  if (typeof requested !== "string") return undefined; // e.g. a repeated ?profile=
  const profile = requested.trim().toLowerCase();
  return PROFILES.find(known => known === profile);
}

export function selectToolsets(requested: unknown, opts: SelectOptions): ToolSelection {
  const profile = parseProfile(requested);
  if (!profile) {
    const enabled = PROFILES.filter(known => known !== "swap" || opts.swapToolsEnabled);
    // The requested value isn't echoed back: it's caller input of any size.
    throw new ConnectionError(400, `Unknown profile. Use ${enabled.join(", ")}.`);
  }
  if (profile === "swap" && !opts.swapToolsEnabled) {
    throw new ConnectionError(400, "The swap profile is not enabled on this server yet. Use builder or all.");
  }
  if (profile === "swap" && opts.apiKey === "missing") {
    throw new ConnectionError(403, `API key required for the swap profile. ${SEND_A_KEY}`);
  }
  if (profile === "swap" && opts.apiKey === "malformed") {
    throw new ConnectionError(
      403,
      `A SODAX API key is required for the swap profile. ${NOT_A_SODAX_KEY}: ${API_KEYS_DOCS_URL}`,
    );
  }
  const toolsets = {
    builder: profile !== "swap",
    swap: profile !== "builder" && opts.swapToolsEnabled && opts.apiKey === "valid",
  };
  const keyHint = keyHintFor(profile, opts);
  return keyHint ? { ...toolsets, keyHint } : toolsets;
}

/** The agent can't see either otherwise: a keyless `all` has swap tools to unlock, a malformed key is dropped. */
function keyHintFor(profile: Profile, opts: SelectOptions): string | undefined {
  const keyFix = opts.apiKey === "malformed" ? KEY_DROPPED : SEND_A_KEY;
  if (profile === "all" && opts.swapToolsEnabled && opts.apiKey !== "valid") {
    return `This connection has no swap tools: they need a SODAX API key. ${keyFix}`;
  }
  return opts.apiKey === "malformed" ? KEY_DROPPED : undefined;
}

/** A connection parameter is set unless it is absent or a blank string. */
export function isSet(value: unknown): boolean {
  return typeof value === "string" ? value.trim() !== "" : value !== undefined;
}

/** The first value that is set, so a blank `?profile=` can't override the header. */
function firstSet(...values: unknown[]): unknown {
  return values.find(isSet);
}

/** HTTP: `?profile=` wins over the `x-sodax-profile` header, since URL-only clients can only set the query. */
export function profileFromRequest(req: {
  query: { profile?: unknown };
  get(header: string): string | undefined;
}): unknown {
  return firstSet(req.query.profile, req.get("x-sodax-profile"));
}

/** stdio: `--profile` wins over `MCP_PROFILE`. Other arguments are ignored, never fatal. */
export function profileFromArgs(argv: string[], env: NodeJS.ProcessEnv): unknown {
  const { values } = parseArgs({
    args: argv,
    options: { profile: { type: "string" } },
    strict: false,
    allowPositionals: true,
  });
  return firstSet(values.profile, env.MCP_PROFILE);
}
