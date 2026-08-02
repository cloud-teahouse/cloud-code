import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { HookDefSchema, type HookDefConfig, type McpServerConfig } from '../config/schema';
import { HOOK_EVENT_TYPES } from '../session/hooks/types';
import {
  isDir,
  isFile,
  isObject,
  listMarkdownFilesRecursive,
  readCommandPaths,
  readMcpServersRecord,
  resolveDirListField,
  resolvePluginPathField,
  stringArrayField,
  stringField,
  substituteClaudePluginRoot,
} from './manifest-shared';
import {
  PLUGIN_NAME_REGEX,
  type PluginCommandEntry,
  type PluginDiagnostic,
  type PluginManifest,
} from './types';

/**
 * Claude Code plugin format (`.claude-plugin/plugin.json`) → `PluginManifest`.
 *
 * Mapping notes (divergences are emitted as info/warn diagnostics):
 * - `name`: CC only forbids whitespace; we additionally require the native
 *   kebab-case charset after lowercasing (the lowercase form becomes the id).
 * - `author.url` is dropped (native author has name/email only); `repository`
 *   is used as `homepage` when no homepage is declared.
 * - Components not declared in the manifest are auto-discovered from the
 *   conventional locations: `commands/`, `agents/`, `skills/`,
 *   `outputStyles/`, `hooks/hooks.json`, `.mcp.json` (plugin root).
 * - `agents` entries are `.md` files in CC; native agent sources are
 *   directories, so a file entry contributes its parent directory.
 * - `outputStyles` is a dir list like `skills`; each dir contributes its
 *   `*.md` style files to the session's output-style registry (plugin
 *   precedence: below user and project styles). CC's `forceForPlugin` is not
 *   supported — style selection stays with the user.
 * - Hooks convert from the CC nested shape
 *   (`{ Event: [{ matcher, hooks: [{type:"command", command, ...}] }] }`) to
 *   the native flat `HookDefConfig[]`. Only `type: "command"` hooks are
 *   supported; unknown events and other hook types are skipped with a warn.
 * - `${CLAUDE_PLUGIN_ROOT}` is substituted with the plugin root in hook
 *   commands and MCP configs.
 * - Unsupported CC fields (`lspServers`, `settings`,
 *   `userConfig`, `channels`, `dependencies`, MCPB bundles) are reported as
 *   info diagnostics and otherwise ignored.
 */

const CC_HOOKS_FILE_PATH = path.join('hooks', 'hooks.json');
const CC_MCP_FILE_PATH = '.mcp.json';

// CC manifest sections that carry runtime behavior we do not implement.
const UNSUPPORTED_CC_FIELDS = [
  'lspServers',
  'settings',
  'userConfig',
  'channels',
  'dependencies',
] as const;

export interface ClaudeManifestBuildInput {
  readonly pluginRoot: string;
  readonly raw: Record<string, unknown>;
  readonly diagnostics: PluginDiagnostic[];
}

export async function buildClaudePluginManifest(
  input: ClaudeManifestBuildInput,
): Promise<PluginManifest | undefined> {
  const { pluginRoot, raw, diagnostics } = input;

  const declaredName = typeof raw['name'] === 'string' ? raw['name'].trim() : '';
  if (declaredName.length === 0) {
    diagnostics.push({ severity: 'error', message: '"name" is required' });
    return undefined;
  }
  if (/\s/.test(declaredName)) {
    diagnostics.push({
      severity: 'error',
      message: `"name" must not contain whitespace (got "${declaredName}")`,
    });
    return undefined;
  }
  // CC accepts any whitespace-free name; the native id charset is stricter.
  // Lowercasing covers the common `MyPlugin` case — the lowercase form is what
  // `normalizePluginId` would produce for the install id anyway.
  const name = declaredName.toLowerCase();
  if (!PLUGIN_NAME_REGEX.test(name)) {
    diagnostics.push({
      severity: 'error',
      message: `"name" must match ${PLUGIN_NAME_REGEX} after lowercasing (got "${declaredName}")`,
    });
    return undefined;
  }

  for (const field of UNSUPPORTED_CC_FIELDS) {
    if (raw[field] === undefined) continue;
    diagnostics.push({
      severity: 'info',
      message: `"${field}" is present but not supported by Cloud Code CLI plugins`,
    });
  }

  const manifest: PluginManifest = {
    name,
    version: stringField(raw, 'version'),
    description: stringField(raw, 'description'),
    keywords: stringArrayField(raw, 'keywords'),
    homepage: stringField(raw, 'homepage') ?? stringField(raw, 'repository'),
    license: stringField(raw, 'license'),
    author: readClaudeAuthor(raw['author']),
    skills: await readClaudeSkills(pluginRoot, raw['skills'], diagnostics),
    agents: await readClaudeAgents(pluginRoot, raw['agents'], diagnostics),
    outputStyles: await readClaudeOutputStyles(pluginRoot, raw['outputStyles'], diagnostics),
    mcpServers: await readClaudeMcpServers(pluginRoot, raw['mcpServers'], diagnostics),
    hooks: await readClaudeHooks(pluginRoot, raw['hooks'], diagnostics),
    commands: await readClaudeCommands(pluginRoot, raw['commands'], diagnostics),
  };
  return manifest;
}

function readClaudeAuthor(raw: unknown): PluginManifest['author'] {
  if (typeof raw === 'string') return { name: raw };
  if (!isObject(raw)) return undefined;
  const name = stringField(raw, 'name');
  const email = stringField(raw, 'email');
  if (name === undefined && email === undefined) return undefined;
  return { name, email };
}

async function readClaudeSkills(
  pluginRoot: string,
  raw: unknown,
  diagnostics: PluginDiagnostic[],
): Promise<readonly string[]> {
  if (raw === undefined) {
    // CC auto-discovery: a conventional `skills/` directory.
    const conventional = path.join(pluginRoot, 'skills');
    return (await isDir(conventional)) ? [conventional] : [];
  }
  return resolveDirListField(pluginRoot, 'skills', raw, diagnostics);
}

async function readClaudeOutputStyles(
  pluginRoot: string,
  raw: unknown,
  diagnostics: PluginDiagnostic[],
): Promise<readonly string[]> {
  if (raw === undefined) {
    // CC auto-discovery: a conventional `outputStyles/` directory.
    const conventional = path.join(pluginRoot, 'outputStyles');
    return (await isDir(conventional)) ? [conventional] : [];
  }
  return resolveDirListField(pluginRoot, 'outputStyles', raw, diagnostics);
}

async function readClaudeAgents(
  pluginRoot: string,
  raw: unknown,
  diagnostics: PluginDiagnostic[],
): Promise<readonly string[]> {
  if (raw === undefined) {
    const conventional = path.join(pluginRoot, 'agents');
    return (await isDir(conventional)) ? [conventional] : [];
  }
  // CC lists individual agent .md files; the native model loads directories of
  // .md files, so each file entry contributes its parent directory (deduped).
  const entries: string[] = [];
  if (typeof raw === 'string') {
    entries.push(raw);
  } else if (Array.isArray(raw) && raw.every((entry) => typeof entry === 'string')) {
    entries.push(...raw);
  } else {
    diagnostics.push({ severity: 'warn', message: '"agents" must be a string or string[]' });
    return [];
  }
  const dirs: string[] = [];
  for (const entry of entries) {
    const resolved = await resolvePluginPathField({
      pluginRoot,
      field: 'agents',
      value: entry,
      diagnostics,
    });
    if (resolved === undefined) continue;
    let dir: string | undefined;
    if (await isDir(resolved)) {
      dir = resolved;
    } else if ((await isFile(resolved)) && resolved.endsWith('.md')) {
      dir = path.dirname(resolved);
    } else {
      diagnostics.push({
        severity: 'warn',
        message: `"agents" entry must be a directory or .md file (${entry})`,
      });
      continue;
    }
    if (!dirs.includes(dir)) dirs.push(dir);
  }
  return dirs;
}

async function readClaudeCommands(
  pluginRoot: string,
  raw: unknown,
  diagnostics: PluginDiagnostic[],
): Promise<readonly PluginCommandEntry[] | undefined> {
  if (raw === undefined) {
    const conventional = path.join(pluginRoot, 'commands');
    if (!(await isDir(conventional))) return undefined;
    const files = await listMarkdownFilesRecursive(conventional);
    return files.length === 0 ? undefined : files.toSorted((a, b) => a.name.localeCompare(b.name));
  }
  // Object-mapping form: { "name": { "source": "./x.md" } | { "content": "..." } }.
  if (isObject(raw)) {
    return readClaudeCommandMap(pluginRoot, raw, diagnostics);
  }
  return readCommandPaths(pluginRoot, raw, diagnostics);
}

async function readClaudeCommandMap(
  pluginRoot: string,
  raw: Record<string, unknown>,
  diagnostics: PluginDiagnostic[],
): Promise<readonly PluginCommandEntry[] | undefined> {
  const out: PluginCommandEntry[] = [];
  for (const [commandName, meta] of Object.entries(raw)) {
    const name = commandName.trim();
    if (name.length === 0) {
      diagnostics.push({ severity: 'warn', message: '"commands" keys must be non-empty names' });
      continue;
    }
    if (!isObject(meta)) {
      diagnostics.push({
        severity: 'warn',
        message: `"commands.${name}" must be an object with "source" or "content"`,
      });
      continue;
    }
    const description = stringField(meta, 'description');
    const source = stringField(meta, 'source');
    const content = typeof meta['content'] === 'string' ? meta['content'] : undefined;
    if (source !== undefined && content !== undefined) {
      diagnostics.push({
        severity: 'warn',
        message: `"commands.${name}" must declare either "source" or "content", not both`,
      });
      continue;
    }
    if (content !== undefined) {
      out.push({ name, content, description });
      continue;
    }
    if (source === undefined) {
      diagnostics.push({
        severity: 'warn',
        message: `"commands.${name}" must declare "source" or "content"`,
      });
      continue;
    }
    const resolved = await resolvePluginPathField({
      pluginRoot,
      field: `commands.${name}.source`,
      value: source,
      diagnostics,
    });
    if (resolved === undefined) continue;
    if (await isDir(resolved)) {
      out.push(...(await listMarkdownFilesRecursive(resolved)));
    } else if ((await isFile(resolved)) && resolved.endsWith('.md')) {
      out.push({ path: resolved, name, description });
    } else {
      diagnostics.push({
        severity: 'warn',
        message: `"commands.${name}.source" must be a directory or .md file (${source})`,
      });
    }
  }
  return out.length === 0 ? undefined : out.toSorted((a, b) => a.name.localeCompare(b.name));
}

// ── Hooks ───────────────────────────────────────────────────────────────────

async function readClaudeHooks(
  pluginRoot: string,
  raw: unknown,
  diagnostics: PluginDiagnostic[],
): Promise<readonly HookDefConfig[] | undefined> {
  const out: HookDefConfig[] = [];

  // Standard location first (CC loads hooks/hooks.json before manifest hooks).
  const standardPath = path.join(pluginRoot, CC_HOOKS_FILE_PATH);
  if (await isFile(standardPath)) {
    out.push(...(await readClaudeHooksFile(pluginRoot, standardPath, diagnostics)));
  }

  if (raw !== undefined) {
    const specs = Array.isArray(raw) ? raw : [raw];
    for (const spec of specs) {
      if (typeof spec === 'string') {
        const resolved = await resolvePluginPathField({
          pluginRoot,
          field: 'hooks',
          value: spec,
          diagnostics,
        });
        if (resolved === undefined || !(await isFile(resolved))) {
          if (resolved !== undefined) {
            diagnostics.push({
              severity: 'warn',
              message: `"hooks" file not found (${spec})`,
            });
          }
          continue;
        }
        out.push(...(await readClaudeHooksFile(pluginRoot, resolved, diagnostics)));
      } else if (isObject(spec)) {
        out.push(...convertClaudeHooks(pluginRoot, spec, diagnostics));
      } else {
        diagnostics.push({
          severity: 'warn',
          message: '"hooks" entries must be JSON file paths or inline hook objects',
        });
      }
    }
  }

  return out.length === 0 ? undefined : out;
}

async function readClaudeHooksFile(
  pluginRoot: string,
  filePath: string,
  diagnostics: PluginDiagnostic[],
): Promise<readonly HookDefConfig[]> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    diagnostics.push({
      severity: 'warn',
      message: `Failed to parse hooks file ${path.relative(pluginRoot, filePath)}: ${(error as Error).message}`,
    });
    return [];
  }
  if (!isObject(raw)) {
    diagnostics.push({
      severity: 'warn',
      message: `Hooks file ${path.relative(pluginRoot, filePath)} must be a JSON object`,
    });
    return [];
  }
  // The CC wrapper shape is { "description"?, "hooks": {...} }; tolerate a
  // bare event map as well.
  const nested = isObject(raw['hooks']) ? raw['hooks'] : raw;
  return convertClaudeHooks(pluginRoot, nested, diagnostics);
}

function convertClaudeHooks(
  pluginRoot: string,
  nested: Record<string, unknown>,
  diagnostics: PluginDiagnostic[],
): readonly HookDefConfig[] {
  const out: HookDefConfig[] = [];
  for (const [event, groups] of Object.entries(nested)) {
    if (!(HOOK_EVENT_TYPES as readonly string[]).includes(event)) {
      diagnostics.push({
        severity: 'warn',
        message: `Unsupported hook event "${event}" — skipped`,
      });
      continue;
    }
    if (!Array.isArray(groups)) {
      diagnostics.push({
        severity: 'warn',
        message: `Hook event "${event}" must map to an array of matcher groups`,
      });
      continue;
    }
    for (const group of groups) {
      if (!isObject(group)) continue;
      const matcher = stringField(group, 'matcher');
      const hooks = group['hooks'];
      if (!Array.isArray(hooks)) continue;
      for (const hook of hooks) {
        if (!isObject(hook)) continue;
        if (hook['type'] !== 'command') {
          diagnostics.push({
            severity: 'warn',
            message: `Unsupported hook type "${String(hook['type'])}" for ${event} — only "command" hooks are supported`,
          });
          continue;
        }
        const substituted = substituteClaudePluginRoot(hook, pluginRoot) as Record<string, unknown>;
        const candidate = {
          event,
          ...(matcher !== undefined ? { matcher } : {}),
          ...(typeof substituted['if'] === 'string' ? { if: substituted['if'] } : {}),
          command: substituted['command'],
          ...(typeof substituted['timeout'] === 'number' ? { timeout: substituted['timeout'] } : {}),
        };
        const parsed = HookDefSchema.safeParse(candidate);
        if (!parsed.success) {
          diagnostics.push({
            severity: 'warn',
            message: `Invalid ${event} hook: ${parsed.error.message}`,
          });
        } else {
          out.push(parsed.data);
        }
      }
    }
  }
  return out;
}

// ── MCP servers ─────────────────────────────────────────────────────────────

async function readClaudeMcpServers(
  pluginRoot: string,
  raw: unknown,
  diagnostics: PluginDiagnostic[],
): Promise<Readonly<Record<string, McpServerConfig>> | undefined> {
  const merged: Record<string, unknown> = {};

  // `.mcp.json` at the plugin root loads first (lowest priority in CC).
  const dotMcpPath = path.join(pluginRoot, CC_MCP_FILE_PATH);
  if (await isFile(dotMcpPath)) {
    try {
      const parsed: unknown = JSON.parse(await readFile(dotMcpPath, 'utf8'));
      const record = isObject(parsed)
        ? isObject(parsed['mcpServers'])
          ? parsed['mcpServers']
          : parsed
        : undefined;
      if (record !== undefined) Object.assign(merged, record);
    } catch (error) {
      diagnostics.push({
        severity: 'warn',
        message: `Failed to parse ${CC_MCP_FILE_PATH}: ${(error as Error).message}`,
      });
    }
  }

  if (raw !== undefined) {
    const specs = Array.isArray(raw) ? raw : [raw];
    for (const spec of specs) {
      if (typeof spec === 'string') {
        if (spec.endsWith('.mcpb') || spec.endsWith('.dxt')) {
          diagnostics.push({
            severity: 'info',
            message: `MCPB bundle "${spec}" is not supported by Cloud Code CLI plugins`,
          });
          continue;
        }
        const resolved = await resolvePluginPathField({
          pluginRoot,
          field: 'mcpServers',
          value: spec,
          diagnostics,
        });
        if (resolved === undefined || !(await isFile(resolved))) {
          if (resolved !== undefined) {
            diagnostics.push({ severity: 'warn', message: `"mcpServers" file not found (${spec})` });
          }
          continue;
        }
        try {
          const parsed: unknown = JSON.parse(await readFile(resolved, 'utf8'));
          const record = isObject(parsed)
            ? isObject(parsed['mcpServers'])
              ? parsed['mcpServers']
              : parsed
            : undefined;
          if (record === undefined) {
            diagnostics.push({
              severity: 'warn',
              message: `"mcpServers" file ${spec} must contain an object`,
            });
            continue;
          }
          Object.assign(merged, record);
        } catch (error) {
          diagnostics.push({
            severity: 'warn',
            message: `Failed to parse MCP servers file ${spec}: ${(error as Error).message}`,
          });
        }
      } else if (isObject(spec)) {
        Object.assign(merged, spec);
      } else {
        diagnostics.push({
          severity: 'warn',
          message: '"mcpServers" entries must be JSON file paths or inline objects',
        });
      }
    }
  }

  if (Object.keys(merged).length === 0) return undefined;
  // CC configs tag the transport with `type`; substitute ${CLAUDE_PLUGIN_ROOT}
  // before schema parsing/normalization.
  const preNormalized: Record<string, unknown> = {};
  for (const [serverName, config] of Object.entries(merged)) {
    let value = substituteClaudePluginRoot(config, pluginRoot);
    if (isObject(value) && value['transport'] === undefined && typeof value['type'] === 'string') {
      const { type, ...rest } = value;
      value = { ...rest, transport: type };
    }
    preNormalized[serverName] = value;
  }
  return readMcpServersRecord(pluginRoot, preNormalized, diagnostics);
}
