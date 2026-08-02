import { mkdir, mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';
import yazl from 'yazl';

import { PluginManager } from '../../src/plugin/manager';

async function makeCloudCodeHome(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'kimi-home-'));
}

async function managedPluginRoot(home: string, id: string): Promise<string> {
  return realpath(path.join(home, 'plugins', 'managed', id));
}

async function makePlugin(
  name: string,
  options: {
    skills?: boolean;
    skillNames?: readonly string[];
    agents?: boolean;
    version?: string;
    sessionStartSkill?: string;
    systemPrompt?: string;
    mcpServers?: Record<string, unknown>;
    hooks?: readonly unknown[];
    commands?: Record<string, string>;
  } = {},
): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), `plugin-${name}-`));
  const manifest: Record<string, unknown> = { name };
  if (options.version !== undefined) {
    manifest['version'] = options.version;
  }
  const skillNames = options.skillNames ?? (options.skills === true ? ['demo-skill'] : []);
  if (skillNames.length > 0) {
    manifest['skills'] = './skills/';
    await mkdir(path.join(root, 'skills'), { recursive: true });
    for (const skillName of skillNames) {
      await mkdir(path.join(root, 'skills', skillName), { recursive: true });
      await writeFile(
        path.join(root, 'skills', skillName, 'SKILL.md'),
        `---\nname: ${skillName}\ndescription: A demo\n---\nbody`,
        'utf8',
      );
    }
  }
  if (options.agents === true) {
    manifest['agents'] = './agents/';
    await mkdir(path.join(root, 'agents'), { recursive: true });
    await writeFile(
      path.join(root, 'agents', 'demo-agent.md'),
      '---\nname: demo-agent\ndescription: A demo agent\n---\nbody',
      'utf8',
    );
  }
  if (options.sessionStartSkill !== undefined) {
    manifest['sessionStart'] = { skill: options.sessionStartSkill };
  }
  if (options.systemPrompt !== undefined) {
    manifest['systemPrompt'] = options.systemPrompt;
  }
  if (options.mcpServers !== undefined) {
    manifest['mcpServers'] = options.mcpServers;
  }
  if (options.hooks !== undefined) {
    manifest['hooks'] = options.hooks;
  }
  if (options.commands !== undefined) {
    manifest['commands'] = ['./commands'];
    await mkdir(path.join(root, 'commands'), { recursive: true });
    for (const [file, body] of Object.entries(options.commands)) {
      const filePath = path.join(root, 'commands', file);
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, body, 'utf8');
    }
  }
  await writeFile(
    path.join(root, 'kimi.plugin.json'),
    JSON.stringify(manifest),
    'utf8',
  );
  return realpath(root);
}

describe('PluginManager', () => {
  it('install() adds a plugin and load() rehydrates it from disk', async () => {
    const home = await makeCloudCodeHome();
    const pluginRoot = await makePlugin('demo', { skills: true });

    let manager = new PluginManager({ cloudCodeHomeDir: home });
    await manager.load();
    expect(manager.list()).toEqual([]);

    const record = await manager.install(pluginRoot);
    expect(record.id).toBe('demo');
    expect(record.enabled).toBe(true);
    expect(manager.list()).toHaveLength(1);

    manager = new PluginManager({ cloudCodeHomeDir: home });
    await manager.load();
    expect(manager.list()).toHaveLength(1);
    expect(manager.get('demo')?.root).toBe(await managedPluginRoot(home, 'demo'));
    expect(manager.get('demo')?.originalSource).toBe(pluginRoot);
  });

  it('install() accepts a .kimi-plugin manifest', async () => {
    const home = await makeCloudCodeHome();
    const root = await mkdtemp(path.join(tmpdir(), 'kimi-plugin-'));
    await mkdir(path.join(root, '.kimi-plugin'), { recursive: true });
    await mkdir(path.join(root, 'skills'), { recursive: true });
    await writeFile(
      path.join(root, '.kimi-plugin', 'plugin.json'),
      JSON.stringify({
        name: 'superpowers',
        skills: './skills/',
        skillInstructions: 'Use Kimi tools.',
      }),
      'utf8',
    );

    const manager = new PluginManager({ cloudCodeHomeDir: home });
    await manager.load();
    const record = await manager.install(root);
    const managedRoot = await managedPluginRoot(home, 'superpowers');

    expect(record.id).toBe('superpowers');
    expect(record.manifestKind).toBe('kimi-plugin-dir');
    expect(record.root).toBe(managedRoot);
    expect(record.originalSource).toBe(root);
    expect(record.manifest?.skills).toEqual([path.join(managedRoot, 'skills')]);
    expect(manager.pluginSkillRoots()).toContainEqual({
      path: path.join(managedRoot, 'skills'),
      source: 'extra',
      plugin: { id: 'superpowers', instructions: 'Use Kimi tools.' },
    });
  });

  it('install() rejects a relative plugin root', async () => {
    const home = await makeCloudCodeHome();
    const manager = new PluginManager({ cloudCodeHomeDir: home });
    await manager.load();

    await expect(manager.install('relative/plugin')).rejects.toThrow(/absolute path/i);
  });

  it('install() copies a symlinked plugin root into the managed plugins dir', async () => {
    const home = await makeCloudCodeHome();
    const pluginRoot = await makePlugin('demo');
    const link = path.join(await mkdtemp(path.join(tmpdir(), 'plugin-link-')), 'demo-link');
    await symlink(pluginRoot, link);
    const manager = new PluginManager({ cloudCodeHomeDir: home });
    await manager.load();

    const record = await manager.install(link);

    const managedRoot = await managedPluginRoot(home, 'demo');
    expect(record.root).toBe(managedRoot);
    expect(record.originalSource).toBe(link);
    const reloaded = new PluginManager({ cloudCodeHomeDir: home });
    await reloaded.load();
    expect(reloaded.get('demo')?.root).toBe(managedRoot);
  });

  it('setEnabled() persists the new state', async () => {
    const home = await makeCloudCodeHome();
    const root = await makePlugin('demo', { skills: true });
    const manager = new PluginManager({ cloudCodeHomeDir: home });
    await manager.load();
    await manager.install(root);

    await manager.setEnabled('demo', false);
    expect(manager.get('demo')?.enabled).toBe(false);

    const reloaded = new PluginManager({ cloudCodeHomeDir: home });
    await reloaded.load();
    expect(reloaded.get('demo')?.enabled).toBe(false);
  });

  it('remove() clears the entry but does not delete the source directory', async () => {
    const home = await makeCloudCodeHome();
    const root = await makePlugin('demo', { skills: true });
    const manager = new PluginManager({ cloudCodeHomeDir: home });
    await manager.load();
    await manager.install(root);

    await manager.remove('demo');
    expect(manager.get('demo')).toBeUndefined();
    // Source directory survives.
    const { stat } = await import('node:fs/promises');
    expect((await stat(root)).isDirectory()).toBe(true);
  });

  it('pluginSkillRoots() returns only enabled plugins skills paths', async () => {
    const home = await makeCloudCodeHome();
    const a = await makePlugin('a', { skills: true });
    const b = await makePlugin('b', { skills: true });
    const manager = new PluginManager({ cloudCodeHomeDir: home });
    await manager.load();
    await manager.install(a);
    await manager.install(b);
    await manager.setEnabled('b', false);
    const managedA = await managedPluginRoot(home, 'a');
    const managedB = await managedPluginRoot(home, 'b');
    expect(manager.pluginSkillRoots()).toContainEqual({
      path: path.join(managedA, 'skills'),
      source: 'extra',
      plugin: { id: 'a', instructions: undefined },
    });
    expect(manager.pluginSkillRoots()).not.toContainEqual({
      path: path.join(managedB, 'skills'),
      source: 'extra',
      plugin: { id: 'b', instructions: undefined },
    });
  });

  it('pluginAgentRoots() returns only enabled plugins agents paths', async () => {
    const home = await makeCloudCodeHome();
    const a = await makePlugin('a', { agents: true });
    const b = await makePlugin('b', { agents: true });
    const manager = new PluginManager({ cloudCodeHomeDir: home });
    await manager.load();
    await manager.install(a);
    await manager.install(b);
    await manager.setEnabled('b', false);
    const managedA = await managedPluginRoot(home, 'a');
    const managedB = await managedPluginRoot(home, 'b');
    expect(manager.pluginAgentRoots()).toContainEqual({
      path: path.join(managedA, 'agents'),
      source: 'plugin',
    });
    expect(manager.pluginAgentRoots()).not.toContainEqual({
      path: path.join(managedB, 'agents'),
      source: 'plugin',
    });
  });

  it('summaries count discovered skills inside plugin skill roots', async () => {
    const home = await makeCloudCodeHome();
    const root = await makePlugin('superpowers', {
      skillNames: ['brainstorming', 'systematic-debugging', 'writing-plans'],
    });
    const manager = new PluginManager({ cloudCodeHomeDir: home });
    await manager.load();
    await manager.install(root);

    expect(manager.summaries()).toContainEqual(
      expect.objectContaining({
        id: 'superpowers',
        skillCount: 3,
      }),
    );
    expect(manager.info('superpowers')?.skillCount).toBe(3);
  });

  it('reload() picks up edits to the managed plugin copy', async () => {
    const home = await makeCloudCodeHome();
    const root = await makePlugin('demo');
    const manager = new PluginManager({ cloudCodeHomeDir: home });
    await manager.load();
    await manager.install(root);
    const managedRoot = await managedPluginRoot(home, 'demo');

    await writeFile(
      path.join(managedRoot, 'kimi.plugin.json'),
      JSON.stringify({ name: 'demo', version: '2.0.0' }),
      'utf8',
    );
    const summary = await manager.reload();
    expect(summary.errors).toEqual([]);
    expect(manager.get('demo')?.manifest?.version).toBe('2.0.0');
  });

  it('reload() does not reread the original local source after install', async () => {
    const home = await makeCloudCodeHome();
    const root = await makePlugin('demo');
    const manager = new PluginManager({ cloudCodeHomeDir: home });
    await manager.load();
    await manager.install(root);

    await writeFile(
      path.join(root, 'kimi.plugin.json'),
      JSON.stringify({ name: 'demo', version: 'source-edit' }),
      'utf8',
    );

    const summary = await manager.reload();
    expect(summary.errors).toEqual([]);
    expect(manager.get('demo')?.manifest?.version).toBeUndefined();
  });

  it('install() refuses to add a directory without a manifest', async () => {
    const home = await makeCloudCodeHome();
    const root = await mkdtemp(path.join(tmpdir(), 'no-manifest-'));
    const manager = new PluginManager({ cloudCodeHomeDir: home });
    await manager.load();
    await expect(manager.install(root)).rejects.toThrow(/manifest/i);
  });

  it('install() overwrites the same local plugin and preserves user state', async () => {
    const home = await makeCloudCodeHome();
    const root = await makePlugin('demo', {
      version: '1.0.0',
      mcpServers: { finance: { command: 'finance-mcp' } },
    });
    const manager = new PluginManager({ cloudCodeHomeDir: home });
    await manager.load();
    const first = await manager.install(root);
    await manager.setMcpServerEnabled('demo', 'finance', false);
    await manager.setEnabled('demo', false);

    await new Promise((r) => setTimeout(r, 10));
    const updatedRoot = await makePlugin('demo', {
      version: '2.0.0',
      mcpServers: { finance: { command: 'finance-mcp-v2' } },
    });
    const updated = await manager.install(updatedRoot);

    expect(manager.list()).toHaveLength(1);
    expect(updated.manifest?.version).toBe('2.0.0');
    expect(updated.enabled).toBe(false);
    expect(updated.installedAt).toBe(first.installedAt);
    expect(updated.updatedAt).not.toBe(first.updatedAt);
    expect(updated.originalSource).toBe(updatedRoot);
    expect(manager.info('demo')?.mcpServers[0]?.enabled).toBe(false);
  });

  it('keeps a plugin in error state instead of losing it on a broken manifest', async () => {
    const home = await makeCloudCodeHome();
    const root = await makePlugin('demo');
    const manager = new PluginManager({ cloudCodeHomeDir: home });
    await manager.load();
    await manager.install(root);
    await writeFile(
      path.join(await managedPluginRoot(home, 'demo'), 'kimi.plugin.json'),
      '{ not json',
      'utf8',
    );
    await manager.reload();
    const record = manager.get('demo');
    expect(record?.state).toBe('error');
    expect(record?.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: 'error',
        message: expect.stringContaining('Failed to parse'),
      }),
    );
    expect(manager.pluginSkillRoots()).toEqual([]);
  });

  it('enabledSessionStarts() returns only enabled plugin sessionStart declarations', async () => {
    const home = await makeCloudCodeHome();
    const root = await makePlugin('demo', {
      skills: true,
      sessionStartSkill: 'demo-skill',
    });
    const manager = new PluginManager({ cloudCodeHomeDir: home });
    await manager.load();
    await manager.install(root);
    expect(manager.enabledSessionStarts()).toEqual([
      { pluginId: 'demo', skillName: 'demo-skill' },
    ]);

    await manager.setEnabled('demo', false);
    expect(manager.enabledSessionStarts()).toEqual([]);
  });

  it('enabledSystemPrompts() returns only enabled plugin systemPrompt declarations', async () => {
    const home = await makeCloudCodeHome();
    const withPrompt = await makePlugin('prompted', { systemPrompt: 'Always cite sources.' });
    const withoutPrompt = await makePlugin('plain', { skills: true });
    const manager = new PluginManager({ cloudCodeHomeDir: home });
    await manager.load();
    await manager.install(withPrompt);
    await manager.install(withoutPrompt);
    expect(manager.enabledSystemPrompts()).toEqual([
      { pluginId: 'prompted', content: 'Always cite sources.' },
    ]);

    await manager.setEnabled('prompted', false);
    expect(manager.enabledSystemPrompts()).toEqual([]);
  });

  it('maps manifest skillInstructions to record skillInstructions', async () => {
    const home = await makeCloudCodeHome();
    const root = await mkdtemp(path.join(tmpdir(), 'plugin-instructions-'));
    await writeFile(
      path.join(root, 'kimi.plugin.json'),
      JSON.stringify({
        name: 'demo',
        skillInstructions: 'Always be helpful.',
      }),
      'utf8',
    );
    const manager = new PluginManager({ cloudCodeHomeDir: home });
    await manager.load();
    const record = await manager.install(root);
    expect(record.skillInstructions).toBe('Always be helpful.');
  });

  it('setMcpServerEnabled() persists explicit MCP server state', async () => {
    const home = await makeCloudCodeHome();
    const root = await makePlugin('demo', {
      mcpServers: {
        finance: { command: 'finance-mcp' },
        docs: { url: 'https://example.com/mcp' },
        events: { transport: 'sse', url: 'https://example.com/sse' },
      },
    });
    const manager = new PluginManager({ cloudCodeHomeDir: home });
    await manager.load();
    await manager.install(root);
    const managedRoot = await managedPluginRoot(home, 'demo');

    expect(manager.info('demo')?.mcpServers).toContainEqual(
      expect.objectContaining({
        name: 'finance',
        runtimeName: 'plugin-demo:finance',
        enabled: true,
        command: 'finance-mcp',
      }),
    );
    expect(manager.info('demo')?.mcpServers).toContainEqual(
      expect.objectContaining({
        name: 'events',
        runtimeName: 'plugin-demo:events',
        transport: 'sse',
        url: 'https://example.com/sse',
      }),
    );
    expect(manager.summaries()[0]).toEqual(
      expect.objectContaining({
        mcpServerCount: 3,
        enabledMcpServerCount: 3,
      }),
    );

    expect(manager.enabledMcpServers()).toEqual(
      expect.objectContaining({
        'plugin-demo:finance': expect.objectContaining({
          command: 'finance-mcp',
          cwd: managedRoot,
          env: expect.objectContaining({ CLOUD_CODE_HOME: home, KIMI_PLUGIN_ROOT: managedRoot }),
        }),
        'plugin-demo:docs': expect.objectContaining({
          url: 'https://example.com/mcp',
        }),
        'plugin-demo:events': expect.objectContaining({
          transport: 'sse',
          url: 'https://example.com/sse',
        }),
      }),
    );

    await manager.setMcpServerEnabled('demo', 'finance', false);

    expect(manager.enabledMcpServers()).not.toHaveProperty('plugin-demo:finance');
    expect(manager.summaries()[0]).toEqual(
      expect.objectContaining({
        mcpServerCount: 3,
        enabledMcpServerCount: 2,
      }),
    );

    const reloaded = new PluginManager({ cloudCodeHomeDir: home });
    await reloaded.load();
    expect(reloaded.info('demo')?.mcpServers).toContainEqual(
      expect.objectContaining({ name: 'finance', enabled: false }),
    );
  });

  it('merges manifest MCP enabled defaults with explicit user state', async () => {
    const home = await makeCloudCodeHome();
    const root = await makePlugin('demo', {
      mcpServers: {
        finance: { command: 'finance-mcp', enabled: false },
      },
    });
    const manager = new PluginManager({ cloudCodeHomeDir: home });
    await manager.load();
    await manager.install(root);

    expect(manager.info('demo')?.mcpServers).toContainEqual(
      expect.objectContaining({ name: 'finance', enabled: false }),
    );
    expect(manager.summaries()[0]).toEqual(
      expect.objectContaining({
        mcpServerCount: 1,
        enabledMcpServerCount: 0,
      }),
    );
    expect(manager.enabledMcpServers()).toEqual({});

    await manager.setMcpServerEnabled('demo', 'finance', true);

    expect(manager.info('demo')?.mcpServers).toContainEqual(
      expect.objectContaining({ name: 'finance', enabled: true }),
    );
    expect(manager.enabledMcpServers()).toEqual(
      expect.objectContaining({
        'plugin-demo:finance': expect.objectContaining({
          command: 'finance-mcp',
          enabled: true,
        }),
      }),
    );

    const reloaded = new PluginManager({ cloudCodeHomeDir: home });
    await reloaded.load();
    expect(reloaded.info('demo')?.mcpServers).toContainEqual(
      expect.objectContaining({ name: 'finance', enabled: true }),
    );
    expect(reloaded.enabledMcpServers()).toHaveProperty('plugin-demo:finance');
  });

  it('uses unambiguous runtime names for plugin MCP servers', async () => {
    const home = await makeCloudCodeHome();
    const first = await makePlugin('a-b', {
      mcpServers: {
        c: { command: 'first-mcp' },
      },
    });
    const second = await makePlugin('a', {
      mcpServers: {
        'b-c': { command: 'second-mcp' },
      },
    });
    const manager = new PluginManager({ cloudCodeHomeDir: home });
    await manager.load();
    await manager.install(first);
    await manager.install(second);

    expect(manager.info('a-b')?.mcpServers).toContainEqual(
      expect.objectContaining({ name: 'c', runtimeName: 'plugin-a-b:c' }),
    );
    expect(manager.info('a')?.mcpServers).toContainEqual(
      expect.objectContaining({ name: 'b-c', runtimeName: 'plugin-a:b-c' }),
    );

    const servers = manager.enabledMcpServers();
    expect(servers).toEqual(
      expect.objectContaining({
        'plugin-a-b:c': expect.objectContaining({ command: 'first-mcp' }),
        'plugin-a:b-c': expect.objectContaining({ command: 'second-mcp' }),
      }),
    );
    expect(Object.keys(servers)).toHaveLength(2);
  });

  it('enabledMcpServers() excludes disabled plugins', async () => {
    const home = await makeCloudCodeHome();
    const root = await makePlugin('demo', {
      mcpServers: { finance: { command: 'finance-mcp' } },
    });
    const manager = new PluginManager({ cloudCodeHomeDir: home });
    await manager.load();
    await manager.install(root);
    await manager.setMcpServerEnabled('demo', 'finance', true);
    await manager.setEnabled('demo', false);

    expect(manager.enabledMcpServers()).toEqual({});
  });

  it('setMcpServerEnabled() rejects unknown MCP servers', async () => {
    const home = await makeCloudCodeHome();
    const root = await makePlugin('demo');
    const manager = new PluginManager({ cloudCodeHomeDir: home });
    await manager.load();
    await manager.install(root);

    await expect(manager.setMcpServerEnabled('demo', 'missing', true)).rejects.toThrow(
      /does not declare MCP server/i,
    );
  });

  it('install() sets originalSource and updatedAt', async () => {
    const home = await makeCloudCodeHome();
    const root = await makePlugin('demo');
    const manager = new PluginManager({ cloudCodeHomeDir: home });
    await manager.load();

    const before = Date.now();
    const record = await manager.install(root);
    const after = Date.now();

    expect(record.originalSource).toBe(root);
    expect(record.root).toBe(await managedPluginRoot(home, 'demo'));
    expect(record.updatedAt).toBeDefined();
    const updatedAt = new Date(record.updatedAt!).getTime();
    expect(updatedAt).toBeGreaterThanOrEqual(before);
    expect(updatedAt).toBeLessThanOrEqual(after);
    expect(record.installedAt).toBe(record.updatedAt);
  });

  it('persist() and load() round-trip originalSource and updatedAt', async () => {
    const home = await makeCloudCodeHome();
    const root = await makePlugin('demo');
    const manager = new PluginManager({ cloudCodeHomeDir: home });
    await manager.load();
    await manager.install(root);

    const reloaded = new PluginManager({ cloudCodeHomeDir: home });
    await reloaded.load();
    const record = reloaded.get('demo');
    expect(record?.originalSource).toBe(root);
    expect(record?.root).toBe(await managedPluginRoot(home, 'demo'));
    expect(record?.updatedAt).toBeDefined();
  });

  it('setEnabled() updates updatedAt', async () => {
    const home = await makeCloudCodeHome();
    const root = await makePlugin('demo');
    const manager = new PluginManager({ cloudCodeHomeDir: home });
    await manager.load();
    const record = await manager.install(root);
    const firstUpdatedAt = record.updatedAt;

    // Give enough time for the timestamp to change.
    await new Promise((r) => setTimeout(r, 10));
    await manager.setEnabled('demo', false);

    const after = manager.get('demo');
    expect(after?.updatedAt).toBeDefined();
    expect(after?.updatedAt).not.toBe(firstUpdatedAt);

    const reloaded = new PluginManager({ cloudCodeHomeDir: home });
    await reloaded.load();
    expect(reloaded.get('demo')?.updatedAt).toBe(after?.updatedAt);
  });

  it('info() includes originalSource', async () => {
    const home = await makeCloudCodeHome();
    const root = await makePlugin('demo');
    const manager = new PluginManager({ cloudCodeHomeDir: home });
    await manager.load();
    await manager.install(root);

    const info = manager.info('demo');
    expect(info?.originalSource).toBe(root);
  });

  it('install() supports zip URL', async () => {
    const home = await makeCloudCodeHome();
    const zipBuffer = await createZipBuffer([
      {
        name: 'plugin/kimi.plugin.json',
        data: JSON.stringify({ name: 'zip-demo', skills: './skills/' }),
      },
      {
        name: 'plugin/skills/demo-skill/SKILL.md',
        data: '---\nname: demo-skill\ndescription: A demo\n---\nbody',
      },
    ]);
    const url = await serveOnce(zipBuffer);

    const manager = new PluginManager({ cloudCodeHomeDir: home });
    await manager.load();

    const record = await manager.install(url);
    const managedRoot = await realpath(path.join(home, 'plugins', 'managed', 'zip-demo'));
    expect(record.id).toBe('zip-demo');
    expect(record.source).toBe('zip-url');
    expect(record.originalSource).toBe(url);
    expect(record.root).toBe(managedRoot);
    expect(record.manifest?.skills).toEqual([path.join(managedRoot, 'skills')]);

    const reloaded = new PluginManager({ cloudCodeHomeDir: home });
    await reloaded.load();
    expect(reloaded.get('zip-demo')?.source).toBe('zip-url');
    expect(reloaded.get('zip-demo')?.root).toBe(managedRoot);
  });

  it('install() from zip-url overwrites existing zip-url plugin', async () => {
    const home = await makeCloudCodeHome();
    const zipBuffer1 = await createZipBuffer([
      { name: 'plugin/kimi.plugin.json', data: JSON.stringify({ name: 'zip-demo', version: '1.0.0' }) },
    ]);
    const url1 = await serveOnce(zipBuffer1);

    const manager = new PluginManager({ cloudCodeHomeDir: home });
    await manager.load();
    await manager.install(url1);

    const zipBuffer2 = await createZipBuffer([
      { name: 'plugin/kimi.plugin.json', data: JSON.stringify({ name: 'zip-demo', version: '2.0.0' }) },
    ]);
    const url2 = await serveOnce(zipBuffer2);

    const record = await manager.install(url2);
    expect(record.manifest?.version).toBe('2.0.0');
    expect(manager.list()).toHaveLength(1);
    expect(record.originalSource).toBe(url2);
  });

  it('install() from zip-url overwrites existing local-path plugin', async () => {
    const home = await makeCloudCodeHome();
    const root = await makePlugin('zip-demo');
    const manager = new PluginManager({ cloudCodeHomeDir: home });
    await manager.load();
    const first = await manager.install(root);
    await manager.setEnabled('zip-demo', false);

    const zipBuffer = await createZipBuffer([
      { name: 'plugin/kimi.plugin.json', data: JSON.stringify({ name: 'zip-demo', version: '2.0.0' }) },
    ]);
    const url = await serveOnce(zipBuffer);

    const updated = await manager.install(url);

    expect(updated.source).toBe('zip-url');
    expect(updated.originalSource).toBe(url);
    expect(updated.manifest?.version).toBe('2.0.0');
    expect(updated.enabled).toBe(false);
    expect(updated.installedAt).toBe(first.installedAt);
    expect(manager.list()).toHaveLength(1);
  });

  it('install() rejects zip URL without manifest', async () => {
    const home = await makeCloudCodeHome();
    const zipBuffer = await createZipBuffer([
      { name: 'readme.txt', data: 'no manifest here' },
    ]);
    const url = await serveOnce(zipBuffer);

    const manager = new PluginManager({ cloudCodeHomeDir: home });
    await manager.load();

    await expect(manager.install(url)).rejects.toThrow(/manifest/i);
  });

  it('install() from github URL resolves latest release and records github metadata', async () => {
    const home = await makeCloudCodeHome();
    const zipBuffer = await createZipBuffer([
      {
        name: 'wbxl2000-superpowers-abc/kimi.plugin.json',
        data: JSON.stringify({ name: 'gh-demo', version: '1.0.0' }),
      },
    ]);

    using _ = mockGithubFetch({
      releaseTag: 'v1.0.0',
      tarball: zipBuffer,
    });

    const manager = new PluginManager({ cloudCodeHomeDir: home });
    await manager.load();
    const record = await manager.install('https://github.com/wbxl2000/superpowers');

    expect(record.id).toBe('gh-demo');
    expect(record.source).toBe('github');
    expect(record.originalSource).toBe('https://github.com/wbxl2000/superpowers');
    expect(record.github).toEqual({
      owner: 'wbxl2000',
      repo: 'superpowers',
      ref: { kind: 'tag', value: 'v1.0.0' },
    });

    const reloaded = new PluginManager({ cloudCodeHomeDir: home });
    await reloaded.load();
    expect(reloaded.get('gh-demo')?.source).toBe('github');
    expect(reloaded.get('gh-demo')?.github?.ref).toEqual({ kind: 'tag', value: 'v1.0.0' });
  });

  it('install() from /tree/<tag-shaped-ref> downloads via short form, not refs/heads/ (P1 regression)', async () => {
    // A repo whose only ref `v5.1.0` is a tag (no branch by that name). The
    // previous resolver wrote `zip/refs/heads/v5.1.0` and 404'd. Verify the
    // mock now sees the short-form request `zip/v5.1.0`.
    const home = await makeCloudCodeHome();
    const zipBuffer = await createZipBuffer([
      {
        name: 'obra-superpowers-v5.1.0/kimi.plugin.json',
        data: JSON.stringify({ name: 'pin-tag-demo', version: '5.1.0' }),
      },
    ]);

    let codeloadPath = '';
    const original = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (url.startsWith('https://codeload.github.com/')) {
        codeloadPath = new URL(url).pathname;
        return new Response(zipBuffer, { status: 200 });
      }
      throw new Error(`unexpected url ${url}`);
    }) as typeof fetch;

    try {
      const manager = new PluginManager({ cloudCodeHomeDir: home });
      await manager.load();
      const record = await manager.install(
        'https://github.com/obra/superpowers/tree/v5.1.0',
      );
      expect(codeloadPath).toBe('/obra/superpowers/zip/v5.1.0');
      expect(record.github?.ref).toEqual({ kind: 'branch', value: 'v5.1.0' });
    } finally {
      globalThis.fetch = original;
    }
  });

  it('install() from /releases/tag/<tag> resolves precisely via refs/tags/', async () => {
    const home = await makeCloudCodeHome();
    const zipBuffer = await createZipBuffer([
      {
        name: 'obra-superpowers-v5.1.0/kimi.plugin.json',
        data: JSON.stringify({ name: 'pin-tag-demo', version: '5.1.0' }),
      },
    ]);

    let codeloadPath = '';
    const original = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (url.startsWith('https://codeload.github.com/')) {
        codeloadPath = new URL(url).pathname;
        return new Response(zipBuffer, { status: 200 });
      }
      throw new Error(`unexpected url ${url}`);
    }) as typeof fetch;

    try {
      const manager = new PluginManager({ cloudCodeHomeDir: home });
      await manager.load();
      const record = await manager.install(
        'https://github.com/obra/superpowers/releases/tag/v5.1.0',
      );
      // Explicit tag origin → kind is 'tag', URL uses refs/tags/ for
      // disambiguation against same-named branches.
      expect(codeloadPath).toBe('/obra/superpowers/zip/refs/tags/v5.1.0');
      expect(record.github?.ref).toEqual({ kind: 'tag', value: 'v5.1.0' });
    } finally {
      globalThis.fetch = original;
    }
  });

  it('install() from github /tree/<branch> bypasses the GitHub API', async () => {
    const home = await makeCloudCodeHome();
    const zipBuffer = await createZipBuffer([
      {
        name: 'wbxl2000-superpowers-main/kimi.plugin.json',
        data: JSON.stringify({ name: 'gh-demo', version: '5.1.0' }),
      },
    ]);

    let releaseLookups = 0;
    using _ = mockGithubFetch({
      tarball: zipBuffer,
      onReleaseLookup: () => {
        releaseLookups++;
      },
    });

    const manager = new PluginManager({ cloudCodeHomeDir: home });
    await manager.load();
    const record = await manager.install(
      'https://github.com/wbxl2000/superpowers/tree/main',
    );

    expect(releaseLookups).toBe(0);
    expect(record.source).toBe('github');
    expect(record.github?.ref).toEqual({ kind: 'branch', value: 'main' });
  });

  it('install() ignores forged marketplace context from legacy callers', async () => {
    const home = await makeCloudCodeHome();
    const root = await makePlugin('rando', { version: '1.0.0' });
    const manager = new PluginManager({ cloudCodeHomeDir: home });
    await manager.load();

    const record = await (manager.install as (source: string, options?: unknown) => Promise<unknown>)(root, {
      marketplace: { id: 'rando', tier: 'official' },
    }) as Awaited<ReturnType<PluginManager['install']>>;

    expect((record as { marketplace?: unknown }).marketplace).toBeUndefined();
  });

  it('install() from github URL overwrites an existing zip-url install (CDN migration)', async () => {
    const home = await makeCloudCodeHome();

    // Original CDN install.
    const cdnZip = await createZipBuffer([
      { name: 'pkg/kimi.plugin.json', data: JSON.stringify({ name: 'superpowers', version: '5.0.0' }) },
    ]);
    const cdnUrl = await serveOnce(cdnZip);

    const manager = new PluginManager({ cloudCodeHomeDir: home });
    await manager.load();
    const first = await manager.install(cdnUrl);
    expect(first.source).toBe('zip-url');
    await manager.setEnabled('superpowers', false);

    const ghZip = await createZipBuffer([
      { name: 'pkg/kimi.plugin.json', data: JSON.stringify({ name: 'superpowers', version: '5.1.0' }) },
    ]);
    using _ = mockGithubFetch({
      releaseTag: 'v5.1.0',
      tarball: ghZip,
    });
    const updated = await manager.install('https://github.com/wbxl2000/superpowers');

    expect(updated.source).toBe('github');
    expect(updated.manifest?.version).toBe('5.1.0');
    expect(updated.enabled).toBe(false); // preserved
    expect(updated.installedAt).toBe(first.installedAt); // preserved
    expect(updated.originalSource).toBe('https://github.com/wbxl2000/superpowers');
    expect(updated.github?.ref).toEqual({ kind: 'tag', value: 'v5.1.0' });
    expect(manager.list()).toHaveLength(1);
  });

  it('enabledHooks() returns hooks from enabled plugins with cwd and env injected', async () => {
    const home = await makeCloudCodeHome();
    const root = await makePlugin('demo', {
      hooks: [{ event: 'PreToolUse', command: './hooks/guard.sh', timeout: 10 }],
    });
    const manager = new PluginManager({ cloudCodeHomeDir: home });
    await manager.load();
    await manager.install(root);
    const installedRoot = await managedPluginRoot(home, 'demo');
    expect(manager.enabledHooks()).toEqual([
      {
        event: 'PreToolUse',
        command: './hooks/guard.sh',
        timeout: 10,
        cwd: installedRoot,
        env: {
          CLOUD_CODE_HOME: home,
          KIMI_PLUGIN_ROOT: installedRoot,
          CLAUDE_PLUGIN_ROOT: installedRoot,
          CLAUDE_PLUGIN_DATA: path.join(home, 'plugins', 'data', 'demo'),
        },
      },
    ]);
  });

  it('enabledHooks() excludes disabled plugins', async () => {
    const home = await makeCloudCodeHome();
    const root = await makePlugin('demo', {
      hooks: [{ event: 'PreToolUse', command: './x.sh' }],
    });
    const manager = new PluginManager({ cloudCodeHomeDir: home });
    await manager.load();
    await manager.install(root);
    await manager.setEnabled('demo', false);
    expect(manager.enabledHooks()).toEqual([]);
  });

  it('summaries() include hookCount', async () => {
    const home = await makeCloudCodeHome();
    const root = await makePlugin('demo', {
      hooks: [
        { event: 'PreToolUse', command: './a.sh' },
        { event: 'Stop', command: './b.sh' },
      ],
    });
    const manager = new PluginManager({ cloudCodeHomeDir: home });
    await manager.load();
    await manager.install(root);
    expect(manager.summaries()[0]?.hookCount).toBe(2);
  });

  it('enabledCommands() returns parsed commands from enabled plugins', async () => {
    const home = await makeCloudCodeHome();
    const root = await makePlugin('demo', {
      commands: {
        'deploy.md': '---\ndescription: Deploy\n---\nDeploy with $ARGUMENTS',
        'env.md': '---\ndescription: Env\n---\nManage env',
      },
    });
    const manager = new PluginManager({ cloudCodeHomeDir: home });
    await manager.load();
    await manager.install(root);
    const commands = await manager.enabledCommands();
    expect(commands.map((c) => ({ pluginId: c.pluginId, name: c.name, description: c.description }))).toEqual(
      expect.arrayContaining([
        { pluginId: 'demo', name: 'deploy', description: 'Deploy' },
        { pluginId: 'demo', name: 'env', description: 'Env' },
      ]),
    );
    expect(commands.find((c) => c.name === 'deploy')?.body).toBe('Deploy with $ARGUMENTS');
  });

  it('enabledCommands() preserves the relative-path namespace for nested commands', async () => {
    const home = await makeCloudCodeHome();
    const root = await makePlugin('demo', {
      commands: {
        'deploy.md': '---\ndescription: Deploy\n---\nbody',
        'frontend/component.md': '---\ndescription: Component\n---\nbody',
      },
    });
    const manager = new PluginManager({ cloudCodeHomeDir: home });
    await manager.load();
    await manager.install(root);
    const commands = await manager.enabledCommands();
    expect(commands.map((c) => c.name).toSorted()).toEqual(['deploy', 'frontend/component']);
  });

  it('enabledCommands() excludes disabled plugins', async () => {
    const home = await makeCloudCodeHome();
    const root = await makePlugin('demo', {
      commands: { 'deploy.md': '---\ndescription: Deploy\n---\nbody' },
    });
    const manager = new PluginManager({ cloudCodeHomeDir: home });
    await manager.load();
    await manager.install(root);
    await manager.setEnabled('demo', false);
    expect(await manager.enabledCommands()).toEqual([]);
  });

  it('summaries() include commandCount', async () => {
    const home = await makeCloudCodeHome();
    const root = await makePlugin('demo', {
      commands: {
        'a.md': '---\ndescription: A\n---\nbody',
        'b.md': '---\ndescription: B\n---\nbody',
      },
    });
    const manager = new PluginManager({ cloudCodeHomeDir: home });
    await manager.load();
    await manager.install(root);
    expect(manager.summaries()[0]?.commandCount).toBe(2);
  });
});

describe('PluginManager (Claude Code format)', () => {
  async function makeClaudePlugin(name: string): Promise<string> {
    const root = await mkdtemp(path.join(tmpdir(), `claude-plugin-${name}-`));
    const files: Record<string, string> = {
      '.claude-plugin/plugin.json': JSON.stringify({
        name,
        version: '2.0.0',
        commands: {
          hello: { content: 'Say hello to $ARGUMENTS', description: 'Greets' },
        },
        mcpServers: {
          tool: { type: 'stdio', command: 'npx', args: ['-y', 'tool-server'] },
        },
      }),
      'commands/build.md': '---\ndescription: Build\n---\nBuild the thing.',
      'agents/reviewer.md': '---\nname: reviewer\ndescription: Reviews\n---\nReview code.',
      'skills/deploy/SKILL.md': '---\nname: deploy\ndescription: Deploys\n---\nDeploy.',
      'outputStyles/terse.md': '---\nname: terse\ndescription: Terse\n---\nBe brief.',
      'hooks/hooks.json': JSON.stringify({
        hooks: {
          PreToolUse: [
            { matcher: 'Bash', hooks: [{ type: 'command', command: './guard.sh' }] },
          ],
        },
      }),
    };
    for (const [rel, body] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
      await writeFile(path.join(root, rel), body, 'utf8');
    }
    return realpath(root);
  }

  it('installs a .claude-plugin plugin and exposes every component type', async () => {
    const home = await makeCloudCodeHome();
    const root = await makeClaudePlugin('cc-demo');
    const manager = new PluginManager({ cloudCodeHomeDir: home });
    await manager.load();
    const record = await manager.install(root);

    expect(record.manifestKind).toBe('claude-plugin');
    expect(record.state).toBe('ok');
    const installedRoot = await managedPluginRoot(home, 'cc-demo');

    expect(manager.pluginSkillRoots().map((r) => r.path)).toEqual([
      path.join(installedRoot, 'skills'),
    ]);
    expect(manager.pluginAgentDirs()).toEqual([
      { pluginId: 'cc-demo', path: path.join(installedRoot, 'agents') },
    ]);
    expect(manager.pluginOutputStyleDirs()).toEqual([
      { pluginId: 'cc-demo', path: path.join(installedRoot, 'outputStyles') },
    ]);
    expect(manager.enabledHooks()).toEqual([
      {
        event: 'PreToolUse',
        matcher: 'Bash',
        command: './guard.sh',
        cwd: installedRoot,
        env: {
          CLOUD_CODE_HOME: home,
          KIMI_PLUGIN_ROOT: installedRoot,
          CLAUDE_PLUGIN_ROOT: installedRoot,
          CLAUDE_PLUGIN_DATA: path.join(home, 'plugins', 'data', 'cc-demo'),
        },
      },
    ]);
    const mcp = manager.enabledMcpServers();
    expect(Object.keys(mcp)).toEqual(['plugin-cc-demo:tool']);
    expect(mcp['plugin-cc-demo:tool']).toMatchObject({
      transport: 'stdio',
      command: 'npx',
      cwd: installedRoot,
    });

    const commands = await manager.enabledCommands();
    // The manifest `commands` declaration replaces `commands/` auto-discovery
    // (CC semantics), so the auto-discovered build.md is not loaded here.
    expect(commands.map((c) => c.name).toSorted()).toEqual(['hello']);
    const inline = commands.find((c) => c.name === 'hello');
    expect(inline?.body).toBe('Say hello to $ARGUMENTS');
    expect(inline?.description).toBe('Greets');
  });

  it('auto-discovers commands/ when the manifest does not declare commands', async () => {
    const home = await makeCloudCodeHome();
    const root = await mkdtemp(path.join(tmpdir(), 'claude-plugin-cmds-'));
    await mkdir(path.join(root, '.claude-plugin'), { recursive: true });
    await writeFile(
      path.join(root, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'cc-cmds' }),
      'utf8',
    );
    await mkdir(path.join(root, 'commands'), { recursive: true });
    await writeFile(
      path.join(root, 'commands', 'build.md'),
      '---\ndescription: Build\n---\nBuild the thing.',
      'utf8',
    );
    const manager = new PluginManager({ cloudCodeHomeDir: home });
    await manager.load();
    await manager.install(root);
    const commands = await manager.enabledCommands();
    expect(commands.map((c) => c.name)).toEqual(['build']);
    expect(commands[0]?.body).toBe('Build the thing.');
  });

  it('info() reports the claude-plugin manifest kind', async () => {
    const home = await makeCloudCodeHome();
    const root = await makeClaudePlugin('cc-info');
    const manager = new PluginManager({ cloudCodeHomeDir: home });
    await manager.load();
    await manager.install(root);
    expect(manager.info('cc-info')?.manifestKind).toBe('claude-plugin');
    expect(manager.info('cc-info')?.mcpServers.map((s) => s.name)).toEqual(['tool']);
  });
});

describe('PluginManager project scope', () => {
  async function makeProject(): Promise<string> {
    const root = await mkdtemp(path.join(tmpdir(), 'plugin-project-'));
    await mkdir(path.join(root, '.git'));
    return realpath(root);
  }

  it('project disable filters components for that project only', async () => {
    const home = await makeCloudCodeHome();
    const project = await makeProject();
    const root = await makePlugin('demo', { skills: true, commands: { 'a.md': 'body' } });
    const manager = new PluginManager({ cloudCodeHomeDir: home });
    await manager.load();
    await manager.install(root);

    await manager.setProjectEnabled('demo', false, project);
    const scope = await manager.resolveEnableScope(project);
    expect(scope.projectRoot).toBe(project);
    expect(manager.pluginSkillRoots(scope)).toEqual([]);
    expect(await manager.enabledCommands(scope)).toEqual([]);
    // User-level (unscoped) queries still see the plugin.
    expect(manager.pluginSkillRoots()).toHaveLength(1);
    expect(manager.isEnabled('demo')).toBe(true);
    expect(manager.isEnabled('demo', scope)).toBe(false);
  });

  it('project enable wins over a user-level disabled plugin', async () => {
    const home = await makeCloudCodeHome();
    const project = await makeProject();
    const root = await makePlugin('demo', { skills: true });
    const manager = new PluginManager({ cloudCodeHomeDir: home });
    await manager.load();
    await manager.install(root);
    await manager.setEnabled('demo', false);
    expect(manager.pluginSkillRoots()).toEqual([]);

    await manager.setProjectEnabled('demo', true, project);
    const scope = await manager.resolveEnableScope(project);
    expect(manager.pluginSkillRoots(scope)).toHaveLength(1);
    expect(manager.isEnabled('demo', scope)).toBe(true);
  });

  it('overrides persist on disk and are picked up after reload', async () => {
    const home = await makeCloudCodeHome();
    const project = await makeProject();
    const root = await makePlugin('demo', { skills: true });
    let manager = new PluginManager({ cloudCodeHomeDir: home });
    await manager.load();
    await manager.install(root);
    await manager.setProjectEnabled('demo', false, path.join(project, 'sub', 'dir'));

    manager = new PluginManager({ cloudCodeHomeDir: home });
    await manager.load();
    const scope = await manager.resolveEnableScope(project);
    expect(manager.isEnabled('demo', scope)).toBe(false);
  });

  it('setProjectEnabled rejects unknown plugins', async () => {
    const home = await makeCloudCodeHome();
    const project = await makeProject();
    const manager = new PluginManager({ cloudCodeHomeDir: home });
    await manager.load();
    await expect(manager.setProjectEnabled('nope', true, project)).rejects.toThrow(
      'Plugin "nope" is not installed',
    );
  });
});

describe('PluginManager.update()', () => {
  const SHA1 = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const SHA2 = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

  async function pluginZip(name: string, version: string): Promise<Buffer> {
    return createZipBuffer([
      { name: 'plugin/kimi.plugin.json', data: JSON.stringify({ name, version }) },
    ]);
  }

  it('records installedSha at install time for sha-pinned sources and no-ops on update', async () => {
    const home = await makeCloudCodeHome();
    let downloads = 0;
    using _ = mockGithubFetch({
      tarball: await pluginZip('gh-demo', '1.0.0'),
      commitSha: SHA1,
      onCodeload: () => {
        downloads += 1;
      },
    });

    const manager = new PluginManager({ cloudCodeHomeDir: home });
    await manager.load();
    const record = await manager.install(`https://github.com/wbxl2000/superpowers/tree/${SHA1}`);
    expect(record.github?.installedSha).toBe(SHA1);
    expect(downloads).toBe(1);

    const result = await manager.update('gh-demo');
    expect(result.updated).toBe(false);
    expect(result.sha).toBe(SHA1);
    expect(result.previousSha).toBe(SHA1);
    // No second download: the sha comparison settled it.
    expect(downloads).toBe(1);
  });

  it('re-materializes when upstream moved, preserving enablement and install time', async () => {
    const home = await makeCloudCodeHome();
    const options = {
      releaseTag: 'v1.0.0',
      tarball: await pluginZip('gh-demo', '1.0.0'),
      commitSha: SHA1,
    };
    using _ = mockGithubFetch(options);

    const manager = new PluginManager({ cloudCodeHomeDir: home });
    await manager.load();
    const installed = await manager.install('https://github.com/wbxl2000/superpowers');
    // Bare-URL install: no content identity was knowable without an API call.
    expect(installed.github?.installedSha).toBeUndefined();
    await manager.setEnabled('gh-demo', false);

    // Upstream moves: new latest release tag, new tarball, new sha.
    options.releaseTag = 'v2.0.0';
    options.tarball = await pluginZip('gh-demo', '2.0.0');
    options.commitSha = SHA2;

    const result = await manager.update('gh-demo');
    expect(result.updated).toBe(true);
    expect(result.previousSha).toBeUndefined();
    expect(result.sha).toBe(SHA2);
    expect(result.ref).toEqual({ kind: 'tag', value: 'v2.0.0' });
    expect(result.record.manifest?.version).toBe('2.0.0');
    expect(result.record.enabled).toBe(false);
    expect(result.record.installedAt).toBe(installed.installedAt);
    expect(result.record.github?.installedSha).toBe(SHA2);

    // Persisted: a fresh manager sees the same state, and a second update
    // against the same sha no-ops.
    const reloaded = new PluginManager({ cloudCodeHomeDir: home });
    await reloaded.load();
    const record = reloaded.get('gh-demo');
    expect(record?.manifest?.version).toBe('2.0.0');
    expect(record?.github?.installedSha).toBe(SHA2);

    const again = await reloaded.update('gh-demo');
    expect(again.updated).toBe(false);
  });

  it('throws for plugins that are not GitHub-sourced', async () => {
    const home = await makeCloudCodeHome();
    const root = await makePlugin('demo');
    const manager = new PluginManager({ cloudCodeHomeDir: home });
    await manager.load();
    await manager.install(root);

    await expect(manager.update('demo')).rejects.toThrow(/GitHub/);
  });

  it('rejects a mid-update rename before overwriting the managed root', async () => {
    const home = await makeCloudCodeHome();
    const options = {
      releaseTag: 'v1.0.0',
      tarball: await pluginZip('gh-demo', '1.0.0'),
      commitSha: SHA1,
    };
    using _ = mockGithubFetch(options);

    const manager = new PluginManager({ cloudCodeHomeDir: home });
    await manager.load();
    await manager.install('https://github.com/wbxl2000/superpowers');

    // Upstream published a plugin with a DIFFERENT manifest name.
    options.releaseTag = 'v2.0.0';
    options.tarball = await pluginZip('renamed-plugin', '2.0.0');
    options.commitSha = SHA2;

    await expect(manager.update('gh-demo')).rejects.toThrow(/different/i);
    // The old content is untouched.
    expect(manager.get('gh-demo')?.manifest?.version).toBe('1.0.0');
    expect(manager.get('renamed-plugin')).toBeUndefined();
  });

  it('surfaces GitHub API errors loudly instead of guessing', async () => {
    const home = await makeCloudCodeHome();
    let shaLookupFailed = false;
    const tarball = await pluginZip('gh-demo', '1.0.0');
    const original = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith('https://api.github.com/')) {
        shaLookupFailed = true;
        return new Response(null, { status: 403, statusText: 'Forbidden' });
      }
      if (/^https:\/\/github\.com\/[^/]+\/[^/]+\/releases\/latest$/.test(url)) {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://github.com/wbxl2000/superpowers/releases/tag/v1.0.0' },
        });
      }
      if (url.startsWith('https://codeload.github.com/')) {
        return new Response(tarball, { status: 200 });
      }
      throw new Error(`unexpected url ${url}`);
    }) as typeof fetch;
    try {
      const manager = new PluginManager({ cloudCodeHomeDir: home });
      await manager.load();
      await manager.install('https://github.com/wbxl2000/superpowers');
      await expect(manager.update('gh-demo')).rejects.toThrow(/HTTP 403/);
      expect(shaLookupFailed).toBe(true);
    } finally {
      globalThis.fetch = original;
    }
  });
});

interface MockGithubFetchOptions {
  /** Tag name to advertise via the github.com/.../releases/latest redirect. */
  releaseTag?: string;
  tarball: Buffer;
  /** When set, `api.github.com/repos/.../commits/*` answers `{ sha: commitSha }`. */
  commitSha?: string;
  /** Optional hook to count requests against `github.com`. */
  onReleaseLookup?: () => void;
  /** Optional hook to count tarball downloads against `codeload.github.com`. */
  onCodeload?: () => void;
}

function mockGithubFetch(options: MockGithubFetchOptions): { [Symbol.dispose](): void } {
  const original = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (/^https:\/\/github\.com\/[^/]+\/[^/]+\/releases\/latest$/.test(url)) {
      options.onReleaseLookup?.();
      if (options.releaseTag === undefined) {
        return new Response(null, { status: 404 });
      }
      const tagUrl = url.replace(/\/releases\/latest$/, `/releases/tag/${options.releaseTag}`);
      return new Response(null, {
        status: 302,
        headers: { location: tagUrl },
      });
    }
    if (/^https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+\/commits\//.test(url)) {
      if (options.commitSha === undefined) {
        return new Response(null, { status: 404, statusText: 'Not Found' });
      }
      return new Response(JSON.stringify({ sha: options.commitSha }), { status: 200 });
    }
    if (url.startsWith('https://codeload.github.com/')) {
      // HEAD probe used by the no-release fallback path returns headers only.
      if (init?.method === 'HEAD') {
        return new Response(null, { status: 200 });
      }
      options.onCodeload?.();
      return new Response(options.tarball, { status: 200 });
    }
    throw new Error(`mockGithubFetch: unexpected url ${url}`);
  }) as typeof fetch;
  return {
    [Symbol.dispose]() {
      globalThis.fetch = original;
    },
  };
}

async function createZipBuffer(entries: Array<{ name: string; data: string | Buffer }>): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const zipfile = new yazl.ZipFile();
    const chunks: Buffer[] = [];
    zipfile.outputStream.on('data', (chunk) => chunks.push(chunk));
    zipfile.outputStream.on('end', () => {
      resolve(Buffer.concat(chunks));
    });
    zipfile.outputStream.on('error', reject);
    for (const entry of entries) {
      zipfile.addBuffer(Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data), entry.name);
    }
    zipfile.end();
  });
}

async function serveOnce(buffer: Buffer): Promise<string> {
  const { createServer } = await import('node:http');
  return new Promise((resolve) => {
    const server = createServer((_, res) => {
      res.writeHead(200, { 'Content-Type': 'application/zip' });
      res.end(buffer);
      server.close();
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()!;
      resolve(`http://127.0.0.1:${(addr as any).port}`);
    });
  });
}
