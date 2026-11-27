/**
 * Tool profiles: which toolsets a connection gets (see `describeProfiles`).
 *
 * Pure: callers read the request, argv and env and pass the values in.
 */

import { parseArgs } from "node:util";
import { GET_A_KEY } from "../constants.js";
import type { KeyRefusal } from "./apiKeyVerification.js";
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

/** What each profile serves. `swapToolsEnabled` is the server's kill switch for the swap tools. */
export function describeProfiles(swapToolsEnabled: boolean): Record<Profile, string> {
  return {
    builder: "Data, relay and SDK docs tools",
    swap: swapToolsEnabled ? "Swap tools; needs an x-api-key header" : "Turned off on this server",
    all: swapToolsEnabled
      ? "Both; the swap tools only with an x-api-key header"
      : "The builder tools; the swap tools are turned off on this server",
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
 * 400 is invalid params (-32602); 403 and 503 the generic server error (-32000) the MCP SDK uses for its own
 * 403s. Never 401: an MCP client with OAuth support answers a 401 by starting its OAuth flow, so the agent would
 * never see the message. `code` names the refusal on the request's log record.
 */
export class ConnectionError extends Error {
  readonly rpcCode: -32602 | -32000;

  constructor(
    readonly httpStatus: 400 | 403 | 503,
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
  const flag = value?.trim().toLowerCase() || "true";
  if (flag === "true" || flag === "false") return flag === "true";
  throw new Error('SODAX_SWAP_TOOLS_ENABLED must be "true" or "false"');
}

// What's wrong with the caller's key and how to fix it. The value is never echoed.
const SEND_A_KEY = `Send it in the x-api-key header (SODAX_API_KEY on stdio). ${GET_A_KEY}`;
const NOT_A_SODAX_KEY = `The x-api-key value (SODAX_API_KEY on stdio) isn't a SODAX API key (a sodax_… key alone, at most ${MAX_API_KEY_LENGTH} characters)`;
const KEY_DROPPED = `${NOT_A_SODAX_KEY}, so calls go out without one. ${GET_A_KEY}`;

// Why the keyset refused a key, for its refusal and for the `all` profile's hint. The key is never echoed.
const KEY_REFUSALS: Record<KeyRefusal, { httpStatus: 403 | 503; code: string; message: string }> = {
  unknown_key: {
    httpStatus: 403,
    code: "API_KEY_UNKNOWN",
    message: `The x-api-key isn't an active SODAX API key: it may be mistyped or revoked. ${GET_A_KEY}`,
  },
  suspended: {
    httpStatus: 403,
    code: "ORG_SUSPENDED",
    message: "The organisation this API key belongs to is suspended. Ask SODAX to reinstate it.",
  },
  insufficient_scope: {
    httpStatus: 403,
    code: "API_KEY_SCOPE",
    message: `This API key lacks the swaps:read and swaps:write scopes the swap tools need. ${GET_A_KEY}`,
  },
  snapshot_unavailable: {
    httpStatus: 503,
    code: "KEY_CHECK_UNAVAILABLE",
    message: "API key verification is temporarily unavailable. Reconnect in a minute; the key itself may be fine.",
  },
};

/** The refusal for a key the keyset failed, as the swap profile gets it. */
export function keyRefusalError(outcome: KeyRefusal): ConnectionError {
  const { httpStatus, code, message } = KEY_REFUSALS[outcome];
  return new ConnectionError(httpStatus, code, message);
}

interface SelectOptions {
  apiKey: ApiKeyStatus;
  swapToolsEnabled: boolean;
  /** Why `enforce` refuses this valid key (`checkKey` in connection.ts); none when it passes or keys aren't enforced. */
  keyRefused?: KeyRefusal;
}

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
    const enabled = PROFILES.filter(known => known !== "swap" || opts.swapToolsEnabled);
    // The requested value isn't echoed back: it's caller input of any size.
    throw new ConnectionError(400, "UNKNOWN_PROFILE", `Unknown profile. Use ${enabled.join(", ")}.`);
  }
  if (profile === "swap" && !opts.swapToolsEnabled) {
    throw new ConnectionError(
      400,
      "SWAP_PROFILE_OFF",
      "The swap profile is turned off on this server. Use builder or all.",
    );
  }
  if (profile === "swap" && opts.apiKey === "missing") {
    throw new ConnectionError(403, "API_KEY_REQUIRED", `API key required for the swap profile. ${SEND_A_KEY}`);
  }
  if (profile === "swap" && opts.apiKey === "malformed") {
    throw new ConnectionError(
      403,
      "API_KEY_MALFORMED",
      `A SODAX API key is required for the swap profile. ${NOT_A_SODAX_KEY}. ${GET_A_KEY}`,
    );
  }
  // After the refusals above: a profile or shape problem is the one to fix first.
  if (profile === "swap" && opts.keyRefused) throw keyRefusalError(opts.keyRefused);
  const toolsets = {
    builder: profile !== "swap",
    swap: profile !== "builder" && opts.swapToolsEnabled && opts.apiKey === "valid" && !opts.keyRefused,
  };
  const keyHint = keyHintFor(profile, opts);
  return keyHint ? { ...toolsets, keyHint } : toolsets;
}

/**
 * The agent can't see these otherwise: a keyless `all` has swap tools to unlock, a malformed key is dropped,
 * the keyset refused the key.
 */
function keyHintFor(profile: Profile, opts: SelectOptions): string | undefined {
  if (profile === "all" && opts.swapToolsEnabled) {
    if (opts.keyRefused) return `This connection has no swap tools. ${KEY_REFUSALS[opts.keyRefused].message}`;
    if (opts.apiKey !== "valid") {
      const keyFix = opts.apiKey === "malformed" ? KEY_DROPPED : SEND_A_KEY;
      return `This connection has no swap tools: they need a SODAX API key. ${keyFix}`;
    }
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
