/**
 * Key-level merge logic for the structured config files shared by Kimi Code
 * and Cloud Code: `config.toml` (TOML), `keybindings.json` and `mcp.json`
 * (JSON). The merge never overwrites an existing target value: upstream-only
 * keys are imported, conflicts keep the target's value and are reported.
 *
 * Serialization caveat: TOML has no comment-preserving round-trip, so writing
 * the merged config.toml re-serializes the whole document — values are never
 * clobbered, but comments and hand formatting in the target file are
 * normalized away (same trade-off as the Core's own writeConfigFile). The
 * preview states this before the user confirms.
 *
 * Brand note: Cloud Code deliberately keeps upstream's managed-platform
 * identifiers (`managed:kimi-code` provider, `kimi-code/` model-alias prefix)
 * because they name the upstream platform both products authenticate against.
 * Upstream alias references such as `default_model = "kimi-code/kimi-for-coding"`
 * therefore resolve unchanged here — `mapModelAliasReference` is the single
 * hook to adjust if that ever changes.
 */

import { readFile } from 'node:fs/promises';

import { parse as parseToml } from 'smol-toml';

import type { KeyMergePlan } from './types';

export interface KeyMergeResult {
  readonly merged: Record<string, unknown>;
  readonly importedKeys: string[];
  readonly keptKeys: string[];
}

/** Identity today; see the brand note above. */
export function mapModelAliasReference(alias: string): string {
  return alias;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Prototype-safe own-property write: `obj[key] = value` would walk the
 * prototype setter for keys like `__proto__` coming from parsed user files.
 */
function setOwn(obj: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(obj, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

/**
 * Prototype-safe existence check: `obj['__proto__']` reads Object.prototype,
 * so `obj[key] === undefined` is not a safe "missing key" test either.
 */
function hasOwn(obj: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/** config.toml merge: per-key, with table-level merging for providers/models. */
export function mergeConfigTomlData(
  source: Record<string, unknown>,
  target: Record<string, unknown>,
): KeyMergeResult {
  const merged: Record<string, unknown> = { ...target };
  const importedKeys: string[] = [];
  const keptKeys: string[] = [];

  for (const [key, sourceValue] of Object.entries(source)) {
    const targetValue = hasOwn(merged, key) ? merged[key] : undefined;
    // providers/models merge per entry, even when the target lacks the table.
    if ((key === 'providers' || key === 'models') && isPlainObject(sourceValue)) {
      if (targetValue !== undefined && !isPlainObject(targetValue)) {
        keptKeys.push(key);
        continue;
      }
      const table: Record<string, unknown> = isPlainObject(targetValue) ? { ...targetValue } : {};
      for (const [entryName, entryValue] of Object.entries(sourceValue)) {
        if (!hasOwn(table, entryName)) {
          setOwn(table, entryName, entryValue);
          importedKeys.push(`${key}."${entryName}"`);
        } else {
          keptKeys.push(`${key}."${entryName}"`);
        }
      }
      setOwn(merged, key, table);
      continue;
    }
    if (targetValue === undefined) {
      setOwn(
        merged,
        key,
        key === 'default_model' && typeof sourceValue === 'string'
          ? mapModelAliasReference(sourceValue)
          : sourceValue,
      );
      importedKeys.push(key);
      continue;
    }
    keptKeys.push(key);
  }
  return { merged, importedKeys, keptKeys };
}

/** keybindings.json merge: flat action -> binding record. */
export function mergeFlatRecordData(
  source: Record<string, unknown>,
  target: Record<string, unknown>,
): KeyMergeResult {
  const merged: Record<string, unknown> = { ...target };
  const importedKeys: string[] = [];
  const keptKeys: string[] = [];
  for (const [key, value] of Object.entries(source)) {
    if (!hasOwn(merged, key)) {
      setOwn(merged, key, value);
      importedKeys.push(key);
    } else {
      keptKeys.push(key);
    }
  }
  return { merged, importedKeys, keptKeys };
}

/** mcp.json merge: only `mcpServers` entries; other target keys preserved. */
export function mergeMcpData(
  source: Record<string, unknown>,
  target: Record<string, unknown>,
): KeyMergeResult {
  const sourceServers = isPlainObject(source['mcpServers']) ? source['mcpServers'] : {};
  const targetServers = isPlainObject(target['mcpServers']) ? target['mcpServers'] : {};
  const servers: Record<string, unknown> = { ...targetServers };
  const importedKeys: string[] = [];
  const keptKeys: string[] = [];
  for (const [name, value] of Object.entries(sourceServers)) {
    if (!hasOwn(servers, name)) {
      setOwn(servers, name, value);
      importedKeys.push(`mcpServers."${name}"`);
    } else {
      keptKeys.push(`mcpServers."${name}"`);
    }
  }
  return {
    merged: { ...target, mcpServers: servers },
    importedKeys,
    keptKeys,
  };
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

export async function readTomlFile(
  path: string,
): Promise<{ data: Record<string, unknown>; exists: boolean; error?: string }> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (error) {
    if (isNotFound(error)) return { data: {}, exists: false };
    throw error;
  }
  try {
    const parsed: unknown = parseToml(raw);
    if (!isPlainObject(parsed)) return { data: {}, exists: true, error: 'not a TOML table' };
    return { data: parsed, exists: true };
  } catch (error) {
    return { data: {}, exists: true, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function readJsonFile(
  path: string,
): Promise<{ data: Record<string, unknown>; exists: boolean; error?: string }> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (error) {
    if (isNotFound(error)) return { data: {}, exists: false };
    throw error;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isPlainObject(parsed)) return { data: {}, exists: true, error: 'not a JSON object' };
    return { data: parsed, exists: true };
  } catch (error) {
    return { data: {}, exists: true, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Build a KeyMergePlan for one structured file pair. Returns undefined when
 * the source file does not exist (category absent, not an error).
 */
export async function buildKeyMergePlan(input: {
  readonly sourcePath: string;
  readonly targetPath: string;
  readonly format: 'toml' | 'json';
  readonly merge: (source: Record<string, unknown>, target: Record<string, unknown>) => KeyMergeResult;
}): Promise<{ plan: KeyMergePlan; merged: Record<string, unknown> } | undefined> {
  const read = input.format === 'toml' ? readTomlFile : readJsonFile;
  const source = await read(input.sourcePath);
  if (!source.exists) return undefined;
  const base = { sourcePath: input.sourcePath, targetPath: input.targetPath };
  if (source.error !== undefined) {
    return {
      plan: { ...base, importedKeys: [], keptKeys: [], sourceError: source.error },
      merged: {},
    };
  }
  const target = await read(input.targetPath);
  if (target.error !== undefined) {
    return {
      plan: { ...base, importedKeys: [], keptKeys: [], targetError: target.error },
      merged: {},
    };
  }
  const result = input.merge(source.data, target.data);
  return {
    plan: { ...base, importedKeys: result.importedKeys, keptKeys: result.keptKeys },
    merged: result.merged,
  };
}
