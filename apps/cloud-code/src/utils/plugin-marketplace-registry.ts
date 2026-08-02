import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { CLOUD_CODE_PLUGIN_MARKETPLACE_URL } from '#/constant/app';
import { getDataDir } from './paths';

/**
 * Named plugin marketplace registry, persisted at
 * `<dataDir>/plugins/marketplaces.json`.
 *
 * Claude Code parity: `/plugins marketplace add/remove/list` manages named
 * marketplaces; `/plugins marketplace <name>` browses a registered one. The
 * default catalog (code.kimi.com CDN) is always present as the reserved
 * `official` entry and is never written to the file.
 *
 * Each registration carries a typed source (`url` manifest, `git`/`github`
 * repository cloned on add, or a `local` file/directory) so browsing and
 * refreshing do not have to re-guess how to read the catalog. Entries written
 * before source kinds existed only have the `source` string; their kind is
 * inferred from its shape on read.
 */

export const OFFICIAL_MARKETPLACE_NAME = 'official';

export type MarketplaceSourceKind = 'url' | 'git' | 'github' | 'local';

export interface PluginMarketplaceRegistration {
  readonly name: string;
  /** Canonical source string: the URL for url/git/github kinds, an absolute
   * path for local. This is what list/browse surfaces to the user. */
  readonly source: string;
  readonly sourceKind: MarketplaceSourceKind;
  /** Optional git ref (branch/tag) for git and github sources. */
  readonly ref?: string;
  readonly addedAt: string;
  /** True for the implicit default catalog — cannot be removed or overwritten. */
  readonly builtin?: boolean;
}

interface MarketplacesFile {
  readonly version: 1;
  readonly marketplaces: readonly PluginMarketplaceRegistration[];
}

const MARKETPLACE_NAME_REGEX = /^[a-z0-9][a-z0-9_-]{0,63}$/;

// "official" is the implicit default catalog; "builtin" is reserved like in
// Claude Code (its built-in plugins live outside marketplaces).
const RESERVED_MARKETPLACE_NAMES = new Set([OFFICIAL_MARKETPLACE_NAME, 'builtin']);

const SOURCE_KINDS: readonly MarketplaceSourceKind[] = ['url', 'git', 'github', 'local'];

export function isValidMarketplaceName(name: string): boolean {
  return MARKETPLACE_NAME_REGEX.test(name) && !RESERVED_MARKETPLACE_NAMES.has(name);
}

export function marketplacesFilePath(dataDir: string = getDataDir()): string {
  return join(dataDir, 'plugins', 'marketplaces.json');
}

/** Where a git/github marketplace is cloned: `<dataDir>/plugins/marketplaces/<name>/`. */
export function marketplaceCacheDir(name: string, dataDir: string = getDataDir()): string {
  return join(dataDir, 'plugins', 'marketplaces', name);
}

export async function listMarketplaces(
  dataDir: string = getDataDir(),
): Promise<readonly PluginMarketplaceRegistration[]> {
  const official: PluginMarketplaceRegistration = {
    name: OFFICIAL_MARKETPLACE_NAME,
    source: CLOUD_CODE_PLUGIN_MARKETPLACE_URL,
    sourceKind: 'url',
    addedAt: '',
    builtin: true,
  };
  return [official, ...(await readMarketplacesFile(dataDir)).marketplaces];
}

export async function getMarketplace(
  name: string,
  dataDir: string = getDataDir(),
): Promise<PluginMarketplaceRegistration | undefined> {
  const all = await listMarketplaces(dataDir);
  return all.find((entry) => entry.name === name);
}

export interface MarketplaceSourceInput {
  readonly source: string;
  readonly sourceKind: MarketplaceSourceKind;
  readonly ref?: string;
}

/**
 * Register a marketplace. Accepts either a fully parsed source (from
 * `parseMarketplaceSourceInput`) or a bare source string, whose kind is
 * inferred (http(s) → url, anything else → local) for back-compat with the
 * pre-typed-sources registry.
 */
export async function addMarketplace(
  name: string,
  source: string | MarketplaceSourceInput,
  dataDir: string = getDataDir(),
): Promise<PluginMarketplaceRegistration> {
  const trimmedName = name.trim();
  const input: MarketplaceSourceInput =
    typeof source === 'string'
      ? inferSourceKind(source.trim())
      : { ...source, source: source.source.trim() };
  if (!MARKETPLACE_NAME_REGEX.test(trimmedName)) {
    throw new Error(
      `Marketplace name "${name}" must match ${MARKETPLACE_NAME_REGEX} (kebab-case).`,
    );
  }
  if (RESERVED_MARKETPLACE_NAMES.has(trimmedName)) {
    throw new Error(`Marketplace name "${trimmedName}" is reserved.`);
  }
  if (input.source.length === 0) {
    throw new Error('Marketplace source cannot be empty.');
  }
  const file = await readMarketplacesFile(dataDir);
  if (file.marketplaces.some((entry) => entry.name === trimmedName)) {
    throw new Error(`Marketplace "${trimmedName}" already exists.`);
  }
  const entry: PluginMarketplaceRegistration = {
    name: trimmedName,
    source: input.source,
    sourceKind: input.sourceKind,
    ...(input.ref !== undefined ? { ref: input.ref } : {}),
    addedAt: new Date().toISOString(),
  };
  await writeMarketplacesFile(dataDir, {
    version: 1,
    marketplaces: [...file.marketplaces, entry],
  });
  return entry;
}

export async function removeMarketplace(
  name: string,
  dataDir: string = getDataDir(),
): Promise<void> {
  const trimmedName = name.trim();
  if (RESERVED_MARKETPLACE_NAMES.has(trimmedName)) {
    throw new Error(`Marketplace name "${trimmedName}" is reserved and cannot be removed.`);
  }
  const file = await readMarketplacesFile(dataDir);
  const next = file.marketplaces.filter((entry) => entry.name !== trimmedName);
  if (next.length === file.marketplaces.length) {
    throw new Error(`Marketplace "${trimmedName}" is not registered.`);
  }
  await writeMarketplacesFile(dataDir, { version: 1, marketplaces: next });
}

/**
 * Resolve a `/plugins marketplace <arg>` argument: a registered name wins;
 * anything else is treated as a marketplace source (URL or path) directly,
 * preserving the pre-registry behavior.
 */
export async function resolveMarketplaceArg(
  arg: string,
  dataDir: string = getDataDir(),
): Promise<string> {
  const registered = await getMarketplace(arg.trim(), dataDir);
  return registered?.source ?? arg.trim();
}

/** Kind inference for legacy registrations that predate typed sources. */
function inferSourceKind(source: string): MarketplaceSourceInput {
  if (source.startsWith('http://') || source.startsWith('https://')) {
    return { source, sourceKind: 'url' };
  }
  return { source, sourceKind: 'local' };
}

async function readMarketplacesFile(dataDir: string): Promise<MarketplacesFile> {
  let text: string;
  try {
    text = await readFile(marketplacesFilePath(dataDir), 'utf8');
  } catch {
    return { version: 1, marketplaces: [] };
  }
  try {
    const parsed = JSON.parse(text) as MarketplacesFile;
    if (typeof parsed !== 'object' || parsed === null || !Array.isArray(parsed.marketplaces)) {
      return { version: 1, marketplaces: [] };
    }
    const marketplaces = parsed.marketplaces.flatMap((entry) => normalizeEntry(entry));
    return { version: 1, marketplaces };
  } catch {
    return { version: 1, marketplaces: [] };
  }
}

/** Tolerate legacy entries (no sourceKind) and skip malformed ones. */
function normalizeEntry(entry: unknown): PluginMarketplaceRegistration[] {
  if (typeof entry !== 'object' || entry === null) return [];
  const record = entry as Record<string, unknown>;
  if (typeof record['name'] !== 'string' || typeof record['source'] !== 'string') return [];
  const inferred = inferSourceKind(record['source']);
  const sourceKind =
    typeof record['sourceKind'] === 'string' &&
    (SOURCE_KINDS as readonly string[]).includes(record['sourceKind'])
      ? (record['sourceKind'] as MarketplaceSourceKind)
      : inferred.sourceKind;
  return [
    {
      ...(entry as PluginMarketplaceRegistration),
      sourceKind,
    },
  ];
}

async function writeMarketplacesFile(dataDir: string, data: MarketplacesFile): Promise<void> {
  const filePath = marketplacesFilePath(dataDir);
  await mkdir(join(dataDir, 'plugins'), { recursive: true });
  const tmp = `${filePath}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await rename(tmp, filePath);
}
