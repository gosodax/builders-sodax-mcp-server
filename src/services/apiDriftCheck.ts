/**
 * API Drift Check
 *
 * Fetches the live OpenAPI spec from the SODAX API at startup (and on demand
 * via `pnpm check:drift`) and compares it to what each MCP tool claims to
 * expose. Four sub-checks run:
 *
 *   1. Endpoint coverage   — every spec path has a registered tool
 *   2. Param drift         — spec's query + path params match the tool's
 *   3. Required-flag drift — spec's required params match the tool's
 *   4. Response-field drift — spec's 200 response fields match the tool's
 *                             frozen contract (only for endpoints whose
 *                             service returns a typed shape)
 *
 * The CLI entrypoint (`src/scripts/checkDrift.ts`) exits non-zero on drift;
 * the startup call in `src/index.ts` is fire-and-forget and never throws.
 */

import { SODAX_API_BASE_URL } from "../constants.js";
import { fetchJson } from "./http.js";

type EndpointKey = string; // e.g. "GET /solver/orderbook"

interface ToolContract {
  tool: string;
  /** Query + path param names declared by the tool (excl. MCP-only `format`). */
  params: string[];
  /** Subset of `params` the tool marks non-optional. */
  requiredParams: string[];
  /**
   * Params the tool accepts that are NOT query/path params on THIS endpoint —
   * used when a single tool wraps multiple endpoint variants and the extra
   * param is a routing switch between them. Suppresses the "tool declares
   * param X not in spec" warning for the listed names on this endpoint only.
   */
  allowToolExtra?: string[];
  /**
   * Expected top-level property names in the 200 response schema.
   * Omit when the endpoint returns a primitive, a dynamic map, or when the
   * spec provides no object schema — those are reported as "uncovered".
   */
  responseFields?: string[];
}

/**
 * Known API paths that are intentionally NOT exposed as MCP tools.
 * Add paths here with a reason to suppress drift warnings.
 */
const IGNORED_PATHS: Record<EndpointKey, string> = {
  // No ignored paths yet — all API endpoints should be exposed.
};

/**
 * The drift-check contract: what each endpoint's corresponding MCP tool
 * currently exposes. Seeded from the tool's Zod schema (params + required)
 * and the spec as of first-write (responseFields). When upstream drifts,
 * the check flags the diff so a human updates either the tool or this map.
 */
const TOOL_CONTRACT: Record<EndpointKey, ToolContract> = {
  "GET /config/all": {
    tool: "sodax_get_all_config",
    params: [],
    requiredParams: [],
  },
  "GET /config/relay/chain-id-map": {
    tool: "sodax_get_relay_chain_id_map",
    params: [],
    requiredParams: [],
  },
  "GET /config/spoke/chains": {
    tool: "sodax_get_supported_chains",
    params: [],
    requiredParams: [],
  },
  "GET /config/spoke/all-chains-configs": {
    tool: "sodax_get_all_chains_configs",
    params: [],
    requiredParams: [],
  },
  "GET /config/hub/assets": {
    tool: "sodax_get_hub_assets",
    params: ["chainId"],
    requiredParams: [],
    allowToolExtra: ["chainId"],
  },
  "GET /config/hub/:chainId/assets": {
    tool: "sodax_get_hub_assets",
    params: ["chainId"],
    requiredParams: ["chainId"],
  },
  "GET /config/swap/tokens": {
    tool: "sodax_get_swap_tokens",
    params: ["chainId"],
    requiredParams: [],
    allowToolExtra: ["chainId"],
  },
  "GET /config/swap/:chainId/tokens": {
    tool: "sodax_get_swap_tokens",
    params: ["chainId"],
    requiredParams: ["chainId"],
    responseFields: ["symbol", "name", "address", "decimals"],
  },
  "GET /config/money-market/tokens": {
    tool: "sodax_get_money_market_tokens",
    params: ["chainId"],
    requiredParams: [],
    allowToolExtra: ["chainId"],
  },
  "GET /config/money-market/reserve-assets": {
    tool: "sodax_get_money_market_reserve_assets",
    params: [],
    requiredParams: [],
  },
  "GET /config/money-market/:chainId/tokens": {
    tool: "sodax_get_money_market_tokens",
    params: ["chainId"],
    requiredParams: ["chainId"],
    responseFields: ["symbol", "name", "address", "decimals"],
  },
  "GET /amm/nft-positions": {
    tool: "sodax_get_amm_positions",
    params: ["owner", "offset", "limit"],
    requiredParams: [],
    responseFields: ["items", "pagination"],
  },
  "GET /amm/pools/:chainId/:poolId/candles": {
    tool: "sodax_get_amm_pool_candles",
    params: ["chainId", "poolId", "interval", "from", "to"],
    requiredParams: ["chainId", "poolId", "interval", "from", "to"],
    responseFields: ["poolId", "chainId", "interval", "from", "to", "candles"],
  },
  "GET /intent/tx/:txHash": {
    tool: "sodax_get_transaction",
    params: ["txHash"],
    requiredParams: ["txHash"],
    responseFields: ["intentHash", "txHash", "logIndex", "chainId", "blockNumber", "open", "intent", "events"],
  },
  "GET /intent/user/:userAddress": {
    tool: "sodax_get_user_transactions",
    params: ["userAddress", "limit", "offset", "fromBlock", "toBlock"],
    requiredParams: ["userAddress"],
    responseFields: ["items", "total", "offset", "limit"],
  },
  "GET /intent/:intentHash": {
    tool: "sodax_get_intent",
    params: ["intentHash"],
    requiredParams: ["intentHash"],
    responseFields: ["intentHash", "txHash", "logIndex", "chainId", "blockNumber", "open", "intent", "events"],
  },
  "GET /solver/orderbook": {
    tool: "sodax_get_orderbook",
    params: ["limit", "offset"],
    requiredParams: ["limit", "offset"],
    responseFields: ["total", "data"],
  },
  "GET /solver/volume": {
    tool: "sodax_get_volume",
    params: ["inputToken", "outputToken", "chainId", "solver", "fromBlock", "toBlock", "since", "until", "fromTs", "toTs", "sort", "limit", "includeData", "cursor"],
    requiredParams: [],
    responseFields: ["items", "nextCursor", "hasMore"],
  },
  "GET /solver/intents/:intentHash": {
    tool: "sodax_get_solver_intent",
    params: ["intentHash", "includeAll"],
    requiredParams: ["intentHash"],
  },
  "GET /moneymarket/position/:userAddress": {
    tool: "sodax_get_user_position",
    params: ["userAddress"],
    requiredParams: ["userAddress"],
    responseFields: ["userAddress", "positions"],
  },
  "GET /moneymarket/asset/all": {
    tool: "sodax_get_money_market_assets",
    params: [],
    requiredParams: [],
    responseFields: ["reserveAddress", "aTokenAddress", "variableDebtTokenAddress", "totalATokenBalance", "totalVariableDebtTokenBalance", "totalBorrowers", "totalSuppliers", "liquidityRate", "variableBorrowRate", "stableBorrowRate", "liquidityIndex", "variableBorrowIndex", "blockNumber", "symbol"],
  },
  "GET /moneymarket/asset/:reserveAddress": {
    tool: "sodax_get_money_market_asset",
    params: ["reserveAddress"],
    requiredParams: ["reserveAddress"],
    responseFields: ["reserveAddress", "aTokenAddress", "variableDebtTokenAddress", "totalATokenBalance", "totalVariableDebtTokenBalance", "totalBorrowers", "totalSuppliers", "liquidityRate", "variableBorrowRate", "stableBorrowRate", "liquidityIndex", "variableBorrowIndex", "blockNumber", "symbol"],
  },
  "GET /moneymarket/asset/:reserveAddress/borrowers": {
    tool: "sodax_get_asset_borrowers",
    params: ["reserveAddress", "offset", "limit"],
    requiredParams: ["reserveAddress"],
    responseFields: ["borrowers", "total", "offset", "limit"],
  },
  "GET /moneymarket/asset/:reserveAddress/suppliers": {
    tool: "sodax_get_asset_suppliers",
    params: ["reserveAddress", "offset", "limit"],
    requiredParams: ["reserveAddress"],
    responseFields: ["suppliers", "total", "offset", "limit"],
  },
  "GET /moneymarket/borrowers": {
    tool: "sodax_get_all_borrowers",
    params: ["offset", "limit"],
    requiredParams: [],
    responseFields: ["borrowers", "total", "offset", "limit"],
  },
  "GET /partners": {
    tool: "sodax_get_partners",
    params: ["chainId"],
    requiredParams: [],
    responseFields: ["partners"],
  },
  "GET /partners/:receiver/summary": {
    tool: "sodax_get_partner_summary",
    params: ["receiver", "chainId"],
    requiredParams: ["receiver"],
    responseFields: ["receiver", "chainId", "feeByInputToken", "volumeByOutputToken"],
  },
  "GET /sodax/total_supply": {
    tool: "sodax_get_total_supply",
    params: [],
    requiredParams: [],
  },
  "GET /sodax/circulating_supply": {
    tool: "sodax_get_circulating_supply",
    params: [],
    requiredParams: [],
  },
  "GET /sodax/supply": {
    tool: "sodax_get_token_supply",
    params: [],
    requiredParams: [],
    responseFields: [],
  },
};

interface OpenApiParameter {
  name: string;
  in: "query" | "path" | "header" | "cookie";
  required?: boolean;
}

interface OpenApiSchema {
  $ref?: string;
  type?: string;
  properties?: Record<string, OpenApiSchema>;
  items?: OpenApiSchema;
  additionalProperties?: OpenApiSchema | boolean;
  allOf?: OpenApiSchema[];
}

interface OpenApiOperation {
  parameters?: OpenApiParameter[];
  responses?: {
    "200"?: {
      content?: {
        "application/json"?: {
          schema?: OpenApiSchema;
        };
      };
    };
  };
}

interface OpenApiSpec {
  paths: Record<string, Record<string, OpenApiOperation>>;
  components?: {
    schemas?: Record<string, OpenApiSchema>;
  };
}

interface DriftIssue {
  endpoint: EndpointKey;
  kind: "param-missing" | "param-extra" | "required-missing" | "required-extra" | "field-missing" | "field-extra";
  detail: string;
}

export interface DriftReport {
  hasDrift: boolean;
  summary: {
    totalEndpoints: number;
    endpointGaps: number;
    paramGaps: number;
    requiredGaps: number;
    fieldGaps: number;
    uncovered: number;
  };
}

/** Normalize an OpenAPI path with `{param}` placeholders to `:param` form. */
function normalizePath(path: string): string {
  return path.replace(/\{([^}]+)\}/g, ":$1");
}

/**
 * Resolve a response schema down to its top-level property names.
 *
 * Returns:
 *   - `{ kind: "object", fields: [...] }` for an object schema (inline or via $ref)
 *   - `{ kind: "object", fields: [...] }` for an array of objects (fields = item props)
 *   - `{ kind: "primitive" }` / `{ kind: "map" }` / `{ kind: "unknown" }` when
 *      drift can't be checked at the field level
 */
type ResolvedFields =
  | { kind: "object"; fields: string[] }
  | { kind: "primitive" }
  | { kind: "map" }
  | { kind: "unknown" };

function resolveResponseFields(
  schema: OpenApiSchema | undefined,
  components: Record<string, OpenApiSchema> | undefined,
  depth = 0
): ResolvedFields {
  if (!schema || depth > 4) return { kind: "unknown" };

  if (schema.$ref) {
    const refName = schema.$ref.replace("#/components/schemas/", "");
    const target = components?.[refName];
    return resolveResponseFields(target, components, depth + 1);
  }

  if (schema.properties) {
    return { kind: "object", fields: Object.keys(schema.properties) };
  }

  if (schema.type === "array" && schema.items) {
    return resolveResponseFields(schema.items, components, depth + 1);
  }

  if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
    return { kind: "map" };
  }

  if (schema.type === "object") {
    // Object declared but no properties listed.
    return { kind: "object", fields: [] };
  }

  if (schema.type) return { kind: "primitive" };

  return { kind: "unknown" };
}

function diff(expected: string[], actual: string[]): { missing: string[]; extra: string[] } {
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  return {
    missing: actual.filter(x => !expectedSet.has(x)), // in actual but not expected
    extra: expected.filter(x => !actualSet.has(x)),    // in expected but not actual
  };
}

/**
 * Run all drift sub-checks. Logs to stderr; returns a structured report
 * so callers (CLI vs. startup) can decide how to react.
 */
export async function checkApiDrift(): Promise<DriftReport> {
  const emptyReport: DriftReport = {
    hasDrift: false,
    summary: { totalEndpoints: 0, endpointGaps: 0, paramGaps: 0, requiredGaps: 0, fieldGaps: 0, uncovered: 0 },
  };

  let spec: OpenApiSpec;
  try {
    spec = await fetchJson<OpenApiSpec>(`${SODAX_API_BASE_URL}/docs-json`, { timeout: 10000 });
  } catch (error) {
    console.error("⚠️  API drift check: could not fetch OpenAPI spec —", error instanceof Error ? error.message : error);
    return emptyReport;
  }

  if (!spec?.paths) {
    console.error("⚠️  API drift check: could not parse OpenAPI spec");
    return emptyReport;
  }

  const components = spec.components?.schemas;

  // ── 1. Endpoint coverage ──────────────────────────────────────────────
  const endpointGaps: EndpointKey[] = [];
  const coveredKeys: EndpointKey[] = [];

  for (const [path, methods] of Object.entries(spec.paths)) {
    for (const method of Object.keys(methods)) {
      const key: EndpointKey = `${method.toUpperCase()} ${normalizePath(path)}`;
      if (IGNORED_PATHS[key]) continue;
      if (TOOL_CONTRACT[key]) coveredKeys.push(key);
      else endpointGaps.push(key);
    }
  }

  // ── 2 & 3. Param + required drift ─────────────────────────────────────
  const paramIssues: DriftIssue[] = [];
  const requiredIssues: DriftIssue[] = [];
  const fieldIssues: DriftIssue[] = [];
  const uncovered: EndpointKey[] = [];

  for (const key of coveredKeys) {
    const [method, path] = key.split(" ");
    const op = spec.paths[restoreOpenApiPath(path, spec.paths)]?.[method.toLowerCase()];
    if (!op) continue;

    const contract = TOOL_CONTRACT[key];
    const specParams = (op.parameters ?? []).filter(p => p.in === "query" || p.in === "path");
    const specParamNames = specParams.map(p => p.name);
    const specRequiredNames = specParams.filter(p => p.required === true).map(p => p.name);

    // Param drift: fields in spec but not in contract = tool missing params
    //              fields in contract but not in spec = tool has stale params
    const paramDiff = diff(contract.params, specParamNames);
    for (const name of paramDiff.missing) {
      paramIssues.push({
        endpoint: key,
        kind: "param-missing",
        detail: `spec has param "${name}" not in tool "${contract.tool}"`,
      });
    }
    const allowExtra = new Set(contract.allowToolExtra ?? []);
    for (const name of paramDiff.extra) {
      if (allowExtra.has(name)) continue;
      paramIssues.push({
        endpoint: key,
        kind: "param-extra",
        detail: `tool "${contract.tool}" declares param "${name}" not in spec`,
      });
    }

    // Required drift: only flag "spec requires X but tool doesn't" (the
    // stricter direction). The opposite — tool requires X but spec doesn't
    // — is a tool bug, so flag that too.
    const requiredDiff = diff(contract.requiredParams, specRequiredNames);
    for (const name of requiredDiff.missing) {
      // Only log as required-drift if the param itself exists on the tool —
      // otherwise the param-missing issue above already covers it.
      if (contract.params.includes(name)) {
        requiredIssues.push({
          endpoint: key,
          kind: "required-missing",
          detail: `spec requires "${name}" but tool "${contract.tool}" declares it optional`,
        });
      }
    }
    for (const name of requiredDiff.extra) {
      if (specParamNames.includes(name)) {
        requiredIssues.push({
          endpoint: key,
          kind: "required-extra",
          detail: `tool "${contract.tool}" requires "${name}" but spec marks it optional`,
        });
      }
    }

    // ── 4. Response field drift ─────────────────────────────────────────
    if (contract.responseFields === undefined) {
      uncovered.push(key);
      continue;
    }

    const responseSchema = op.responses?.["200"]?.content?.["application/json"]?.schema;
    const resolved = resolveResponseFields(responseSchema, components);

    if (resolved.kind !== "object") {
      // Contract expects fields but spec doesn't declare an object schema —
      // count that itself as drift.
      fieldIssues.push({
        endpoint: key,
        kind: "field-extra",
        detail: `contract expects fields [${contract.responseFields.join(", ")}] but spec response is ${resolved.kind}`,
      });
      continue;
    }

    const fieldDiff = diff(contract.responseFields, resolved.fields);
    for (const name of fieldDiff.missing) {
      fieldIssues.push({
        endpoint: key,
        kind: "field-missing",
        detail: `spec response has field "${name}" not in contract for "${contract.tool}"`,
      });
    }
    for (const name of fieldDiff.extra) {
      fieldIssues.push({
        endpoint: key,
        kind: "field-extra",
        detail: `contract expects field "${name}" not in spec response for "${contract.tool}"`,
      });
    }
  }

  const hasDrift =
    endpointGaps.length > 0 ||
    paramIssues.length > 0 ||
    requiredIssues.length > 0 ||
    fieldIssues.length > 0;

  // ── Output ────────────────────────────────────────────────────────────
  const total = coveredKeys.length + endpointGaps.length;

  const issueCount = endpointGaps.length + paramIssues.length + requiredIssues.length + fieldIssues.length;

  if (!hasDrift) {
    console.error(`✅ API drift check passed: ${total} endpoints covered, params/required/response-fields all in sync (${uncovered.length} endpoints skip field check)`);
  } else {
    console.error(`⚠️  API drift check: ${issueCount} issue(s) across ${total} endpoint(s)`);
    console.error("");
    if (endpointGaps.length > 0) {
      console.error(`Endpoint coverage — ${endpointGaps.length} endpoint(s) have no MCP tool:`);
      for (const key of endpointGaps) console.error(`  - ${key}`);
      console.error("  → Add a tool in src/tools/sodaxApi.ts and a contract entry in src/services/apiDriftCheck.ts");
      console.error("");
    }
    if (paramIssues.length > 0) {
      console.error(`Param drift — ${paramIssues.length} issue(s):`);
      for (const issue of paramIssues) console.error(`  - ${issue.endpoint}: ${issue.detail}`);
      console.error("");
    }
    if (requiredIssues.length > 0) {
      console.error(`Required-flag drift — ${requiredIssues.length} issue(s):`);
      for (const issue of requiredIssues) console.error(`  - ${issue.endpoint}: ${issue.detail}`);
      console.error("");
    }
    if (fieldIssues.length > 0) {
      console.error(`Response-field drift — ${fieldIssues.length} issue(s):`);
      for (const issue of fieldIssues) console.error(`  - ${issue.endpoint}: ${issue.detail}`);
      console.error("");
    }
  }

  if (uncovered.length > 0) {
    console.error(`ℹ️  ${uncovered.length} endpoint(s) skip response-field drift (service returns primitive, map, or no schema):`);
    for (const key of uncovered) console.error(`  - ${key}`);
  }

  return {
    hasDrift,
    summary: {
      totalEndpoints: total,
      endpointGaps: endpointGaps.length,
      paramGaps: paramIssues.length,
      requiredGaps: requiredIssues.length,
      fieldGaps: fieldIssues.length,
      uncovered: uncovered.length,
    },
  };
}

/**
 * Given a normalized path like `/config/hub/:chainId/assets`, find the
 * matching raw key (`/config/hub/{chainId}/assets`) in the spec's paths
 * object so we can index back into it.
 */
function restoreOpenApiPath(normalized: string, paths: OpenApiSpec["paths"]): string {
  for (const raw of Object.keys(paths)) {
    if (normalizePath(raw) === normalized) return raw;
  }
  return normalized;
}
