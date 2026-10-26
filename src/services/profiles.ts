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

export const PROFILES = ["builder", "swap", "all"] as const;
type Profile = (typeof PROFILES)[number];

export interface Toolsets {
  builder: boolean;
  swap: boolean;
}

/** A connection setting the server refuses. Sent as a JSON-RPC error before any server is built. */
export class ConnectionError extends Error {
  constructor(
    readonly httpStatus: 400 | 403,
    readonly rpcCode: -32602 | -32000,
    message: string,
  ) {
    super(message);
    this.name = "ConnectionError";
  }
}

const API_KEYS_DOCS_URL = "https://docs.sodax.com/developers/how-to/api-keys";

/** `SODAX_SWAP_TOOLS_ENABLED`: `true` turns the swap tools on; unset, empty or `false` keeps them off. */
export function parseSwapToolsEnabled(value: string | undefined): boolean {
  const flag = value?.trim().toLowerCase() || "false";
  if (flag === "true" || flag === "false") return flag === "true";
  throw new Error('SODAX_SWAP_TOOLS_ENABLED must be "true" or "false"');
}

function parseProfile(requested: unknown): Profile | undefined {
  if (requested === undefined) return "all";
  if (typeof requested !== "string") return undefined; // e.g. a repeated ?profile=
  const profile = requested.trim().toLowerCase() || "all";
  return PROFILES.find(known => known === profile);
}

export function selectToolsets(requested: unknown, opts: { hasApiKey: boolean; swapToolsEnabled: boolean }): Toolsets {
  const profile = parseProfile(requested);
  // The requested value isn't echoed back: it's caller input of any size.
  if (!profile) throw new ConnectionError(400, -32602, `Unknown profile. Use ${PROFILES.join(", ")}.`);
  if (profile === "swap" && !opts.swapToolsEnabled) {
    throw new ConnectionError(400, -32602, "The swap profile is not enabled on this server yet. Use builder or all.");
  }
  if (profile === "swap" && !opts.hasApiKey) {
    throw new ConnectionError(
      403,
      -32000,
      `API key required for the swap profile. Send it in the x-api-key header (SODAX_API_KEY on stdio): ${API_KEYS_DOCS_URL}`,
    );
  }
  return {
    builder: profile !== "swap",
    swap: profile !== "builder" && opts.swapToolsEnabled && opts.hasApiKey,
  };
}

/** HTTP: `?profile=` wins over the `x-sodax-profile` header, since URL-only clients can only set the query. */
export function profileFromRequest(req: {
  query: { profile?: unknown };
  get(header: string): string | undefined;
}): unknown {
  return req.query.profile ?? req.get("x-sodax-profile");
}

/** stdio: `--profile` wins over `MCP_PROFILE`. Other arguments are ignored, never fatal. */
export function profileFromArgs(argv: string[], env: NodeJS.ProcessEnv): unknown {
  const { values } = parseArgs({
    args: argv,
    options: { profile: { type: "string" } },
    strict: false,
    allowPositionals: true,
  });
  return values.profile ?? env.MCP_PROFILE;
}
