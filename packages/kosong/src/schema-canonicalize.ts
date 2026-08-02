/**
 * Canonical form for tool parameter schemas, for byte-stable wire
 * serialization.
 *
 * Go gets canonical JSON for free from `json.Marshal` (map keys are emitted
 * sorted); JavaScript object key order is insertion order, so a schema whose
 * bytes depend on how an MCP server happened to serialize it can drift across
 * reconnects or server versions and bust the prompt-cache prefix. Go's
 * `CanonicalizeSchema` is ported here as an explicit rebuild: every object is
 * reconstructed with recursively sorted keys, so plain `JSON.stringify` of
 * the result is stable for logically identical schemas.
 *
 * Beyond key order, the canonicalization normalizes:
 * - empty/missing/non-object schemas -> `{"properties":{},"type":"object"}`;
 * - root `type` / `properties` filled in when absent (tool parameters are
 *   always an object schema on the wire);
 * - `required` arrays sorted; non-array `required` (OpenAPI-style
 *   `required: true`) dropped — it is not valid JSON Schema and strict
 *   providers reject it;
 * - `dependentRequired` string arrays sorted.
 *
 * Ordering contract (F8): compatibility normalization runs first
 * (Kimi's `normalizeKimiToolSchema` derefs `$ref` and fills missing `type`),
 * canonicalization runs last — it never undoes those repairs, it only makes
 * their output byte-stable.
 */

/**
 * Return the canonical form of a tool parameter schema: a fresh object with
 * recursively sorted keys and the normalizations described above. The input
 * is never mutated.
 */
export function canonicalizeToolSchema(
  schema: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  if (schema === null || schema === undefined || !isRecord(schema) || Object.keys(schema).length === 0) {
    return { properties: {}, type: 'object' };
  }
  const canonical = canonicalizeNode(schema) as Record<string, unknown>;
  if (canonical['type'] === undefined) {
    canonical['type'] = 'object';
  }
  if (canonical['properties'] === undefined) {
    canonical['properties'] = {};
  }
  // The two fills above append keys out of order; rebuild once more so the
  // root object is key-sorted like every nested node.
  return sortRecordKeys(canonical);
}

function canonicalizeNode(value: unknown, key?: string): unknown {
  if (Array.isArray(value)) {
    const items = value.map((item) => canonicalizeNode(item));
    if (key === 'required') {
      return items.toSorted(compareJsonValues);
    }
    return items;
  }
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const childKey of Object.keys(value).toSorted()) {
      const child = value[childKey];
      if (childKey === 'required' && !Array.isArray(child)) {
        // OpenAPI-style `required: true` — not JSON Schema; drop it.
        continue;
      }
      if (childKey === 'dependentRequired' && isRecord(child)) {
        const sorted: Record<string, unknown> = {};
        for (const depKey of Object.keys(child).toSorted()) {
          const depValue = child[depKey];
          sorted[depKey] = Array.isArray(depValue)
            ? depValue.map((item) => canonicalizeNode(item)).toSorted(compareJsonValues)
            : canonicalizeNode(depValue);
        }
        out[childKey] = sorted;
        continue;
      }
      out[childKey] = canonicalizeNode(child, childKey);
    }
    return out;
  }
  return value;
}

function sortRecordKeys(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(record).toSorted()) {
    out[key] = record[key];
  }
  return out;
}

/**
 * Deterministic total order for `required`-style string arrays. Uses
 * code-unit comparison (not localeCompare) so the result is locale- and
 * runtime-independent; non-string entries are tolerated defensively and
 * ordered by their JSON spelling.
 */
function compareJsonValues(a: unknown, b: unknown): number {
  const sa = typeof a === 'string' ? a : JSON.stringify(a);
  const sb = typeof b === 'string' ? b : JSON.stringify(b);
  if (sa === undefined || sb === undefined) return 0;
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
