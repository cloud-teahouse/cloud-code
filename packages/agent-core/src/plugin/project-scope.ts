import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Project-scope plugin enable overrides, stored at
 * `<projectRoot>/.cloud-code/plugins.json`.
 *
 * The install-level enable flag (`plugins/installed.json`, user-global) stays
 * the default; a project override wins for sessions whose workDir resolves to
 * that project root. This mirrors Claude Code's per-scope `enabledPlugins`
 * (user vs project settings) with the two scopes our settings model has.
 */

const PROJECT_PLUGINS_REL = path.join('.cloud-code', 'plugins.json');

interface ProjectPluginsFile {
  readonly version: 1;
  readonly overrides: Readonly<Record<string, { readonly enabled: boolean }>>;
}

/**
 * Per-project enable scope resolved once per session build and threaded
 * through the PluginManager component queries.
 */
export interface PluginEnableScope {
  readonly projectRoot?: string;
  /** plugin id → project-level enabled override. */
  readonly overrides?: ReadonlyMap<string, boolean>;
}

export function isPluginEnabledInScope(
  enabled: boolean,
  id: string,
  scope?: PluginEnableScope,
): boolean {
  return scope?.overrides?.get(id) ?? enabled;
}

/**
 * Walk up from `workDir` looking for a `.git` entry; fall back to `workDir`
 * itself outside any repository (same rule as the skill scanner).
 */
export async function findProjectRoot(workDir: string): Promise<string> {
  const start = path.resolve(workDir);
  let current = start;
  while (true) {
    if (await exists(path.join(current, '.git'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return start;
    current = parent;
  }
}

export function projectPluginsFilePath(projectRoot: string): string {
  return path.join(projectRoot, PROJECT_PLUGINS_REL);
}

export async function readProjectPluginOverrides(
  projectRoot: string,
): Promise<Map<string, boolean>> {
  let text: string;
  try {
    text = await readFile(projectPluginsFilePath(projectRoot), 'utf8');
  } catch {
    // A missing/unreadable file means no overrides — the common case.
    return new Map();
  }
  try {
    const parsed = JSON.parse(text) as ProjectPluginsFile;
    if (typeof parsed !== 'object' || parsed === null || typeof parsed.overrides !== 'object') {
      return new Map();
    }
    const out = new Map<string, boolean>();
    for (const [id, entry] of Object.entries(parsed.overrides)) {
      if (typeof entry === 'object' && entry !== null && typeof entry.enabled === 'boolean') {
        out.set(id, entry.enabled);
      }
    }
    return out;
  } catch {
    return new Map();
  }
}

/**
 * Set (or clear, with `enabled === undefined`) a project-level override.
 * Writes atomically (tmp + rename) like the installed.json store.
 */
export async function writeProjectPluginOverride(
  projectRoot: string,
  id: string,
  enabled: boolean | undefined,
): Promise<void> {
  const current = await readProjectPluginOverrides(projectRoot);
  if (enabled === undefined) {
    current.delete(id);
  } else {
    current.set(id, enabled);
  }
  const data: ProjectPluginsFile = {
    version: 1,
    overrides: Object.fromEntries([...current.entries()].map(([key, value]) => [key, { enabled: value }])),
  };
  const filePath = projectPluginsFilePath(projectRoot);
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await rename(tmp, filePath);
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}
