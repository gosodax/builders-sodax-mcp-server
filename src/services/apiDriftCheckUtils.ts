/**
 * Pure helpers for the API drift check. Kept separate from
 * `apiDriftCheck.ts` so the orchestration module stays focused on
 * fetching the spec and emitting a report, while these primitives can
 * be unit-tested in isolation.
 */

export interface OpenApiSchema {
  $ref?: string;
  type?: string;
  properties?: Record<string, OpenApiSchema>;
  items?: OpenApiSchema;
  additionalProperties?: OpenApiSchema | boolean;
  allOf?: OpenApiSchema[];
}

/**
 * The shape `resolveResponseFields` returns after walking an OpenAPI
 * response schema down to its top-level property names (or giving up
 * when the schema can't be compared at the field level).
 */
export type ResolvedFields =
  | { kind: "object"; fields: string[] }
  | { kind: "primitive" }
  | { kind: "map" }
  | { kind: "unknown" };

/**
 * Resolve a response schema down to its top-level property names.
 *
 * Returns:
 *   - `{ kind: "object", fields: [...] }` for an object schema (inline or via $ref)
 *   - `{ kind: "object", fields: [...] }` for an array of objects (fields = item props)
 *   - `{ kind: "primitive" }` / `{ kind: "map" }` / `{ kind: "unknown" }` when
 *      drift can't be checked at the field level
 */
export function resolveResponseFields(
  schema: OpenApiSchema | undefined,
  components: Record<string, OpenApiSchema> | undefined,
  depth = 0,
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

/**
 * Set-difference helper used by the drift report.
 *
 * Note: `missing` here means "in `actual` but not in `expected`" and
 * `extra` means the opposite — the naming reads naturally at the
 * call sites in `apiDriftCheck.ts` where `expected` is the tool's
 * contract and `actual` is what the spec advertises.
 */
export function diff(expected: string[], actual: string[]): { missing: string[]; extra: string[] } {
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  return {
    missing: actual.filter(x => !expectedSet.has(x)), // in actual but not expected
    extra: expected.filter(x => !actualSet.has(x)), // in expected but not actual
  };
}
