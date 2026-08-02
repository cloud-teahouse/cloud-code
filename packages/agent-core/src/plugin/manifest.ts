import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import {
  HookDefSchema,
  type HookDefConfig,
} from '../config/schema';
import { buildClaudePluginManifest } from './claude-manifest';
import {
  isDir,
  isFile,
  isObject,
  readCommandPaths,
  readMcpServersRecord,
  resolveDirListField,
  resolvePluginPathField,
  stringArrayField,
  stringField,
} from './manifest-shared';
import {
  PLUGIN_NAME_REGEX,
  type PluginDiagnostic,
  type PluginInterface,
  type PluginManifest,
  type PluginManifestKind,
} from './types';

const KIMI_PLUGIN_ROOT_PATH = 'kimi.plugin.json';
const KIMI_PLUGIN_DIR_PATH = '.kimi-plugin/plugin.json';
const CLAUDE_PLUGIN_MANIFEST_PATH = '.claude-plugin/plugin.json';

export const PLUGIN_SYSTEM_PROMPT_MAX_BYTES = 32 * 1024;

// Fields that look like third-party runtime extensions (Claude / Codex / old
// Kimi CLI). We do not run them; emit an info diagnostic so plugin authors and
// users can see why a field is silently ignored.
const UNSUPPORTED_RUNTIME_FIELDS = [
  'tools',
  'apps',
  'inject',
  'configFile',
  'config_file',
  'bootstrap',
] as const;

export interface ParsedManifestResult {
  readonly manifest?: PluginManifest;
  readonly manifestKind?: PluginManifestKind;
  readonly manifestPath?: string;
  readonly shadowedManifestPath?: string;
  readonly diagnostics: readonly PluginDiagnostic[];
}

interface ManifestCandidate {
  readonly kind: PluginManifestKind;
  readonly relativePath: string;
}

// Priority order: the native formats win over the Claude Code format when a
// directory carries both, so a plugin shipped for both ecosystems behaves
// identically to a native-only plugin here.
const MANIFEST_CANDIDATES: readonly ManifestCandidate[] = [
  { kind: 'kimi-plugin-root', relativePath: KIMI_PLUGIN_ROOT_PATH },
  { kind: 'kimi-plugin-dir', relativePath: KIMI_PLUGIN_DIR_PATH },
  { kind: 'claude-plugin', relativePath: CLAUDE_PLUGIN_MANIFEST_PATH },
];

export async function parseManifest(pluginRoot: string): Promise<ParsedManifestResult> {
  const found: Array<{ kind: PluginManifestKind; path: string }> = [];
  for (const candidate of MANIFEST_CANDIDATES) {
    const candidatePath = path.join(pluginRoot, candidate.relativePath);
    if (await isFile(candidatePath)) {
      found.push({ kind: candidate.kind, path: candidatePath });
    }
  }

  if (found.length === 0) {
    return {
      diagnostics: [
        {
          severity: 'error',
          message: `No manifest at ${KIMI_PLUGIN_ROOT_PATH}, ${KIMI_PLUGIN_DIR_PATH} or ${CLAUDE_PLUGIN_MANIFEST_PATH}`,
        },
      ],
    };
  }

  const chosen = found[0]!;
  const manifestKind = chosen.kind;
  const manifestPath = chosen.path;
  // Shadowing is only reported within the native kimi pair (historical
  // behavior); a Claude manifest next to a native one is ignored by design.
  const shadowedManifestPath =
    manifestKind === 'kimi-plugin-root' && found.some((f) => f.kind === 'kimi-plugin-dir')
      ? path.join(pluginRoot, KIMI_PLUGIN_DIR_PATH)
      : undefined;

  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch (error) {
    return {
      manifestKind,
      manifestPath,
      shadowedManifestPath,
      diagnostics: [
        {
          severity: 'error',
          message: `Failed to parse ${path.relative(pluginRoot, manifestPath)}: ${(error as Error).message}`,
        },
      ],
    };
  }

  if (!isObject(raw)) {
    return {
      manifestKind,
      manifestPath,
      shadowedManifestPath,
      diagnostics: [{ severity: 'error', message: 'manifest must be a JSON object' }],
    };
  }

  if (manifestKind === 'claude-plugin') {
    const diagnostics: PluginDiagnostic[] = [];
    const manifest = await buildClaudePluginManifest({ pluginRoot, raw, diagnostics });
    return { manifest, manifestKind, manifestPath, shadowedManifestPath, diagnostics };
  }

  return buildKimiManifestResult({ pluginRoot, raw, manifestKind, manifestPath, shadowedManifestPath });
}

async function buildKimiManifestResult(input: {
  readonly pluginRoot: string;
  readonly raw: Record<string, unknown>;
  readonly manifestKind: PluginManifestKind;
  readonly manifestPath: string;
  readonly shadowedManifestPath?: string;
}): Promise<ParsedManifestResult> {
  const { pluginRoot, raw, manifestKind, manifestPath, shadowedManifestPath } = input;
  const diagnostics: PluginDiagnostic[] = [];

  const name = typeof raw['name'] === 'string' ? raw['name'].trim() : '';
  if (name.length === 0) {
    diagnostics.push({ severity: 'error', message: '"name" is required' });
    return { manifestKind, manifestPath, shadowedManifestPath, diagnostics };
  }
  if (!PLUGIN_NAME_REGEX.test(name)) {
    diagnostics.push({
      severity: 'error',
      message: `"name" must match ${PLUGIN_NAME_REGEX} (got "${name}")`,
    });
    return { manifestKind, manifestPath, shadowedManifestPath, diagnostics };
  }

  let skills = await resolveDirListField(pluginRoot, 'skills', raw['skills'], diagnostics);
  if (raw['skills'] === undefined) {
    const rootSkillMd = path.join(pluginRoot, 'SKILL.md');
    if (await isFile(rootSkillMd)) {
      skills = [pluginRoot];
    }
  }

  let agents = await resolveDirListField(pluginRoot, 'agents', raw['agents'], diagnostics);
  if (raw['agents'] === undefined) {
    const agentsDir = path.join(pluginRoot, 'agents');
    if (await isDir(agentsDir)) {
      agents = [agentsDir];
    }
  }

  const skillInstructions =
    typeof raw['skillInstructions'] === 'string' ? raw['skillInstructions'] : undefined;

  const systemPrompt = await readSystemPrompt(pluginRoot, raw, diagnostics);

  recordUnsupportedRuntimeFields(raw, diagnostics);

  const manifest: PluginManifest = {
    name,
    version: stringField(raw, 'version'),
    description: stringField(raw, 'description'),
    keywords: stringArrayField(raw, 'keywords'),
    homepage: stringField(raw, 'homepage'),
    license: stringField(raw, 'license'),
    author: readAuthor(raw['author']),
    skills,
    agents,
    sessionStart: readSessionStart(raw['sessionStart'], diagnostics),
    mcpServers: await readMcpServersRecord(pluginRoot, raw['mcpServers'], diagnostics),
    hooks: readHooks(raw['hooks'], diagnostics),
    commands: await readCommandPaths(pluginRoot, raw['commands'], diagnostics),
    interface: readInterface(raw['interface']),
    skillInstructions,
    systemPrompt,
  };

  return { manifest, manifestKind, manifestPath, shadowedManifestPath, diagnostics };
}

function recordUnsupportedRuntimeFields(
  raw: Record<string, unknown>,
  diagnostics: PluginDiagnostic[],
): void {
  for (const field of UNSUPPORTED_RUNTIME_FIELDS) {
    if (raw[field] === undefined) continue;
    diagnostics.push({
      severity: 'info',
      message: `"${field}" is present but not supported by Cloud Code CLI plugins`,
    });
  }
}


function readSessionStart(
  raw: unknown,
  diagnostics: PluginDiagnostic[],
): PluginManifest['sessionStart'] {
  if (raw === undefined) return undefined;
  if (!isObject(raw)) {
    diagnostics.push({ severity: 'warn', message: '"sessionStart" must be an object' });
    return undefined;
  }
  const skill = typeof raw['skill'] === 'string' ? raw['skill'].trim() : '';
  if (skill.length === 0) {
    diagnostics.push({
      severity: 'warn',
      message: '"sessionStart.skill" is required when sessionStart is present',
    });
    return undefined;
  }
  return { skill };
}

async function readSystemPrompt(
  pluginRoot: string,
  raw: Record<string, unknown>,
  diagnostics: PluginDiagnostic[],
): Promise<string | undefined> {
  const parts: string[] = [];
  if (raw['systemPrompt'] !== undefined && typeof raw['systemPrompt'] !== 'string') {
    diagnostics.push({ severity: 'warn', message: '"systemPrompt" must be a string' });
  }
  const inline = stringField(raw, 'systemPrompt');
  if (inline !== undefined) {
    const inlineBytes = Buffer.byteLength(inline, 'utf8');
    if (inlineBytes > PLUGIN_SYSTEM_PROMPT_MAX_BYTES) {
      diagnostics.push({
        severity: 'warn',
        message:
          `"systemPrompt" is ${inlineBytes} bytes, exceeding the ` +
          `${PLUGIN_SYSTEM_PROMPT_MAX_BYTES / 1024} KB limit; the field is ignored`,
      });
    } else {
      parts.push(inline);
    }
  }

  const pathValue = raw['systemPromptPath'];
  if (pathValue !== undefined) {
    if (typeof pathValue !== 'string') {
      diagnostics.push({ severity: 'warn', message: '"systemPromptPath" must be a string' });
    } else if (pathValue.trim().length === 0) {
      diagnostics.push({ severity: 'warn', message: '"systemPromptPath" must not be blank' });
    } else {
      const resolved = await resolvePluginPathField({
        pluginRoot,
        field: 'systemPromptPath',
        value: pathValue.trim(),
        diagnostics,
      });
      if (resolved !== undefined) {
        const fileStat = await stat(resolved).catch(() => undefined);
        if (fileStat === undefined || !fileStat.isFile()) {
          diagnostics.push({
            severity: 'warn',
            message: `"systemPromptPath" is not a file (${pathValue})`,
          });
        } else if (fileStat.size > PLUGIN_SYSTEM_PROMPT_MAX_BYTES) {
          diagnostics.push({
            severity: 'warn',
            message:
              `"systemPromptPath" is ${fileStat.size} bytes, exceeding the ` +
              `${PLUGIN_SYSTEM_PROMPT_MAX_BYTES / 1024} KB limit; the file is ignored (${pathValue})`,
          });
        } else {
          try {
            const content = (await readFile(resolved, 'utf8')).replace(/^\uFEFF/, '').trim();
            if (content.length > 0) parts.push(content);
          } catch (error) {
            diagnostics.push({
              severity: 'warn',
              message: `Failed to read "systemPromptPath" (${pathValue}): ${(error as Error).message}`,
            });
          }
        }
      }
    }
  }

  return parts.length === 0 ? undefined : parts.join('\n\n');
}

function readHooks(
  raw: unknown,
  diagnostics: PluginDiagnostic[],
): readonly HookDefConfig[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    diagnostics.push({ severity: 'warn', message: '"hooks" must be an array' });
    return undefined;
  }
  const out: HookDefConfig[] = [];
  raw.forEach((entry, i) => {
    const parsed = HookDefSchema.safeParse(entry);
    if (!parsed.success) {
      diagnostics.push({
        severity: 'warn',
        message: `Invalid hook at index ${i}: ${parsed.error.message}`,
      });
    } else {
      out.push(parsed.data);
    }
  });
  return out.length === 0 ? undefined : out;
}

function readAuthor(raw: unknown): PluginManifest['author'] {
  if (typeof raw === 'string') return { name: raw };
  if (!isObject(raw)) return undefined;
  const name = stringField(raw, 'name');
  const email = stringField(raw, 'email');
  if (name === undefined && email === undefined) return undefined;
  return { name, email };
}

function readInterface(raw: unknown): PluginInterface | undefined {
  if (!isObject(raw)) return undefined;
  const out: PluginInterface = {
    displayName: stringField(raw, 'displayName'),
    shortDescription: stringField(raw, 'shortDescription'),
    longDescription: stringField(raw, 'longDescription'),
    developerName: stringField(raw, 'developerName'),
    websiteURL: stringField(raw, 'websiteURL'),
  };
  const hasAny = Object.values(out).some((value) => value !== undefined);
  return hasAny ? out : undefined;
}
