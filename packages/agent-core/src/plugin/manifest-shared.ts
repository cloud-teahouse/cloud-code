import { readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import {
  McpServerConfigSchema,
  type McpServerConfig,
} from '../config/schema';
import type { PluginCommandEntry, PluginDiagnostic } from './types';

/**
 * Helpers shared by the native (`kimi.plugin.json`) and Claude Code
 * (`.claude-plugin/plugin.json`) manifest parsers. Everything here is
 * format-agnostic: path resolution inside a plugin root, command-file
 * discovery, and MCP server normalization.
 */

/**
 * Resolve a manifest field that lists in-plugin directories (`skills`,
 * `agents`): each entry must be a "./"-relative path that stays inside the
 * plugin root and points at an existing directory. Diagnostics reference the
 * field name verbatim, so the `skills` messages are unchanged from before the
 * generalization.
 */
export async function resolveDirListField(
  pluginRoot: string,
  field: string,
  raw: unknown,
  diagnostics: PluginDiagnostic[],
): Promise<readonly string[]> {
  if (raw === undefined) return [];
  const entries: string[] = [];
  if (typeof raw === 'string') {
    entries.push(raw);
  } else if (Array.isArray(raw) && raw.every((entry) => typeof entry === 'string')) {
    entries.push(...raw);
  } else {
    diagnostics.push({ severity: 'error', message: `"${field}" must be a string or string[]` });
    return [];
  }

  const resolved: string[] = [];
  for (const entry of entries) {
    if (!entry.startsWith('./')) {
      diagnostics.push({
        severity: 'error',
        message: `"${field}" path must start with "./" (got "${entry}")`,
      });
      continue;
    }
    const absolute = path.resolve(pluginRoot, entry);
    let real: string;
    try {
      real = await realpath(absolute);
    } catch {
      real = absolute;
    }
    const rootReal = await realpath(pluginRoot).catch(() => pluginRoot);
    if (!isWithin(real, rootReal)) {
      diagnostics.push({
        severity: 'error',
        message: `"${field}" path resolves outside the plugin (${entry})`,
      });
      continue;
    }
    if (!(await isDir(real))) {
      diagnostics.push({
        severity: 'warn',
        message: `"${field}" path is not a directory (${entry})`,
      });
      continue;
    }
    resolved.push(real);
  }
  return resolved;
}

export async function resolvePluginPathField(input: {
  readonly pluginRoot: string;
  readonly field: string;
  readonly value: string;
  readonly diagnostics: PluginDiagnostic[];
}): Promise<string | undefined> {
  if (!input.value.startsWith('./')) {
    input.diagnostics.push({
      severity: 'warn',
      message: `"${input.field}" path must start with "./" (got "${input.value}")`,
    });
    return undefined;
  }
  const absolute = path.resolve(input.pluginRoot, input.value);
  let real: string;
  try {
    real = await realpath(absolute);
  } catch {
    real = absolute;
  }
  const rootReal = await realpath(input.pluginRoot).catch(() => input.pluginRoot);
  if (!isWithin(real, rootReal)) {
    input.diagnostics.push({
      severity: 'warn',
      message: `"${input.field}" path resolves outside the plugin (${input.value})`,
    });
    return undefined;
  }
  return real;
}

/**
 * Read a manifest `commands` field in the path form (single path or list of
 * paths, each pointing at a directory of `.md` files or a single `.md` file).
 * Shared by both manifest formats; the Claude Code object-mapping form is
 * handled by the Claude parser itself.
 */
export async function readCommandPaths(
  pluginRoot: string,
  raw: unknown,
  diagnostics: PluginDiagnostic[],
): Promise<readonly PluginCommandEntry[] | undefined> {
  if (raw === undefined) return undefined;
  const entries: string[] = [];
  if (typeof raw === 'string') {
    entries.push(raw);
  } else if (Array.isArray(raw) && raw.every((entry) => typeof entry === 'string')) {
    entries.push(...raw);
  } else {
    diagnostics.push({ severity: 'warn', message: '"commands" must be a string or string[]' });
    return undefined;
  }

  const files: PluginCommandEntry[] = [];
  for (const entry of entries) {
    const resolved = await resolvePluginPathField({
      pluginRoot,
      field: 'commands',
      value: entry,
      diagnostics,
    });
    if (resolved === undefined) continue;
    if (await isDir(resolved)) {
      files.push(...(await listMarkdownFilesRecursive(resolved)));
    } else if ((await isFile(resolved)) && resolved.endsWith('.md')) {
      files.push({ path: resolved, name: commandNameFromFile(resolved, path.dirname(resolved)) });
    } else {
      diagnostics.push({
        severity: 'warn',
        message: `"commands" entry must be a directory or .md file (${entry})`,
      });
    }
  }
  return files.length === 0 ? undefined : files.toSorted((a, b) => a.name.localeCompare(b.name));
}

export async function listMarkdownFilesRecursive(
  root: string,
): Promise<readonly PluginCommandEntry[]> {
  const out: PluginCommandEntry[] = [];
  await walkMarkdown(root, root, out);
  return out;
}

async function walkMarkdown(
  root: string,
  dir: string,
  out: PluginCommandEntry[],
): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkMarkdown(root, full, out);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      out.push({ path: full, name: commandNameFromFile(full, root) });
    }
  }
}

export function commandNameFromFile(file: string, root: string): string {
  const relative = path.relative(root, file).replace(/\.md$/i, '');
  return relative.split(path.sep).join('/');
}

/**
 * Parse and normalize a raw `mcpServers` record (name → config). Shared by
 * both manifest formats; the Claude parser pre-normalizes CC-specific shapes
 * (`type` → `transport`, `${CLAUDE_PLUGIN_ROOT}` substitution, `.mcp.json`
 * wrapper) before calling this.
 */
export async function readMcpServersRecord(
  pluginRoot: string,
  raw: unknown,
  diagnostics: PluginDiagnostic[],
): Promise<Readonly<Record<string, McpServerConfig>> | undefined> {
  if (raw === undefined) return undefined;
  if (!isObject(raw)) {
    diagnostics.push({ severity: 'warn', message: '"mcpServers" must be an object' });
    return undefined;
  }

  const out: Record<string, McpServerConfig> = {};
  for (const [name, value] of Object.entries(raw)) {
    const trimmedName = name.trim();
    if (trimmedName.length === 0) {
      diagnostics.push({
        severity: 'warn',
        message: '"mcpServers" entries must have a non-empty name',
      });
      continue;
    }
    const parsed = McpServerConfigSchema.safeParse(value);
    if (!parsed.success) {
      diagnostics.push({
        severity: 'warn',
        message: `Invalid MCP server "${trimmedName}": ${parsed.error.message}`,
      });
      continue;
    }
    const normalized = await normalizePluginMcpServer({
      pluginRoot,
      name: trimmedName,
      config: parsed.data,
      diagnostics,
    });
    if (normalized !== undefined) out[trimmedName] = normalized;
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

export async function normalizePluginMcpServer(input: {
  readonly pluginRoot: string;
  readonly name: string;
  readonly config: McpServerConfig;
  readonly diagnostics: PluginDiagnostic[];
}): Promise<McpServerConfig | undefined> {
  const { config } = input;
  if (config.transport === 'http' || config.transport === 'sse') return config;

  let command = config.command;
  if (command.startsWith('./')) {
    const resolvedCommand = await resolvePluginPathField({
      pluginRoot: input.pluginRoot,
      field: `mcpServers.${input.name}.command`,
      value: command,
      diagnostics: input.diagnostics,
    });
    if (resolvedCommand === undefined) return undefined;
    command = resolvedCommand;
  } else if (command.includes('/') || path.isAbsolute(command)) {
    input.diagnostics.push({
      severity: 'warn',
      message: `"mcpServers.${input.name}.command" must be a PATH command or start with "./"`,
    });
    return undefined;
  }

  let cwd = config.cwd;
  if (cwd !== undefined) {
    const resolvedCwd = await resolvePluginPathField({
      pluginRoot: input.pluginRoot,
      field: `mcpServers.${input.name}.cwd`,
      value: cwd,
      diagnostics: input.diagnostics,
    });
    if (resolvedCwd === undefined) return undefined;
    cwd = resolvedCwd;
  }

  return { ...config, command, cwd };
}

/**
 * Recursively substitute `${CLAUDE_PLUGIN_ROOT}` in every string of a JSON
 * value. Claude Code plugins reference the variable in hook commands and MCP
 * server configs; the plugin root is known at parse time, so substitution
 * happens once there (the runtime env also exports the variable).
 */
export function substituteClaudePluginRoot(value: unknown, pluginRoot: string): unknown {
  if (typeof value === 'string') {
    return value.replaceAll('${CLAUDE_PLUGIN_ROOT}', pluginRoot);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => substituteClaudePluginRoot(entry, pluginRoot));
  }
  if (isObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = substituteClaudePluginRoot(entry, pluginRoot);
    }
    return out;
  }
  return value;
}

export function stringField(raw: Record<string, unknown>, key: string): string | undefined {
  const value = raw[key];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

export function stringArrayField(
  raw: Record<string, unknown>,
  key: string,
): readonly string[] | undefined {
  const value = raw[key];
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
    return undefined;
  }
  return value as readonly string[];
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isWithin(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export async function isFile(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

export async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}
