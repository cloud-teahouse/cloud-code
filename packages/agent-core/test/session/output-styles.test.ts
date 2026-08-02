import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { CloudCodeError } from '../../src/errors';
import type { SDKSessionRPC } from '../../src/rpc';
import { Session } from '../../src/session';
import { createFakeKaos } from '../tools/fixtures/fake-kaos';

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

function createSessionRpc(): SDKSessionRPC {
  return new Proxy(
    {},
    {
      get: () => vi.fn(),
    },
  ) as SDKSessionRPC;
}

async function makeSession(options: {
  readonly userHome: string;
  readonly projectDir: string;
  readonly pluginDirs?: readonly { readonly pluginId: string; readonly path: string }[];
}): Promise<Session> {
  return new Session({
    id: 'test-output-styles',
    kaos: createFakeKaos({
      mkdir: vi.fn().mockResolvedValue(undefined),
      writeText: vi.fn().mockResolvedValue(0),
      getcwd: () => options.projectDir,
    }),
    homedir: '/tmp/cloud-code-session',
    cloudCodeHomeDir: options.userHome,
    rpc: createSessionRpc(),
    initializeMainAgent: false,
    pluginOutputStyleDirs: options.pluginDirs,
  });
}

describe('Session output styles', () => {
  it('lists builtin, plugin, user, and project styles with rising precedence', async () => {
    const userHome = await mkdtemp(join(tmpdir(), 'output-styles-home-'));
    const projectDir = await mkdtemp(join(tmpdir(), 'output-styles-proj-'));
    const pluginDir = await mkdtemp(join(tmpdir(), 'output-styles-plugin-'));
    tempDirs.push(userHome, projectDir, pluginDir);
    await mkdir(join(userHome, 'output-styles'), { recursive: true });
    await mkdir(join(projectDir, '.cloud-code', 'output-styles'), { recursive: true });
    await writeFile(
      join(pluginDir, 'shared.md'),
      '---\nname: shared\ndescription: plugin shared\n---\nPlugin body.\n',
    );
    await writeFile(
      join(userHome, 'output-styles', 'shared.md'),
      '---\nname: shared\ndescription: user shared\n---\nUser body.\n',
    );
    await writeFile(
      join(projectDir, '.cloud-code', 'output-styles', 'shared.md'),
      '---\nname: shared\ndescription: project shared\n---\nProject body.\n',
    );

    const session = await makeSession({
      userHome,
      projectDir,
      pluginDirs: [{ pluginId: 'acme', path: pluginDir }],
    });
    const styles = await session.listOutputStyles();
    const byName = new Map(styles.map((style) => [style.name, style]));
    expect(byName.get('shared')).toMatchObject({
      description: 'project shared',
      source: 'project',
    });
    expect(byName.get('concise')).toMatchObject({ source: 'builtin' });
    expect(byName.get('explanatory')).toMatchObject({ source: 'builtin' });
    expect(byName.get('reviewer')).toMatchObject({ source: 'builtin' });
    expect(byName.get('debugger')).toMatchObject({ source: 'builtin' });
    expect(byName.get('teacher')).toMatchObject({ source: 'builtin' });
  });

  it('accepts known styles and default, rejects unknown names', async () => {
    const userHome = await mkdtemp(join(tmpdir(), 'output-styles-home-'));
    const projectDir = await mkdtemp(join(tmpdir(), 'output-styles-proj-'));
    tempDirs.push(userHome, projectDir);
    const session = await makeSession({ userHome, projectDir });

    // No ready agents: applying still validates against the registry.
    await session.setOutputStyle('concise');
    await session.setOutputStyle('default');
    await expect(session.setOutputStyle('nope')).rejects.toThrow(CloudCodeError);
    await expect(session.setOutputStyle('nope')).rejects.toMatchObject({
      code: 'session.output_style_not_found',
    });
  });
});
