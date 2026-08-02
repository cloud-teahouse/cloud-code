import { readdir, readFile } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { basename, join } from 'pathe';

import { z } from 'zod';

import type { Logger } from '../logging';
import { parseFrontmatter } from '../skill/parser';
import type { RawAgentProfile } from './types';

const MARKDOWN_EXTENSION = '.md';

// First version of the file-based agent format: name/description/tools/model
// only. Advanced fields (hooks, permissionMode, mcpServers, isolation) are
// intentionally stripped by the schema until a later batch wires them up.
const CustomAgentFrontmatterSchema = z.object({
  name: z.string().trim().min(1).optional(),
  description: z.string().trim().min(1),
  // Comma-separated tool whitelist (Claude-Code compatible); omitted tools
  // inherit the root `agent` profile's tool set.
  tools: z.string().trim().min(1).optional(),
  model: z.string().trim().min(1).optional(),
});

export interface PluginAgentDirInput {
  /** Owning plugin id; agent names are namespaced as `pluginId:agentName`. */
  readonly pluginId: string;
  /** Absolute path of the plugin's agents directory. */
  readonly path: string;
}

export interface LoadCustomAgentProfilesOptions {
  /** User-level agents dir (`<brandHome>/agents`, CLOUD_CODE_HOME-aware). */
  readonly userDir?: string | undefined;
  /** Project-level agents dir (`<workspace>/.cloud-code/agents`). */
  readonly projectDir?: string | undefined;
  /**
   * Plugin-provided agents dirs — the third source, loaded last. Entries are
   * namespaced (`pluginId:name`) at parse time, so they can never shadow a
   * builtin profile or a user/project agent; the `reservedNames` guard does
   * not apply to them.
   */
  readonly pluginDirs?: readonly PluginAgentDirInput[] | undefined;
  /** Builtin profile names custom agents are not allowed to shadow. */
  readonly reservedNames?: ReadonlySet<string> | undefined;
  readonly log?: Logger | undefined;
}

/**
 * Load file-based custom agent definitions from the user-level and
 * project-level agents directories. Project-level definitions override
 * user-level ones with the same name; neither may shadow a builtin profile
 * (`reservedNames`). Invalid files (bad YAML, missing `description`) are
 * skipped with a warning so a broken definition never breaks the session.
 *
 * Each returned raw profile extends the root `agent` profile: the markdown
 * body lands in the `roleAdditional` prompt var, slotting into the base
 * system prompt template's ROLE_ADDITIONAL placeholder.
 */
export async function loadCustomAgentProfiles(
  options: LoadCustomAgentProfilesOptions,
): Promise<RawAgentProfile[]> {
  const byName = new Map<string, RawAgentProfile>();
  // Lower precedence first so project-level entries overwrite user-level ones.
  for (const dir of [options.userDir, options.projectDir]) {
    if (dir === undefined) continue;
    for (const filePath of await listMarkdownFiles(dir, options.log)) {
      const raw = await parseCustomAgentFile(filePath, options.log);
      if (raw === undefined) continue;
      if (options.reservedNames?.has(raw.name) === true) {
        options.log?.warn('Skipping custom agent that shadows a builtin profile', {
          path: filePath,
          name: raw.name,
        });
        continue;
      }
      byName.set(raw.name, raw);
    }
  }
  // Plugin source: namespaced at load time (`pluginId:name`), so collisions
  // with user/project/builtin names are impossible by construction. Between
  // two dirs of the same plugin the later one wins, matching the user→project
  // precedence convention.
  for (const dir of options.pluginDirs ?? []) {
    for (const filePath of await listMarkdownFiles(dir.path, options.log)) {
      const raw = await parseCustomAgentFile(filePath, options.log);
      if (raw === undefined) continue;
      const namespaced: RawAgentProfile = { ...raw, name: `${dir.pluginId}:${raw.name}` };
      byName.set(namespaced.name, namespaced);
    }
  }
  return [...byName.values()];
}

async function listMarkdownFiles(dir: string, log?: Logger): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    // A missing agents dir is the common case — nothing to load.
    if (isFsError(error, 'ENOENT') || isFsError(error, 'ENOTDIR')) return [];
    log?.warn('Failed to list custom agent definitions', { dir, error: errorMessage(error) });
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(MARKDOWN_EXTENSION))
    .map((entry) => join(dir, entry.name))
    .toSorted();
}

async function parseCustomAgentFile(
  filePath: string,
  log?: Logger,
): Promise<RawAgentProfile | undefined> {
  let text: string;
  try {
    text = await readFile(filePath, 'utf-8');
  } catch (error) {
    log?.warn('Failed to read custom agent definition', {
      path: filePath,
      error: errorMessage(error),
    });
    return undefined;
  }

  let data: unknown;
  let body: string;
  try {
    ({ data, body } = parseFrontmatter(text));
  } catch (error) {
    log?.warn('Skipping custom agent with invalid frontmatter', {
      path: filePath,
      error: errorMessage(error),
    });
    return undefined;
  }

  const parsed = CustomAgentFrontmatterSchema.safeParse(data ?? {});
  if (!parsed.success) {
    log?.warn('Skipping invalid custom agent definition', {
      path: filePath,
      error: parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
        .join('; '),
    });
    return undefined;
  }

  const name = parsed.data.name ?? basename(filePath, MARKDOWN_EXTENSION);
  if (name === '') {
    log?.warn('Skipping custom agent with an empty name', { path: filePath });
    return undefined;
  }

  const tools = parsed.data.tools
    ?.split(',')
    .map((tool) => tool.trim())
    .filter((tool) => tool.length > 0);
  const roleAdditional = body.trim();
  return {
    extends: 'agent',
    name,
    description: parsed.data.description,
    model: parsed.data.model,
    tools: tools !== undefined && tools.length > 0 ? tools : undefined,
    promptVars: roleAdditional === '' ? undefined : { roleAdditional },
  };
}

function isFsError(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as Record<string, unknown>)['code'] === code
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
