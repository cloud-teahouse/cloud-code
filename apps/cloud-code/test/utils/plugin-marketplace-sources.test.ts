import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { marketplaceCacheDir } from '#/utils/plugin-marketplace-registry';
import {
  loadMarketplaceCatalogForSource,
  materializeMarketplaceSource,
  parseMarketplaceSourceInput,
  refreshMarketplaceCatalog,
  removeMarketplaceClone,
  suggestMarketplaceName,
  type ParsedMarketplaceSource,
} from '#/utils/plugin-marketplace-sources';

const execFileAsync = promisify(execFile);

const tempDirs: string[] = [];

async function makeTmp(prefix = 'marketplace-sources-test-'): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function git(args: readonly string[], cwd: string): Promise<void> {
  await execFileAsync('git', [...args], { cwd });
}

/** A real git repository (offline: cloned from its path) holding `files`. */
async function makeGitRepo(files: Record<string, string>): Promise<string> {
  const dir = await makeTmp('marketplace-repo-');
  await git(['init'], dir);
  for (const [name, content] of Object.entries(files)) {
    const filePath = join(dir, name);
    await mkdir(join(filePath, '..'), { recursive: true });
    await writeFile(filePath, content, 'utf8');
  }
  await git(['add', '.'], dir);
  await git(['-c', 'user.email=test@test', '-c', 'user.name=test', 'commit', '-m', 'init'], dir);
  return dir;
}

const KIMI_MARKET_MANIFEST = JSON.stringify({
  version: '1',
  plugins: [
    {
      id: 'demo',
      displayName: 'Demo',
      version: '1.0.0',
      source: './plugins/demo',
    },
  ],
});

describe('parseMarketplaceSourceInput', () => {
  it('parses GitHub shorthand with optional refs', () => {
    expect(parseMarketplaceSourceInput('owner/repo', '/work')).toEqual({
      kind: 'github',
      source: 'https://github.com/owner/repo',
    });
    expect(parseMarketplaceSourceInput('owner/repo#v1.2.3', '/work')).toEqual({
      kind: 'github',
      source: 'https://github.com/owner/repo',
      ref: 'v1.2.3',
    });
    expect(parseMarketplaceSourceInput('owner/repo@main', '/work')).toEqual({
      kind: 'github',
      source: 'https://github.com/owner/repo',
      ref: 'main',
    });
  });

  it('parses SSH git URLs with optional refs', () => {
    expect(parseMarketplaceSourceInput('git@github.com:owner/repo.git', '/work')).toEqual({
      kind: 'git',
      source: 'git@github.com:owner/repo.git',
    });
    expect(parseMarketplaceSourceInput('deploy@gitlab.com:group/proj.git#dev', '/work')).toEqual({
      kind: 'git',
      source: 'deploy@gitlab.com:group/proj.git',
      ref: 'dev',
    });
  });

  it('parses http(s) sources: .git and /_git/ clone, bare GitHub repo normalizes, the rest is a manifest URL', () => {
    expect(parseMarketplaceSourceInput('https://github.com/owner/repo.git', '/work')).toEqual({
      kind: 'git',
      source: 'https://github.com/owner/repo.git',
    });
    expect(
      parseMarketplaceSourceInput('https://dev.azure.com/org/proj/_git/repo#main', '/work'),
    ).toEqual({
      kind: 'git',
      source: 'https://dev.azure.com/org/proj/_git/repo',
      ref: 'main',
    });
    expect(parseMarketplaceSourceInput('https://github.com/owner/repo', '/work')).toEqual({
      kind: 'github',
      source: 'https://github.com/owner/repo',
    });
    expect(parseMarketplaceSourceInput('https://github.com/owner/repo#v2', '/work')).toEqual({
      kind: 'github',
      source: 'https://github.com/owner/repo',
      ref: 'v2',
    });
    expect(parseMarketplaceSourceInput('https://example.com/marketplace.json', '/work')).toEqual({
      kind: 'url',
      source: 'https://example.com/marketplace.json',
    });
    // A fragment on a plain manifest URL is dropped (refs only apply to git).
    expect(parseMarketplaceSourceInput('https://example.com/m.json#v1', '/work')).toEqual({
      kind: 'url',
      source: 'https://example.com/m.json',
    });
  });

  it('parses local paths and resolves them against workDir/home', () => {
    expect(parseMarketplaceSourceInput('./mkt', '/work')).toEqual({
      kind: 'local',
      source: '/work/mkt',
    });
    expect(parseMarketplaceSourceInput('/abs/path', '/work')).toEqual({
      kind: 'local',
      source: '/abs/path',
    });
    const homeTilde = parseMarketplaceSourceInput('~/mkt', '/work');
    expect(homeTilde.kind).toBe('local');
    expect(homeTilde.source).not.toContain('~');
  });

  it('rejects empty and unrecognized input with guidance', () => {
    expect(() => parseMarketplaceSourceInput('   ', '/work')).toThrow('cannot be empty');
    expect(() => parseMarketplaceSourceInput('noslash', '/work')).toThrow(
      /Unrecognized marketplace source.*owner\/repo/s,
    );
  });
});

describe('suggestMarketplaceName', () => {
  it('derives kebab-case names from each source kind', () => {
    expect(
      suggestMarketplaceName({ kind: 'github', source: 'https://github.com/acme/Kimi_Plugins' }),
    ).toBe('kimi-plugins');
    expect(suggestMarketplaceName({ kind: 'git', source: 'git@x.com:team/monorepo.git' })).toBe(
      'monorepo',
    );
    expect(
      suggestMarketplaceName({ kind: 'url', source: 'https://plugins.example.com/m.json' }),
    ).toBe('example');
    expect(suggestMarketplaceName({ kind: 'local', source: '/opt/my-marketplace.json' })).toBe(
      'my-marketplace',
    );
  });

  it('falls back to "marketplace" when nothing usable remains', () => {
    expect(suggestMarketplaceName({ kind: 'url', source: 'not a url' })).toBe('marketplace');
  });
});

describe('git-backed marketplaces', () => {
  function gitSource(repoDir: string): ParsedMarketplaceSource {
    return { kind: 'git', source: repoDir };
  }

  it('clones on add and resolves relative plugin sources inside the clone', async () => {
    const repoDir = await makeGitRepo({ 'marketplace.json': KIMI_MARKET_MANIFEST });
    const dataDir = await makeTmp();
    const catalog = await materializeMarketplaceSource('acme', gitSource(repoDir), {
      workDir: '/work',
      dataDir,
    });
    expect(catalog.plugins).toHaveLength(1);
    expect(catalog.plugins[0]).toMatchObject({
      id: 'demo',
      source: join(marketplaceCacheDir('acme', dataDir), 'plugins', 'demo'),
    });
    // The registration's source string (not the clone path) is reported.
    expect(catalog.source).toBe(repoDir);
  });

  it('reads Claude Code layout manifests and resolves sources against the marketplace root', async () => {
    const repoDir = await makeGitRepo({
      '.claude-plugin/marketplace.json': JSON.stringify({
        name: 'acme-cc',
        owner: { name: 'Acme' },
        plugins: [{ name: 'cc-plugin', version: '1.0.0', source: './tools/cc-plugin' }],
      }),
    });
    const dataDir = await makeTmp();
    const catalog = await materializeMarketplaceSource('acme', gitSource(repoDir), {
      workDir: '/work',
      dataDir,
    });
    expect(catalog.name).toBe('acme-cc');
    // CC semantics: relative to the repo root, not to .claude-plugin/.
    expect(catalog.plugins[0]).toMatchObject({
      id: 'cc-plugin',
      source: join(marketplaceCacheDir('acme', dataDir), 'tools', 'cc-plugin'),
    });
  });

  it('clones lazily on first browse when the cache is missing', async () => {
    const repoDir = await makeGitRepo({ 'marketplace.json': KIMI_MARKET_MANIFEST });
    const dataDir = await makeTmp();
    const catalog = await loadMarketplaceCatalogForSource(gitSource(repoDir), {
      workDir: '/work',
      dataDir,
      name: 'lazy',
    });
    expect(catalog.plugins).toHaveLength(1);
    expect((await stat(marketplaceCacheDir('lazy', dataDir))).isDirectory()).toBe(true);
  });

  it('refresh re-clones and picks up new manifest content', async () => {
    const repoDir = await makeGitRepo({ 'marketplace.json': KIMI_MARKET_MANIFEST });
    const dataDir = await makeTmp();
    const registration = {
      name: 'acme',
      source: repoDir,
      sourceKind: 'git' as const,
      addedAt: '',
    };
    const before = await refreshMarketplaceCatalog(registration, { workDir: '/work', dataDir });
    expect(before.plugins).toHaveLength(1);

    const updated = JSON.parse(KIMI_MARKET_MANIFEST) as { plugins: unknown[] };
    updated.plugins.push({
      id: 'second',
      displayName: 'Second',
      version: '2.0.0',
      source: './plugins/second',
    });
    await writeFile(join(repoDir, 'marketplace.json'), JSON.stringify(updated), 'utf8');
    await git(['add', '.'], repoDir);
    await git(
      ['-c', 'user.email=test@test', '-c', 'user.name=test', 'commit', '-m', 'second'],
      repoDir,
    );

    const after = await refreshMarketplaceCatalog(registration, { workDir: '/work', dataDir });
    expect(after.plugins.map((entry) => entry.id)).toEqual(['demo', 'second']);
  });

  it('removeMarketplaceClone deletes the cache for git kinds only', async () => {
    const repoDir = await makeGitRepo({ 'marketplace.json': KIMI_MARKET_MANIFEST });
    const dataDir = await makeTmp();
    await materializeMarketplaceSource('acme', gitSource(repoDir), {
      workDir: '/work',
      dataDir,
    });
    await removeMarketplaceClone('acme', 'git', dataDir);
    await expect(stat(marketplaceCacheDir('acme', dataDir))).rejects.toThrow();
    // No-op for non-git kinds.
    await removeMarketplaceClone('acme', 'url', dataDir);
  });

  it('fails clearly when the clone has no manifest', async () => {
    const repoDir = await makeGitRepo({ 'README.md': 'nothing here' });
    const dataDir = await makeTmp();
    await expect(
      materializeMarketplaceSource('acme', gitSource(repoDir), { workDir: '/work', dataDir }),
    ).rejects.toThrow(/No marketplace manifest found.*\.claude-plugin\/marketplace\.json/s);
  });
});

describe('manifest validation', () => {
  async function loadManifest(
    manifest: unknown,
  ): Promise<ReturnType<typeof loadMarketplaceCatalogForSource>> {
    const dir = await makeTmp();
    const file = join(dir, 'marketplace.json');
    await writeFile(file, typeof manifest === 'string' ? manifest : JSON.stringify(manifest), 'utf8');
    return loadMarketplaceCatalogForSource({ kind: 'local', source: file }, { workDir: '/work' });
  }

  it('maps Claude Code object-form github sources onto install URLs', async () => {
    const catalog = await loadManifest({
      name: 'cc',
      owner: { name: 'Acme' },
      plugins: [
        { name: 'plain', source: { source: 'github', repo: 'acme/tools' } },
        { name: 'tagged', source: { source: 'github', repo: 'acme/tools', ref: 'v2' } },
        {
          name: 'pinned',
          source: { source: 'github', repo: 'acme/tools', sha: 'a'.repeat(40) },
        },
      ],
    });
    expect(catalog.plugins.map((entry) => entry.source)).toEqual([
      'https://github.com/acme/tools',
      'https://github.com/acme/tools/tree/v2',
      `https://github.com/acme/tools/commit/${'a'.repeat(40)}`,
    ]);
  });

  it('rejects unsupported object source kinds with the entry id in the message', async () => {
    await expect(
      loadManifest({ plugins: [{ name: 'npm-plugin', source: { source: 'npm', package: 'x' } }] }),
    ).rejects.toThrow(/npm-plugin.*"npm" is not supported/s);
    await expect(
      loadManifest({
        plugins: [{ name: 'gl', source: { source: 'url', url: 'https://gitlab.com/a/b' } }],
      }),
    ).rejects.toThrow(/gl.*only supported for github\.com/s);
  });

  it('rejects entries without id/name and manifests without a plugins array', async () => {
    await expect(loadManifest({ plugins: [{ source: './x' }] })).rejects.toThrow(
      'must define "id" (or "name")',
    );
    await expect(loadManifest({ name: 'no-plugins' })).rejects.toThrow('"plugins" array');
    await expect(loadManifest('not json')).rejects.toThrow('not valid JSON');
  });

  it('fails clearly for a local directory without a manifest', async () => {
    const dir = await makeTmp();
    await expect(
      loadMarketplaceCatalogForSource({ kind: 'local', source: dir }, { workDir: '/work' }),
    ).rejects.toThrow('No marketplace manifest found');
  });

  it('fails clearly for a missing local path', async () => {
    await expect(
      loadMarketplaceCatalogForSource(
        { kind: 'local', source: '/definitely/not/here.json' },
        { workDir: '/work' },
      ),
    ).rejects.toThrow('does not exist');
  });
});
