import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  findProjectRoot,
  isPluginEnabledInScope,
  projectPluginsFilePath,
  readProjectPluginOverrides,
  writeProjectPluginOverride,
} from '../../src/plugin/project-scope';

async function makeDir(prefix: string): Promise<string> {
  return realpath(await mkdtemp(path.join(tmpdir(), prefix)));
}

describe('findProjectRoot', () => {
  it('walks up to the nearest directory containing .git', async () => {
    const root = await makeDir('proj-root-');
    await mkdir(path.join(root, '.git'));
    const nested = path.join(root, 'packages', 'app');
    await mkdir(nested, { recursive: true });
    expect(await findProjectRoot(nested)).toBe(root);
  });

  it('falls back to workDir outside any repository', async () => {
    const dir = await makeDir('proj-none-');
    const nested = path.join(dir, 'a', 'b');
    await mkdir(nested, { recursive: true });
    expect(await findProjectRoot(nested)).toBe(nested);
  });
});

describe('project plugin overrides', () => {
  it('round-trips enable/disable overrides and clears them with undefined', async () => {
    const root = await makeDir('proj-ov-');
    expect(await readProjectPluginOverrides(root)).toEqual(new Map());

    await writeProjectPluginOverride(root, 'alpha', false);
    await writeProjectPluginOverride(root, 'beta', true);
    expect(await readProjectPluginOverrides(root)).toEqual(
      new Map([
        ['alpha', false],
        ['beta', true],
      ]),
    );

    await writeProjectPluginOverride(root, 'alpha', undefined);
    expect(await readProjectPluginOverrides(root)).toEqual(new Map([['beta', true]]));
  });

  it('persists to <projectRoot>/.cloud-code/plugins.json', async () => {
    const root = await makeDir('proj-path-');
    await writeProjectPluginOverride(root, 'alpha', true);
    const filePath = projectPluginsFilePath(root);
    expect(filePath).toBe(path.join(root, '.cloud-code', 'plugins.json'));
    const raw = JSON.parse(await readFile(filePath, 'utf8')) as {
      version: number;
      overrides: Record<string, { enabled: boolean }>;
    };
    expect(raw.version).toBe(1);
    expect(raw.overrides).toEqual({ alpha: { enabled: true } });
  });

  it('treats a corrupt file as no overrides', async () => {
    const root = await makeDir('proj-corrupt-');
    await mkdir(path.join(root, '.cloud-code'), { recursive: true });
    await writeFile(projectPluginsFilePath(root), '{ not json', 'utf8');
    expect(await readProjectPluginOverrides(root)).toEqual(new Map());
  });
});

describe('isPluginEnabledInScope', () => {
  it('applies the project override when present, otherwise the install flag', () => {
    const scope = { overrides: new Map([['alpha', true]]) };
    expect(isPluginEnabledInScope(false, 'alpha', scope)).toBe(true);
    expect(isPluginEnabledInScope(true, 'beta', scope)).toBe(true);
    expect(isPluginEnabledInScope(false, 'beta', scope)).toBe(false);
    expect(isPluginEnabledInScope(true, 'alpha')).toBe(true);
  });
});
