import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  addMarketplace,
  getMarketplace,
  listMarketplaces,
  removeMarketplace,
  resolveMarketplaceArg,
} from '#/utils/plugin-marketplace-registry';

async function makeDataDir(): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), 'marketplaces-test-')));
}

describe('plugin marketplace registry', () => {
  it('always includes the implicit official entry first', async () => {
    const dataDir = await makeDataDir();
    const all = await listMarketplaces(dataDir);
    expect(all).toHaveLength(1);
    expect(all[0]?.name).toBe('official');
    expect(all[0]?.builtin).toBe(true);
    expect(all[0]?.source).toContain('code.kimi.com');
  });

  it('adds, lists, resolves and removes a marketplace', async () => {
    const dataDir = await makeDataDir();
    const entry = await addMarketplace('acme', 'https://example.com/marketplace.json', dataDir);
    expect(entry.name).toBe('acme');
    expect(entry.addedAt).not.toBe('');

    const all = await listMarketplaces(dataDir);
    expect(all.map((m) => m.name)).toEqual(['official', 'acme']);

    expect(await getMarketplace('acme', dataDir)).toMatchObject({
      name: 'acme',
      source: 'https://example.com/marketplace.json',
    });
    expect(await resolveMarketplaceArg('acme', dataDir)).toBe('https://example.com/marketplace.json');

    await removeMarketplace('acme', dataDir);
    expect((await listMarketplaces(dataDir)).map((m) => m.name)).toEqual(['official']);
  });

  it('persists across reads from a fresh state', async () => {
    const dataDir = await makeDataDir();
    await addMarketplace('acme', './local/marketplace.json', dataDir);
    expect(await resolveMarketplaceArg('acme', dataDir)).toBe('./local/marketplace.json');
  });

  it('passes through unregistered arguments as direct sources', async () => {
    const dataDir = await makeDataDir();
    expect(await resolveMarketplaceArg('https://elsewhere.dev/m.json', dataDir)).toBe(
      'https://elsewhere.dev/m.json',
    );
  });

  it('rejects reserved, invalid and duplicate names', async () => {
    const dataDir = await makeDataDir();
    await expect(addMarketplace('official', 'https://x.dev/m.json', dataDir)).rejects.toThrow(
      'reserved',
    );
    await expect(addMarketplace('builtin', 'https://x.dev/m.json', dataDir)).rejects.toThrow(
      'reserved',
    );
    await expect(addMarketplace('Bad Name', 'https://x.dev/m.json', dataDir)).rejects.toThrow(
      'kebab-case',
    );
    await addMarketplace('acme', 'https://x.dev/m.json', dataDir);
    await expect(addMarketplace('acme', 'https://y.dev/m.json', dataDir)).rejects.toThrow(
      'already exists',
    );
  });

  it('rejects removing reserved or unknown marketplaces', async () => {
    const dataDir = await makeDataDir();
    await expect(removeMarketplace('official', dataDir)).rejects.toThrow('reserved');
    await expect(removeMarketplace('nope', dataDir)).rejects.toThrow('not registered');
  });

  it('persists typed sources with refs and infers kinds for legacy string sources', async () => {
    const dataDir = await makeDataDir();
    await addMarketplace(
      'team-repo',
      { source: 'https://github.com/acme/plugins', sourceKind: 'github', ref: 'v1' },
      dataDir,
    );
    await addMarketplace('local-dir', '/opt/marketplaces/acme', dataDir);

    const all = await listMarketplaces(dataDir);
    const teamRepo = all.find((m) => m.name === 'team-repo');
    expect(teamRepo).toMatchObject({
      sourceKind: 'github',
      ref: 'v1',
      source: 'https://github.com/acme/plugins',
    });
    // Legacy string form: kind inferred from the source shape.
    expect(all.find((m) => m.name === 'local-dir')?.sourceKind).toBe('local');
    expect(all.find((m) => m.name === 'official')?.sourceKind).toBe('url');
  });
});
