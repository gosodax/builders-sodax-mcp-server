/**
 * Tool profiles: which toolsets a connection gets.
 *
 * - `builder`: the data, relay and docs tools.
 * - `swap`: the swap tools. Needs an API key, and the server's rollout switch.
 * - `all` (default): both; without a key, only the builder tools.
 *
 * Pure: callers read the request, argv and env and pass the values in.
 */

import { parseArgs } from "node:util";
import { parseApiKey } from "./requestContext.js";

const PROFILES = ["builder", "swap", "all"] as const;
type Profile = (typeof PROFILES)[number];

export interface Toolsets {
  builder: boolean;
  swap: boolean;
}

/** The toolsets a connection gets, plus a line for the agent when the swap tools only wait for a usable key. */
export interface ToolSelection extends Toolsets {
  swapKeyHint?: string;
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

const API_KEYS_DOCS_URL = "https://docs.sodax.com/developers/how-to/api-keys";

/** `SODAX_SWAP_TOOLS_ENABLED`: `true` turns the swap tools on; unset, empty or `false` keeps them off. */
export function parseSwapToolsEnabled(value: string | undefined): boolean {
  const flag = value?.trim().toLowerCase() || "false";
  if (flag === "true" || flag === "false") return flag === "true";
  throw new Error('SODAX_SWAP_TOOLS_ENABLED must be "true" or "false"');
}

/** What's wrong with the caller's key and how to fix it. The value is never echoed. */
function keyFix(apiKey: "malformed" | "missing"): string {
  return apiKey === "malformed"
    ? `The x-api-key value (SODAX_API_KEY on stdio) isn't a SODAX API key (expected sodax_… alone): ${API_KEYS_DOCS_URL}`
    : `Send it in the x-api-key header (SODAX_API_KEY on stdio): ${API_KEYS_DOCS_URL}`;
}

function parseProfile(requested: unknown): Profile | undefined {
  if (requested === undefined) return "all";
  if (typeof requested !== "string") return undefined; // e.g. a repeated ?profile=
  const profile = requested.trim().toLowerCase();
  return PROFILES.find(known => known === profile);
}

export function selectToolsets(
  requested: unknown,
  opts: { apiKey: ApiKeyStatus; swapToolsEnabled: boolean },
): ToolSelection {
  const profile = parseProfile(requested);
  if (!profile) {
    const enabled = PROFILES.filter(known => known !== "swap" || opts.swapToolsEnabled);
    // The requested value isn't echoed back: it's caller input of any size.
    throw new ConnectionError(400, `Unknown profile. Use ${enabled.join(", ")}.`);
  }
  if (profile === "swap" && !opts.swapToolsEnabled) {
    throw new ConnectionError(400, "The swap profile is not enabled on this server yet. Use builder or all.");
  }
  if (profile === "swap" && opts.apiKey !== "valid") {
    throw new ConnectionError(403, `API key required for the swap profile. ${keyFix(opts.apiKey)}`);
  }
  const toolsets = {
    builder: profile !== "swap",
    swap: profile !== "builder" && opts.swapToolsEnabled && opts.apiKey === "valid",
  };
  // Otherwise a keyless `all` connection can't tell the swap tools exist.
  if (profile === "all" && opts.swapToolsEnabled && opts.apiKey !== "valid") {
    return {
      ...toolsets,
      swapKeyHint: `This connection has no swap tools: they need a SODAX API key. ${keyFix(opts.apiKey)}`,
    };
  }
  return toolsets;
}

/** The first value that is set. A blank string counts as unset, so `?profile=` can't override the header. */
function firstSet(...values: unknown[]): unknown {
  return values.find(value => (typeof value === "string" ? value.trim() !== "" : value !== undefined));
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
