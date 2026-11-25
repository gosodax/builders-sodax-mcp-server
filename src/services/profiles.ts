/**
 * Tool profiles: which toolsets a connection gets (see `describeProfiles`).
 *
 * Pure: callers read the request, argv and env and pass the values in.
 */

import { parseArgs } from "node:util";
import { GET_A_KEY } from "../constants.js";
import { MAX_API_KEY_LENGTH, parseApiKey } from "./requestContext.js";

const PROFILES = ["builder", "swap", "bridge", "all"] as const;
type Profile = (typeof PROFILES)[number];

export interface Toolsets {
  builder: boolean;
  swap: boolean;
  bridge: boolean;
}

/** The toolsets a connection gets, plus a line for the agent when its key was dropped or would add keyed tools. */
export interface ToolSelection extends Toolsets {
  keyHint?: string;
}

/** What each profile serves. The two flags are the server's kill switches for the swap and the bridge tools. */
export function describeProfiles(swapToolsEnabled: boolean, bridgeToolsEnabled = false): Record<Profile, string> {
  const keyed = [swapToolsEnabled && "swap", bridgeToolsEnabled && "bridge"].filter(Boolean).join(" and ");
  const served = swapToolsEnabled ? "builder, swap and bridge" : "builder and bridge";
  return {
    builder: "Data, relay and SDK docs tools",
    swap: swapToolsEnabled ? "Swap tools; needs an x-api-key header" : "Turned off on this server",
    bridge: bridgeToolsEnabled ? "Bridge tools; needs an x-api-key header" : "Turned off on this server",
    all: !bridgeToolsEnabled
      ? swapToolsEnabled
        ? "Both; the swap tools only with an x-api-key header"
        : "The builder tools; the swap tools are turned off on this server"
      : `The ${served} tools; the ${keyed} tools only with an x-api-key header`,
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
 * `code` names the refusal on the request's log record.
 */
export class ConnectionError extends Error {
  readonly rpcCode: -32602 | -32000;

  constructor(
    readonly httpStatus: 400 | 403,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ConnectionError";
    this.rpcCode = httpStatus === 400 ? -32602 : -32000;
  }
}

/** `SODAX_SWAP_TOOLS_ENABLED`, a kill switch: unset, empty or `true` serves the swap tools; `false` turns them off. */
export function parseSwapToolsEnabled(value: string | undefined): boolean {
  return parseFlag("SODAX_SWAP_TOOLS_ENABLED", value, true);
}

/** `SODAX_BRIDGE_TOOLS_ENABLED`, a kill switch off by default: only `true` serves the bridge tools. */
export function parseBridgeToolsEnabled(value: string | undefined): boolean {
  return parseFlag("SODAX_BRIDGE_TOOLS_ENABLED", value, false);
}

function parseFlag(name: string, value: string | undefined, unset: boolean): boolean {
  const flag = value?.trim().toLowerCase() || String(unset);
  if (flag === "true" || flag === "false") return flag === "true";
  throw new Error(`${name} must be "true" or "false"`);
}

// What's wrong with the caller's key and how to fix it. The value is never echoed.
const SEND_A_KEY = `Send it in the x-api-key header (SODAX_API_KEY on stdio). ${GET_A_KEY}`;
const NOT_A_SODAX_KEY = `The x-api-key value (SODAX_API_KEY on stdio) isn't a SODAX API key (a sodax_… key alone, at most ${MAX_API_KEY_LENGTH} characters)`;
const KEY_DROPPED = `${NOT_A_SODAX_KEY}, so calls go out without one. ${GET_A_KEY}`;

interface SelectOptions {
  apiKey: ApiKeyStatus;
  swapToolsEnabled: boolean;
  bridgeToolsEnabled?: boolean;
}

/** The profiles that need a key, and whether this server serves them. */
const keyedOn = (profile: "swap" | "bridge", opts: SelectOptions) =>
  profile === "swap" ? opts.swapToolsEnabled : opts.bridgeToolsEnabled === true;

/** The profile a connection asked for, "all" when it named none; undefined for one that isn't a profile. */
export function parseProfile(requested: unknown): Profile | undefined {
  if (requested === undefined) return "all";
  if (typeof requested !== "string") return undefined; // e.g. a repeated ?profile=
  const profile = requested.trim().toLowerCase();
  return PROFILES.find(known => known === profile);
}

export function selectToolsets(requested: unknown, opts: SelectOptions): ToolSelection {
  const profile = parseProfile(requested);
  if (!profile) {
    const enabled = PROFILES.filter(known => (known !== "swap" && known !== "bridge") || keyedOn(known, opts));
    // The requested value isn't echoed back: it's caller input of any size.
    throw new ConnectionError(400, "UNKNOWN_PROFILE", `Unknown profile. Use ${enabled.join(", ")}.`);
  }
  if ((profile === "swap" || profile === "bridge") && !keyedOn(profile, opts)) {
    throw new ConnectionError(
      400,
      `${profile.toUpperCase()}_PROFILE_OFF`,
      `The ${profile} profile is turned off on this server. Use builder or all.`,
    );
  }
  if ((profile === "swap" || profile === "bridge") && opts.apiKey === "missing") {
    throw new ConnectionError(403, "API_KEY_REQUIRED", `API key required for the ${profile} profile. ${SEND_A_KEY}`);
  }
  if ((profile === "swap" || profile === "bridge") && opts.apiKey === "malformed") {
    throw new ConnectionError(
      403,
      "API_KEY_MALFORMED",
      `A SODAX API key is required for the ${profile} profile. ${NOT_A_SODAX_KEY}. ${GET_A_KEY}`,
    );
  }
  const keyed = (toolset: "swap" | "bridge") =>
    (profile === toolset || profile === "all") && keyedOn(toolset, opts) && opts.apiKey === "valid";
  const toolsets = {
    builder: profile === "builder" || profile === "all",
    swap: keyed("swap"),
    bridge: keyed("bridge"),
  };
  const keyHint = keyHintFor(profile, opts);
  return keyHint ? { ...toolsets, keyHint } : toolsets;
}

/** The agent can't see either otherwise: a keyless `all` has keyed tools to unlock, a malformed key is dropped. */
function keyHintFor(profile: Profile, opts: SelectOptions): string | undefined {
  const keyFix = opts.apiKey === "malformed" ? KEY_DROPPED : SEND_A_KEY;
  const locked = (["swap", "bridge"] as const).filter(toolset => keyedOn(toolset, opts)).join(" or ");
  if (profile === "all" && locked && opts.apiKey !== "valid") {
    return `This connection has no ${locked} tools: they need a SODAX API key. ${keyFix}`;
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
