import { mkdtemp, mkdir, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseManifest } from '../../src/plugin/manifest';

async function makePlugin(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'claude-plugin-test-'));
  for (const [rel, body] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await writeFile(path.join(root, rel), body, 'utf8');
  }
  return realpath(root);
}

function claudeManifest(fields: Record<string, unknown>): string {
  return JSON.stringify(fields);
}

describe('parseManifest (Claude Code format)', () => {
  it('reads a minimal .claude-plugin/plugin.json', async () => {
    const root = await makePlugin({
      '.claude-plugin/plugin.json': claudeManifest({ name: 'demo', version: '1.2.3' }),
    });
    const result = await parseManifest(root);
    expect(result.manifestKind).toBe('claude-plugin');
    expect(result.manifestPath).toBe(path.join(root, '.claude-plugin', 'plugin.json'));
    expect(result.manifest?.name).toBe('demo');
    expect(result.manifest?.version).toBe('1.2.3');
    expect(result.diagnostics).toEqual([]);
  });

  it('maps metadata fields and falls back from repository to homepage', async () => {
    const root = await makePlugin({
      '.claude-plugin/plugin.json': claudeManifest({
        name: 'demo',
        description: 'A demo plugin',
        keywords: ['a', 'b'],
        license: 'MIT',
        repository: 'https://github.com/acme/demo',
        author: { name: 'Acme', email: 'a@acme.dev', url: 'https://acme.dev' },
      }),
    });
    const result = await parseManifest(root);
    expect(result.manifest?.description).toBe('A demo plugin');
    expect(result.manifest?.keywords).toEqual(['a', 'b']);
    expect(result.manifest?.license).toBe('MIT');
    expect(result.manifest?.homepage).toBe('https://github.com/acme/demo');
    expect(result.manifest?.author).toEqual({ name: 'Acme', email: 'a@acme.dev' });
  });

  it('prefers an explicit homepage over repository', async () => {
    const root = await makePlugin({
      '.claude-plugin/plugin.json': claudeManifest({
        name: 'demo',
        homepage: 'https://demo.dev',
        repository: 'https://github.com/acme/demo',
      }),
    });
    const result = await parseManifest(root);
    expect(result.manifest?.homepage).toBe('https://demo.dev');
  });

  it('lowercases mixed-case names and rejects whitespace', async () => {
    const mixed = await makePlugin({
      '.claude-plugin/plugin.json': claudeManifest({ name: 'MyPlugin' }),
    });
    const mixedResult = await parseManifest(mixed);
    expect(mixedResult.manifest?.name).toBe('myplugin');
    expect(mixedResult.diagnostics).toEqual([]);

    const spaced = await makePlugin({
      '.claude-plugin/plugin.json': claudeManifest({ name: 'my plugin' }),
    });
    const spacedResult = await parseManifest(spaced);
    expect(spacedResult.manifest).toBeUndefined();
    expect(spacedResult.diagnostics).toContainEqual(
      expect.objectContaining({ severity: 'error', message: expect.stringContaining('whitespace') }),
    );
  });

  it('rejects names outside the native id charset', async () => {
    const root = await makePlugin({
      '.claude-plugin/plugin.json': claudeManifest({ name: 'my.plugin' }),
    });
    const result = await parseManifest(root);
    expect(result.manifest).toBeUndefined();
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ severity: 'error', message: expect.stringContaining('must match') }),
    );
  });

  it('auto-discovers commands/, agents/, skills/, hooks/hooks.json and .mcp.json', async () => {
    const root = await makePlugin({
      '.claude-plugin/plugin.json': claudeManifest({ name: 'demo' }),
      'commands/build.md': '---\ndescription: Build it\n---\nBuild the thing.',
      'commands/frontend/lint.md': 'Lint the frontend.',
      'agents/reviewer.md': '---\nname: reviewer\ndescription: Reviews\n---\nReview code.',
      'skills/deploy/SKILL.md': '---\nname: deploy\ndescription: Deploys\n---\nDeploy.',
      'outputStyles/terse.md': '---\nname: terse\ndescription: Terse\n---\nBe brief.',
      'hooks/hooks.json': JSON.stringify({
        description: 'guard hooks',
        hooks: {
          PreToolUse: [
            { matcher: 'Bash', hooks: [{ type: 'command', command: './guard.sh', timeout: 10 }] },
          ],
        },
      }),
      '.mcp.json': JSON.stringify({
        mcpServers: { remote: { type: 'http', url: 'https://mcp.example.com' } },
      }),
    });
    const result = await parseManifest(root);
    expect(result.diagnostics).toEqual([]);
    expect(result.manifest?.commands?.map((entry) => entry.name)).toEqual(['build', 'frontend/lint']);
    expect(result.manifest?.agents).toEqual([path.join(root, 'agents')]);
    expect(result.manifest?.skills).toEqual([path.join(root, 'skills')]);
    expect(result.manifest?.outputStyles).toEqual([path.join(root, 'outputStyles')]);
    expect(result.manifest?.hooks).toEqual([
      { event: 'PreToolUse', matcher: 'Bash', command: './guard.sh', timeout: 10 },
    ]);
    expect(result.manifest?.mcpServers).toEqual({
      remote: { transport: 'http', url: 'https://mcp.example.com' },
    });
  });

  it('resolves a declared outputStyles dir list and diagnoses escapes', async () => {
    const root = await makePlugin({
      '.claude-plugin/plugin.json': claudeManifest({ name: 'demo', outputStyles: ['./styles'] }),
      'styles/terse.md': '---\nname: terse\n---\nBe brief.',
    });
    const result = await parseManifest(root);
    expect(result.manifest?.outputStyles).toEqual([path.join(root, 'styles')]);
    expect(result.diagnostics).toEqual([]);

    const escapeRoot = await makePlugin({
      '.claude-plugin/plugin.json': claudeManifest({ name: 'demo', outputStyles: ['/etc'] }),
    });
    const escapeResult = await parseManifest(escapeRoot);
    expect(escapeResult.manifest?.outputStyles).toEqual([]);
    expect(escapeResult.diagnostics.length).toBeGreaterThan(0);
  });

  it('prefers manifest-declared components over auto-discovery', async () => {
    const root = await makePlugin({
      '.claude-plugin/plugin.json': claudeManifest({ name: 'demo', skills: './extra-skills' }),
      'skills/ignored/SKILL.md': '---\nname: ignored\ndescription: x\n---\nx',
      'extra-skills/kept/SKILL.md': '---\nname: kept\ndescription: x\n---\nx',
    });
    const result = await parseManifest(root);
    expect(result.manifest?.skills).toEqual([path.join(root, 'extra-skills')]);
  });

  it('maps agent .md file entries to their parent directories, deduped', async () => {
    const root = await makePlugin({
      '.claude-plugin/plugin.json': claudeManifest({
        name: 'demo',
        agents: ['./agents/a.md', './agents/b.md'],
      }),
      'agents/a.md': '---\nname: a\ndescription: A\n---\na',
      'agents/b.md': '---\nname: b\ndescription: B\n---\nb',
    });
    const result = await parseManifest(root);
    expect(result.manifest?.agents).toEqual([path.join(root, 'agents')]);
  });

  it('reads the commands object-mapping form with source, description and inline content', async () => {
    const root = await makePlugin({
      '.claude-plugin/plugin.json': claudeManifest({
        name: 'demo',
        commands: {
          about: { source: './docs/about.md', description: 'About this plugin' },
          hello: { content: 'Say hello to $ARGUMENTS' },
        },
      }),
      'docs/about.md': '---\ndescription: ignored\n---\nAll about it.',
    });
    const result = await parseManifest(root);
    expect(result.diagnostics).toEqual([]);
    expect(result.manifest?.commands).toEqual([
      { path: path.join(root, 'docs', 'about.md'), name: 'about', description: 'About this plugin' },
      { name: 'hello', content: 'Say hello to $ARGUMENTS', description: undefined },
    ]);
  });

  it('warns when a command entry declares both source and content', async () => {
    const root = await makePlugin({
      '.claude-plugin/plugin.json': claudeManifest({
        name: 'demo',
        commands: { bad: { source: './x.md', content: 'x' } },
      }),
      'x.md': 'x',
    });
    const result = await parseManifest(root);
    expect(result.manifest?.commands).toBeUndefined();
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: 'warn',
        message: expect.stringContaining('either "source" or "content"'),
      }),
    );
  });

  it('converts nested hooks, substitutes ${CLAUDE_PLUGIN_ROOT} and passes if through', async () => {
    const root = await makePlugin({
      '.claude-plugin/plugin.json': claudeManifest({
        name: 'demo',
        hooks: {
          SessionStart: [
            {
              hooks: [
                { type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/bin/init.sh', if: 'Bash(git *)' },
              ],
            },
          ],
        },
      }),
    });
    const result = await parseManifest(root);
    expect(result.manifest?.hooks).toEqual([
      {
        event: 'SessionStart',
        if: 'Bash(git *)',
        command: `${root}/bin/init.sh`,
      },
    ]);
  });

  it('skips unknown hook events and non-command hook types with warnings', async () => {
    const root = await makePlugin({
      '.claude-plugin/plugin.json': claudeManifest({ name: 'demo' }),
      'hooks/hooks.json': JSON.stringify({
        hooks: {
          WorktreeCreate: [{ hooks: [{ type: 'command', command: './x.sh' }] }],
          Stop: [
            {
              matcher: 'x',
              hooks: [
                { type: 'prompt', prompt: 'check' },
                { type: 'command', command: './stop.sh' },
              ],
            },
          ],
        },
      }),
    });
    const result = await parseManifest(root);
    expect(result.manifest?.hooks).toEqual([{ event: 'Stop', matcher: 'x', command: './stop.sh' }]);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: 'warn',
        message: expect.stringContaining('Unsupported hook event "WorktreeCreate"'),
      }),
    );
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: 'warn',
        message: expect.stringContaining('Unsupported hook type "prompt"'),
      }),
    );
  });

  it('loads manifest-declared hooks files in addition to hooks/hooks.json', async () => {
    const root = await makePlugin({
      '.claude-plugin/plugin.json': claudeManifest({ name: 'demo', hooks: './extra/hooks.json' }),
      'hooks/hooks.json': JSON.stringify({
        hooks: { PreCompact: [{ hooks: [{ type: 'command', command: './a.sh' }] }] },
      }),
      'extra/hooks.json': JSON.stringify({
        hooks: { PostCompact: [{ hooks: [{ type: 'command', command: './b.sh' }] }] },
      }),
    });
    const result = await parseManifest(root);
    expect(result.manifest?.hooks).toEqual([
      { event: 'PreCompact', command: './a.sh' },
      { event: 'PostCompact', command: './b.sh' },
    ]);
  });

  it('merges .mcp.json with manifest mcpServers, manifest winning per server', async () => {
    const root = await makePlugin({
      '.claude-plugin/plugin.json': claudeManifest({
        name: 'demo',
        mcpServers: { local: { type: 'stdio', command: './server.mjs', args: ['--fast'] } },
      }),
      '.mcp.json': JSON.stringify({
        mcpServers: {
          local: { type: 'stdio', command: 'node', args: ['server.js'] },
          extra: { url: 'https://mcp.example.com/sse', type: 'sse' },
        },
      }),
      'server.mjs': '// server',
    });
    const result = await parseManifest(root);
    expect(result.diagnostics).toEqual([]);
    expect(result.manifest?.mcpServers?.['local']).toMatchObject({
      transport: 'stdio',
      command: path.join(root, 'server.mjs'),
      args: ['--fast'],
    });
    expect(result.manifest?.mcpServers?.['extra']).toMatchObject({
      transport: 'sse',
      url: 'https://mcp.example.com/sse',
    });
  });

  it('substitutes ${CLAUDE_PLUGIN_ROOT} inside MCP server configs', async () => {
    const root = await makePlugin({
      '.claude-plugin/plugin.json': claudeManifest({
        name: 'demo',
        mcpServers: {
          tool: { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/server.js'], env: { ROOT: '${CLAUDE_PLUGIN_ROOT}' } },
        },
      }),
    });
    const result = await parseManifest(root);
    expect(result.manifest?.mcpServers?.['tool']).toMatchObject({
      transport: 'stdio',
      command: 'node',
      args: [`${root}/server.js`],
      env: { ROOT: root },
    });
  });

  it('accepts a .mcp.json without the mcpServers wrapper', async () => {
    const root = await makePlugin({
      '.claude-plugin/plugin.json': claudeManifest({ name: 'demo' }),
      '.mcp.json': JSON.stringify({ plain: { command: 'npx', args: ['-y', 'plain-server'] } }),
    });
    const result = await parseManifest(root);
    expect(result.manifest?.mcpServers?.['plain']).toMatchObject({
      transport: 'stdio',
      command: 'npx',
    });
  });

  it('reports MCPB bundles and unsupported CC fields as info diagnostics', async () => {
    const root = await makePlugin({
      '.claude-plugin/plugin.json': claudeManifest({
        name: 'demo',
        mcpServers: './bundle.mcpb',
        lspServers: { ts: {} },
        userConfig: { KEY: {} },
        dependencies: ['other-plugin'],
      }),
    });
    const result = await parseManifest(root);
    for (const fragment of ['MCPB bundle', 'lspServers', 'userConfig', 'dependencies']) {
      expect(result.diagnostics).toContainEqual(
        expect.objectContaining({ severity: 'info', message: expect.stringContaining(fragment) }),
      );
    }
  });

  it('reports invalid MCP server entries as warnings and keeps the valid ones', async () => {
    const root = await makePlugin({
      '.claude-plugin/plugin.json': claudeManifest({
        name: 'demo',
        mcpServers: {
          good: { command: 'npx' },
          bad: { nothing: true },
        },
      }),
    });
    const result = await parseManifest(root);
    expect(Object.keys(result.manifest?.mcpServers ?? {})).toEqual(['good']);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: 'warn',
        message: expect.stringContaining('Invalid MCP server "bad"'),
      }),
    );
  });

  it('native kimi.plugin.json wins when both formats are present', async () => {
    const root = await makePlugin({
      'kimi.plugin.json': claudeManifest({ name: 'native-one' }),
      '.claude-plugin/plugin.json': claudeManifest({ name: 'claude-one' }),
    });
    const result = await parseManifest(root);
    expect(result.manifestKind).toBe('kimi-plugin-root');
    expect(result.manifest?.name).toBe('native-one');
  });

  it('falls back to .claude-plugin/plugin.json when no native manifest exists', async () => {
    const root = await makePlugin({
      '.claude-plugin/plugin.json': claudeManifest({ name: 'claude-one' }),
    });
    const result = await parseManifest(root);
    expect(result.manifestKind).toBe('claude-plugin');
    expect(result.manifest?.name).toBe('claude-one');
  });

  it('mentions all manifest locations when none exists', async () => {
    const root = await makePlugin({});
    const result = await parseManifest(root);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: 'error',
        message: expect.stringContaining('.claude-plugin/plugin.json'),
      }),
    );
  });
});
