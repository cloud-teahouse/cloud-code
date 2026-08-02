import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';

import {
  loadPluginMarketplace,
  resolveLocalPath,
  type PluginMarketplace,
} from './plugin-marketplace';
import {
  marketplaceCacheDir,
  type MarketplaceSourceKind,
  type PluginMarketplaceRegistration,
} from './plugin-marketplace-registry';

/**
 * Typed marketplace sources and catalog materialization.
 *
 * A marketplace registration points at one of four source kinds (Claude Code
 * parity, minus the npm source the plugin manager cannot install anyway):
 *
 *   url    — a remote marketplace.json fetched on every browse
 *   git    — a git repository cloned once into the cache dir, refreshed on demand
 *   github — owner/repo shorthand; cloned like git from github.com
 *   local  — a marketplace.json file or a directory containing one
 *
 * Git-backed marketplaces live at `<dataDir>/plugins/marketplaces/<name>/` so
 * relative plugin sources inside the manifest resolve against the checkout.
 * The manifest itself is `.claude-plugin/marketplace.json` (Claude Code
 * layout) or `marketplace.json` at the root (kimi-market layout).
 */

export interface ParsedMarketplaceSource {
  readonly kind: MarketplaceSourceKind;
  /** Canonical string persisted in the registry and shown to the user. */
  readonly source: string;
  readonly ref?: string;
}

const SSH_SOURCE_REGEX = /^([a-zA-Z0-9._-]+@[^:]+:.+?)(?:#(.+))?$/;
const GITHUB_SHORTHAND_REGEX = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_./-]+$/;
const GIT_CLONE_TIMEOUT_MS = 120_000;

const execFileAsync = promisify(execFile);

/**
 * Parse a marketplace source string into its typed form. Mirrors Claude
 * Code's parseMarketplaceInput for the supported kinds: SSH git URLs,
 * http(s) git URLs (`.git` suffix or `/_git/` path), bare GitHub repo URLs,
 * `owner/repo` shorthand (with an optional `#ref`/`@ref`), and local paths.
 * Throws with actionable guidance when the shape is not recognized.
 */
export function parseMarketplaceSourceInput(input: string, workDir: string): ParsedMarketplaceSource {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    throw new Error('Marketplace source cannot be empty.');
  }

  const ssh = SSH_SOURCE_REGEX.exec(trimmed);
  if (ssh !== null) {
    return gitSource(ssh[1]!, ssh[2]);
  }

  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    const fragment = /^(.*?)(?:#(.+))?$/.exec(trimmed);
    const withoutRef = fragment?.[1] ?? trimmed;
    const ref = fragment?.[2];
    if (withoutRef.endsWith('.git') || withoutRef.includes('/_git/')) {
      return gitSource(withoutRef, ref);
    }
    const github = parseGithubRepoUrl(withoutRef);
    if (github !== undefined) {
      return { kind: 'github', source: github, ...(ref !== undefined ? { ref } : {}) };
    }
    return { kind: 'url', source: withoutRef };
  }

  if (isLocalPathInput(trimmed)) {
    return { kind: 'local', source: resolveLocalPath(trimmed, workDir) };
  }

  if (!trimmed.includes(':')) {
    const shorthand = /^([^#@]+?)(?:[#@](.+))?$/.exec(trimmed);
    const repo = shorthand?.[1] ?? trimmed;
    if (GITHUB_SHORTHAND_REGEX.test(repo)) {
      const ref = shorthand?.[2];
      return { kind: 'github', source: `https://github.com/${repo}`, ...(ref !== undefined ? { ref } : {}) };
    }
  }

  throw new Error(
    `Unrecognized marketplace source "${input}". ` +
      'Try owner/repo, a git URL, a marketplace.json URL, or a local path.',
  );
}

function gitSource(url: string, ref: string | undefined): ParsedMarketplaceSource {
  return { kind: 'git', source: url, ...(ref !== undefined ? { ref } : {}) };
}

/** Canonical `https://github.com/<owner>/<repo>` for bare repo URLs; undefined otherwise. */
function parseGithubRepoUrl(raw: string): string | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.hostname !== 'github.com' && url.hostname !== 'www.github.com') return undefined;
  const segments = url.pathname.split('/').filter((segment) => segment.length > 0);
  if (segments.length !== 2) return undefined;
  const repo = segments[1]!.endsWith('.git') ? segments[1]!.slice(0, -'.git'.length) : segments[1]!;
  return `https://github.com/${segments[0]!}/${repo}`;
}

function isLocalPathInput(input: string): boolean {
  return (
    input.startsWith('/') ||
    input.startsWith('./') ||
    input.startsWith('../') ||
    input === '.' ||
    input === '..' ||
    input === '~' ||
    input.startsWith('~/')
  );
}

/**
 * Name suggestion for the add wizard: the repository/directory basename, or
 * the second-level domain label for URL sources, sanitized to the registry's
 * kebab-case name shape. Falls back to `marketplace`.
 */
export function suggestMarketplaceName(parsed: ParsedMarketplaceSource): string {
  let base = '';
  if (parsed.kind === 'local') {
    base = basename(parsed.source).replace(/\.json$/i, '');
  } else if (parsed.kind === 'url') {
    try {
      const parts = new URL(parsed.source).hostname.split('.').filter(Boolean);
      base = parts.length >= 2 ? parts[parts.length - 2]! : (parts[0] ?? '');
    } catch {
      base = '';
    }
  } else {
    base = basename(parsed.source).replace(/\.git$/i, '');
  }
  const cleaned = base
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/-+$/, '');
  return /^[a-z0-9]/.test(cleaned) ? cleaned : 'marketplace';
}

export interface LoadMarketplaceCatalogOptions {
  readonly workDir: string;
  readonly dataDir?: string;
  readonly fetchImpl?: typeof fetch;
}

/**
 * Load the catalog of a registered (or ad-hoc parsed) marketplace. Git-backed
 * sources are cloned on first use; url and local sources are read live. The
 * returned marketplace reports the registration's source string (not the
 * clone path) so the panel footer stays meaningful.
 */
export async function loadMarketplaceCatalogForSource(
  parsed: ParsedMarketplaceSource,
  options: LoadMarketplaceCatalogOptions & { readonly name?: string },
): Promise<PluginMarketplace> {
  const manifest = await resolveManifestLocation(parsed, options);
  const catalog = await loadPluginMarketplace({
    workDir: options.workDir,
    source: manifest,
    ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
  });
  return { ...catalog, source: parsed.source };
}

export async function loadCatalogForRegistration(
  registration: PluginMarketplaceRegistration,
  options: LoadMarketplaceCatalogOptions,
): Promise<PluginMarketplace> {
  return loadMarketplaceCatalogForSource(
    {
      kind: registration.sourceKind,
      source: registration.source,
      ...(registration.ref !== undefined ? { ref: registration.ref } : {}),
    },
    { ...options, name: registration.name },
  );
}

/**
 * Refresh a marketplace's catalog: git-backed sources are re-cloned (staging
 * swap, so a failed refresh keeps the previous checkout), url/local sources
 * are simply re-read. Returns the fresh catalog, validating the manifest.
 */
export async function refreshMarketplaceCatalog(
  registration: PluginMarketplaceRegistration,
  options: LoadMarketplaceCatalogOptions,
): Promise<PluginMarketplace> {
  if (registration.sourceKind === 'git' || registration.sourceKind === 'github') {
    await cloneGitMarketplace(
      registration.source,
      registration.ref,
      marketplaceCacheDir(registration.name, options.dataDir),
    );
  }
  return loadCatalogForRegistration(registration, options);
}

/** Delete the cached clone of a git-backed marketplace (no-op for others). */
export async function removeMarketplaceClone(
  name: string,
  kind: MarketplaceSourceKind,
  dataDir?: string,
): Promise<void> {
  if (kind !== 'git' && kind !== 'github') return;
  await rm(marketplaceCacheDir(name, dataDir), { recursive: true, force: true });
}

/**
 * Materialize a marketplace source for validation during `add`, before the
 * registration exists. Git-backed sources are cloned into their final cache
 * location (the clone is kept on success; the caller removes it when the
 * registration is aborted).
 */
export async function materializeMarketplaceSource(
  name: string,
  parsed: ParsedMarketplaceSource,
  options: LoadMarketplaceCatalogOptions,
): Promise<PluginMarketplace> {
  if (parsed.kind === 'git' || parsed.kind === 'github') {
    await cloneGitMarketplace(parsed.source, parsed.ref, marketplaceCacheDir(name, options.dataDir));
  }
  return loadMarketplaceCatalogForSource(parsed, { ...options, name });
}

/** Resolve the manifest path/URL the catalog loader should read. */
async function resolveManifestLocation(
  parsed: ParsedMarketplaceSource,
  options: LoadMarketplaceCatalogOptions & { readonly name?: string },
): Promise<string> {
  if (parsed.kind === 'url') return parsed.source;
  if (parsed.kind === 'git' || parsed.kind === 'github') {
    if (options.name === undefined) {
      throw new Error('A marketplace name is required for git sources.');
    }
    const cloneDir = marketplaceCacheDir(options.name, options.dataDir);
    if (!(await isDirectory(cloneDir))) {
      await cloneGitMarketplace(parsed.source, parsed.ref, cloneDir);
    }
    return findManifestInDirectory(cloneDir);
  }
  // local: a manifest file directly, or a directory holding one.
  if (await isDirectory(parsed.source)) {
    return findManifestInDirectory(parsed.source);
  }
  if ((await stat(parsed.source).catch(() => undefined))?.isFile() === true) {
    return parsed.source;
  }
  throw new Error(`Marketplace path does not exist: ${parsed.source}`);
}

/** Claude Code layout first (`.claude-plugin/`), then the kimi-market root file. */
async function findManifestInDirectory(dir: string): Promise<string> {
  const candidates = [
    join(dir, '.claude-plugin', 'marketplace.json'),
    join(dir, 'marketplace.json'),
  ];
  for (const candidate of candidates) {
    if ((await stat(candidate).catch(() => undefined))?.isFile() === true) return candidate;
  }
  throw new Error(
    `No marketplace manifest found in ${dir} (expected .claude-plugin/marketplace.json or marketplace.json).`,
  );
}

async function isDirectory(path: string): Promise<boolean> {
  return (await stat(path).catch(() => undefined))?.isDirectory() === true;
}

/**
 * `git clone --depth 1` into a staging sibling, then swap over the target —
 * a failed or interrupted clone never leaves a half-written cache behind.
 * Prompts are disabled so a private repo fails fast instead of hanging.
 */
async function cloneGitMarketplace(
  url: string,
  ref: string | undefined,
  destDir: string,
): Promise<void> {
  const parent = dirname(destDir);
  await mkdir(parent, { recursive: true });
  // mkdtemp yields an empty directory, which git accepts as a clone target.
  const staging = await mkdtemp(join(parent, `.${basename(destDir)}-clone-`));
  try {
    await execFileAsync(
      'git',
      [
        'clone',
        '--depth',
        '1',
        ...(ref !== undefined ? ['--branch', ref] : []),
        '--',
        url,
        staging,
      ],
      {
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        timeout: GIT_CLONE_TIMEOUT_MS,
      },
    );
    await rm(destDir, { recursive: true, force: true });
    await rename(staging, destDir);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to clone marketplace repository ${url}: ${detail}`, { cause: error });
  }
}
