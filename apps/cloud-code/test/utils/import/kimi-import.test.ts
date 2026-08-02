import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse as parseToml } from 'smol-toml';

import {
  applyKimiImportPlan,
  buildKimiImportPlan,
  countPlannedImports,
} from '#/utils/import/kimi-import';
import { encodeWorkDirKey } from '#/utils/import/workdir-key';

const WIRE_14 = [
  JSON.stringify({ type: 'metadata', protocol_version: '1.4', created_at: 1 }),
  JSON.stringify({ type: 'turn.prompt', content: 'hello' }),
].join('\n');

/** Build a representative ~/.kimi-code fixture. */
async function makeSourceHome(home: string): Promise<void> {
  await writeFile(
    join(home, 'config.toml'),
    [
      'default_model = "kimi-code/kimi-for-coding"',
      'default_provider = "managed:kimi-code"',
      'yolo = true',
      '',
      '[providers."managed:kimi-code"]',
      'type = "kimi"',
      '',
      '[models."kimi-code/kimi-for-coding"]',
      'provider = "managed:kimi-code"',
      'model = "kimi-for-coding"',
      'maxContextSize = 262144',
      '',
    ].join('\n'),
    'utf-8',
  );
  await writeFile(join(home, 'keybindings.json'), '{"app.exit": ["ctrl+c"], "editor.undo": "ctrl+z"}\n', 'utf-8');
  await writeFile(join(home, 'mcp.json'), '{"mcpServers": {"context7": {"command": "npx", "args": ["-y", "@upstash/context7-mcp"]}}}\n', 'utf-8');
  await writeFile(join(home, 'AGENTS.md'), '# imported rules\n', 'utf-8');

  const skillDir = join(home, 'skills', 'upstream-skill');
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    join(skillDir, 'SKILL.md'),
    '---\nname: upstream-skill\ndescription: from upstream\n---\n# body\n',
    'utf-8',
  );

  const sessionDir = join(home, 'sessions', encodeWorkDirKey('/work/proj-a'), 'session_1');
  await mkdir(join(sessionDir, 'agents', 'main'), { recursive: true });
  await writeFile(
    join(sessionDir, 'state.json'),
    JSON.stringify({
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      title: 'Upstream session',
      isCustomTitle: true,
      workDir: '/work/proj-a',
      agents: { main: { homedir: `${sessionDir}/agents/main`, type: 'main' } },
      custom: {},
    }),
    'utf-8',
  );
  await writeFile(join(sessionDir, 'agents', 'main', 'wire.jsonl'), WIRE_14, 'utf-8');

  await mkdir(join(home, 'user-history'), { recursive: true });
  await writeFile(
    join(home, 'user-history', 'abc.jsonl'),
    `${JSON.stringify({ content: 'upstream prompt' })}\n`,
    'utf-8',
  );

  await mkdir(join(home, 'credentials'), { recursive: true });
  await writeFile(join(home, 'credentials', 'kimi-code.json'), '{"access_token":"tok"}', 'utf-8');
}

describe('kimi import end-to-end', () => {
  let sourceHome: string;
  let targetHome: string;

  beforeEach(async () => {
    sourceHome = await mkdtemp(join(tmpdir(), 'cc-import-src-'));
    targetHome = await mkdtemp(join(tmpdir(), 'cc-import-dst-'));
    await makeSourceHome(sourceHome);
  });
  afterEach(async () => {
    await rm(sourceHome, { recursive: true, force: true });
    await rm(targetHome, { recursive: true, force: true });
  });

  it('plans every category and applies without touching credentials by default', async () => {
    // Target already holds one conflicting config key and one keybinding.
    await writeFile(join(targetHome, 'config.toml'), 'yolo = false\n', 'utf-8');
    await writeFile(join(targetHome, 'keybindings.json'), '{"app.exit": ["ctrl+q"]}\n', 'utf-8');

    const built = await buildKimiImportPlan({ sourceHome, targetHome });
    const { plan } = built;

    expect(plan.config?.importedKeys.toSorted()).toEqual([
      'default_model',
      'default_provider',
      'models."kimi-code/kimi-for-coding"',
      'providers."managed:kimi-code"',
    ]);
    expect(plan.config?.keptKeys).toEqual(['yolo']);
    expect(plan.keybindings?.importedKeys).toEqual(['editor.undo']);
    expect(plan.keybindings?.keptKeys).toEqual(['app.exit']);
    expect(plan.mcp?.importedKeys).toEqual(['mcpServers."context7"']);
    expect(plan.agentsMd?.action).toBe('import');
    expect(plan.skills.map((s) => s.action)).toEqual(['import']);
    expect(plan.sessions.map((s) => s.action)).toEqual(['import']);
    expect(plan.inputHistory).toHaveLength(1);
    expect(plan.credentials).toHaveLength(1);
    expect(plan.blockers).toEqual([]);
    expect(countPlannedImports(plan)).toBeGreaterThan(0);

    const result = await applyKimiImportPlan(built, {
      includeCredentials: false,
      renameConflictingSkills: false,
    });
    expect(result.errors).toEqual([]);
    expect(result.imported['config']).toBe(4);
    expect(result.imported['keybindings']).toBe(1);
    expect(result.imported['mcp']).toBe(1);
    expect(result.imported['instructions']).toBe(1);
    expect(result.imported['skills']).toBe(1);
    expect(result.imported['sessions']).toBe(1);
    expect(result.imported['inputHistory']).toBe(1);
    expect(result.imported['credentials']).toBeUndefined();

    // Config on disk: valid TOML, both sides preserved.
    const config = parseToml(await readFile(join(targetHome, 'config.toml'), 'utf-8')) as Record<
      string,
      unknown
    >;
    expect(config['yolo']).toBe(false); // target value kept
    expect(config['default_model']).toBe('kimi-code/kimi-for-coding');
    expect(
      (config['models'] as Record<string, unknown>)['kimi-code/kimi-for-coding'],
    ).toMatchObject({ provider: 'managed:kimi-code' });

    // Keybindings merged, ours kept.
    const keybindings = JSON.parse(
      await readFile(join(targetHome, 'keybindings.json'), 'utf-8'),
    ) as Record<string, unknown>;
    expect(keybindings).toEqual({ 'app.exit': ['ctrl+q'], 'editor.undo': 'ctrl+z' });

    // MCP servers merged into a fresh file.
    const mcp = JSON.parse(await readFile(join(targetHome, 'mcp.json'), 'utf-8')) as {
      mcpServers: Record<string, unknown>;
    };
    expect(Object.keys(mcp.mcpServers)).toEqual(['context7']);

    // Instructions block, skill, session, history all landed.
    expect(await readFile(join(targetHome, 'AGENTS.md'), 'utf-8')).toContain('# imported rules');
    expect(
      (await stat(join(targetHome, 'skills', 'upstream-skill', 'SKILL.md'))).isFile(),
    ).toBe(true);
    expect(
      (
        await stat(
          join(targetHome, 'sessions', encodeWorkDirKey('/work/proj-a'), 'session_1', 'state.json'),
        )
      ).isFile(),
    ).toBe(true);
    expect(await readFile(join(targetHome, 'user-history', 'abc.jsonl'), 'utf-8')).toContain(
      'upstream prompt',
    );

    // Credentials NOT copied without the opt-in.
    await expect(stat(join(targetHome, 'credentials', 'kimi-code.json'))).rejects.toThrow();
  });

  it('copies credentials only when explicitly requested', async () => {
    const built = await buildKimiImportPlan({ sourceHome, targetHome });
    const result = await applyKimiImportPlan(built, {
      includeCredentials: true,
      renameConflictingSkills: false,
    });
    expect(result.errors).toEqual([]);
    expect(result.imported['credentials']).toBe(1);
    expect(await readFile(join(targetHome, 'credentials', 'kimi-code.json'), 'utf-8')).toBe(
      '{"access_token":"tok"}',
    );
  });

  it('blocks the config category when the target config.toml is unparseable', async () => {
    await writeFile(join(targetHome, 'config.toml'), 'not = = toml\n', 'utf-8');
    const built = await buildKimiImportPlan({ sourceHome, targetHome });
    expect(built.plan.config?.targetError).toBeDefined();
    expect(built.plan.blockers).toHaveLength(1);
    expect(built.plan.blockers[0]).toContain('config.toml');

    const result = await applyKimiImportPlan(built, {
      includeCredentials: false,
      renameConflictingSkills: false,
    });
    expect(result.errors).toEqual([]);
    expect(result.imported['config']).toBeUndefined();
    // The broken target file is left byte-for-byte alone.
    expect(await readFile(join(targetHome, 'config.toml'), 'utf-8')).toBe('not = = toml\n');
    // Other categories still applied.
    expect(result.imported['sessions']).toBe(1);
  });

  it('second full pass imports nothing new', async () => {
    const first = await buildKimiImportPlan({ sourceHome, targetHome });
    await applyKimiImportPlan(first, { includeCredentials: true, renameConflictingSkills: false });

    const second = await buildKimiImportPlan({ sourceHome, targetHome });
    expect(countPlannedImports(second.plan)).toBe(0);
    expect(second.plan.skills[0]?.skipReason).toBe('conflict');
    expect(second.plan.sessions[0]?.skipReason).toBe('duplicate');
    expect(second.plan.credentials[0]?.skipReason).toBe('conflict');
    expect(second.plan.agentsMd?.skipReason).toBe('duplicate');
  });
});
