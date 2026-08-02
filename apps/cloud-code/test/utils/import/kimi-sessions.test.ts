import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  applySessionImport,
  buildSessionImportPlan,
} from '#/utils/import/kimi-sessions';
import { encodeWorkDirKey, normalizeWorkDir } from '#/utils/import/workdir-key';

const WIRE_14 = [
  JSON.stringify({ type: 'metadata', protocol_version: '1.4', created_at: 1 }),
  JSON.stringify({ type: 'turn.prompt', content: 'hello' }),
].join('\n');

async function makeSession(
  home: string,
  bucket: string,
  sessionId: string,
  options: {
    readonly workDir?: string;
    /** Defaults to a valid 1.4 wire; pass null to leave wire.jsonl unwritten. */
    readonly wire?: string | null;
    readonly title?: string;
    readonly withLogs?: boolean;
    readonly withState?: boolean;
  } = {},
): Promise<string> {
  const dir = join(home, 'sessions', bucket, sessionId);
  await mkdir(join(dir, 'agents', 'main', 'blobs'), { recursive: true });
  if (options.withState !== false) {
    const workDir = options.workDir ?? '/work/proj-a';
    await writeFile(
      join(dir, 'state.json'),
      JSON.stringify({
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        title: options.title ?? 'Test session',
        isCustomTitle: false,
        workDir,
        agents: { main: { homedir: `${dir}/agents/main`, type: 'main' } },
        custom: {},
      }),
      'utf-8',
    );
  }
  const wire = options.wire === undefined ? WIRE_14 : options.wire;
  if (wire !== null) {
    await writeFile(join(dir, 'agents', 'main', 'wire.jsonl'), wire, 'utf-8');
  }
  if (options.withLogs === true) {
    await mkdir(join(dir, 'logs'), { recursive: true });
    await writeFile(join(dir, 'logs', 'cloud-code.log'), 'noise\n', 'utf-8');
  }
  await writeFile(join(dir, 'agents', 'main', 'blobs', 'abc123'), 'blob', 'utf-8');
  return dir;
}

describe('kimi session import', () => {
  let sourceHome: string;
  let targetHome: string;

  beforeEach(async () => {
    sourceHome = await mkdtemp(join(tmpdir(), 'cc-import-src-'));
    targetHome = await mkdtemp(join(tmpdir(), 'cc-import-dst-'));
  });
  afterEach(async () => {
    await rm(sourceHome, { recursive: true, force: true });
    await rm(targetHome, { recursive: true, force: true });
  });

  it('plans an import for a healthy session and skips duplicates/incompatible ones', async () => {
    await makeSession(sourceHome, 'wd_a_1', 'session_ok', { workDir: '/work/proj-a' });
    await makeSession(sourceHome, 'wd_a_1', 'session_dup', { workDir: '/work/proj-a' });
    await makeSession(targetHome, encodeWorkDirKey('/work/proj-a'), 'session_dup');
    await makeSession(sourceHome, 'wd_a_1', 'session_newer', {
      workDir: '/work/proj-a',
      wire: `${JSON.stringify({ type: 'metadata', protocol_version: '9.9', created_at: 1 })}\n`,
    });
    await makeSession(sourceHome, 'wd_b_2', 'session_unknown', {
      workDir: '/work/proj-b',
      wire: [
        JSON.stringify({ type: 'metadata', protocol_version: '1.4', created_at: 1 }),
        JSON.stringify({ type: 'totally.new', x: 1 }),
      ].join('\n'),
    });
    await makeSession(sourceHome, 'wd_b_2', 'session_nowire', { workDir: '/work/proj-b', wire: null });
    await makeSession(sourceHome, 'wd_c_3', 'session_v13_goal', {
      workDir: '/work/proj-c',
      wire: [
        JSON.stringify({ type: 'metadata', protocol_version: '1.3', created_at: 1 }),
        JSON.stringify({ type: 'goal.create', goalId: 'g1', objective: 'legacy goal' }),
        JSON.stringify({ type: 'goal.account_usage', goalId: 'g1', tokensUsed: 42 }),
        JSON.stringify({ type: 'goal.continuation', goalId: 'g1', turnsUsed: 3 }),
      ].join('\n'),
    });

    const plan = await buildSessionImportPlan({ sourceHome, targetHome });
    const byId = new Map(plan.map((item) => [item.sessionId, item]));

    const ok = byId.get('session_ok');
    expect(ok?.action).toBe('import');
    expect(ok?.title).toBe('Test session');
    expect(ok?.workDir).toBe(normalizeWorkDir('/work/proj-a'));
    expect(ok?.targetDir).toBe(
      join(targetHome, 'sessions', encodeWorkDirKey('/work/proj-a'), 'session_ok'),
    );

    expect(byId.get('session_dup')?.skipReason).toBe('duplicate');

    const newer = byId.get('session_newer');
    expect(newer?.skipReason).toBe('incompatible');
    expect(newer?.detail).toContain('9.9');

    const unknown = byId.get('session_unknown');
    expect(unknown?.skipReason).toBe('incompatible');
    expect(unknown?.detail).toContain('totally.new');

    const nowire = byId.get('session_nowire');
    expect(nowire?.skipReason).toBe('invalid');

    // v1.3 wire with legacy goal records: migratable on replay, so importable.
    expect(byId.get('session_v13_goal')?.action).toBe('import');
  });

  it('re-imports a session whose index entry is orphaned (dir deleted out of band)', async () => {
    await makeSession(sourceHome, 'wd_a_1', 'session_orphan', { workDir: '/work/proj-a' });
    // Target index claims the session, but its directory is gone — the
    // pre-fix behavior read this as a duplicate and made the session
    // impossible to restore.
    const orphanDir = join(
      targetHome,
      'sessions',
      encodeWorkDirKey('/work/proj-a'),
      'session_orphan',
    );
    await writeFile(
      join(targetHome, 'session_index.jsonl'),
      `${JSON.stringify({ sessionId: 'session_orphan', sessionDir: orphanDir, workDir: '/work/proj-a' })}\n`,
      'utf-8',
    );

    const plan = await buildSessionImportPlan({ sourceHome, targetHome });
    const orphan = plan.find((item) => item.sessionId === 'session_orphan');
    expect(orphan?.action).toBe('import');
    expect(orphan?.skipReason).toBeUndefined();

    // And the same id with its directory present still reads as a duplicate.
    await makeSession(targetHome, encodeWorkDirKey('/work/proj-a'), 'session_real_dup');
    await makeSession(sourceHome, 'wd_a_1', 'session_real_dup', { workDir: '/work/proj-a' });
    const second = await buildSessionImportPlan({ sourceHome, targetHome });
    expect(
      second.find((item) => item.sessionId === 'session_real_dup')?.skipReason,
    ).toBe('duplicate');
  });

  it('falls back to the source index for workDir when state.json lacks one', async () => {
    const dir = await makeSession(sourceHome, 'wd_c_3', 'session_legacy', { wire: WIRE_14 });
    // Rewrite state.json without workDir but with legacy custom.cwd.
    await writeFile(
      join(dir, 'state.json'),
      JSON.stringify({ title: 'Legacy', agents: {}, custom: { cwd: '/work/legacy' } }),
      'utf-8',
    );
    const plan = await buildSessionImportPlan({ sourceHome, targetHome });
    expect(plan[0]?.action).toBe('import');
    expect(plan[0]?.workDir).toBe(normalizeWorkDir('/work/legacy'));
  });

  it('applies: copies the tree without logs, rewrites homedir, appends the index', async () => {
    const sourceDir = await makeSession(sourceHome, 'wd_a_1', 'session_ok', {
      workDir: '/work/proj-a',
      wire: WIRE_14,
      withLogs: true,
    });
    const plan = await buildSessionImportPlan({ sourceHome, targetHome });
    expect(plan).toHaveLength(1);

    const result = await applySessionImport(plan, targetHome);
    expect(result).toEqual({ imported: 1, errors: [], notes: [] });

    const targetDir = plan[0]!.targetDir;
    // Tree copied, logs excluded, blobs preserved.
    expect((await stat(join(targetDir, 'agents', 'main', 'wire.jsonl'))).isFile()).toBe(true);
    expect((await stat(join(targetDir, 'agents', 'main', 'blobs', 'abc123'))).isFile()).toBe(true);
    await expect(stat(join(targetDir, 'logs'))).rejects.toThrow();

    // state.json homedir rewritten to the new location.
    const state = JSON.parse(await readFile(join(targetDir, 'state.json'), 'utf-8')) as {
      agents: { main: { homedir: string } };
    };
    expect(state.agents.main.homedir).toBe(join(targetDir, 'agents', 'main'));
    expect(state.agents.main.homedir.startsWith(sourceDir)).toBe(false);

    // Index appended with an entry the store's reader would accept.
    const indexRaw = await readFile(join(targetHome, 'session_index.jsonl'), 'utf-8');
    const entry = JSON.parse(indexRaw.trim()) as {
      sessionId: string;
      sessionDir: string;
      workDir: string;
    };
    expect(entry.sessionId).toBe('session_ok');
    expect(entry.sessionDir).toBe(targetDir);
    expect(entry.workDir).toBe(normalizeWorkDir('/work/proj-a'));
    expect(entry.sessionDir.startsWith(join(targetHome, 'sessions'))).toBe(true);
    expect(entry.sessionDir.split('/').at(-1)).toBe('session_ok');
  });

  it('is idempotent: a second scan skips everything as duplicates', async () => {
    await makeSession(sourceHome, 'wd_a_1', 'session_ok', { workDir: '/work/proj-a', wire: WIRE_14 });
    const first = await buildSessionImportPlan({ sourceHome, targetHome });
    await applySessionImport(first, targetHome);

    const second = await buildSessionImportPlan({ sourceHome, targetHome });
    expect(second).toHaveLength(1);
    expect(second[0]?.action).toBe('skip');
    expect(second[0]?.skipReason).toBe('duplicate');
  });

  it('notes sessions whose homedir points outside the session dir (left unrewritten)', async () => {
    const dir = await makeSession(sourceHome, 'wd_a_1', 'session_moved', {
      workDir: '/work/proj-a',
      wire: WIRE_14,
    });
    // Simulate a session that was moved between homes before: its recorded
    // homedir points at an unrelated location and must NOT be rewritten.
    await writeFile(
      join(dir, 'state.json'),
      JSON.stringify({
        title: 'Moved session',
        workDir: '/work/proj-a',
        agents: { main: { homedir: '/elsewhere/old-home/agents/main', type: 'main' } },
        custom: {},
      }),
      'utf-8',
    );

    const plan = await buildSessionImportPlan({ sourceHome, targetHome });
    const result = await applySessionImport(plan, targetHome);
    expect(result.imported).toBe(1);
    expect(result.errors).toEqual([]);
    expect(result.notes).toEqual([{ sessionId: 'session_moved', unmatchedHomedirs: 1 }]);

    const state = JSON.parse(
      await readFile(join(plan[0]!.targetDir, 'state.json'), 'utf-8'),
    ) as { agents: { main: { homedir: string } } };
    expect(state.agents.main.homedir).toBe('/elsewhere/old-home/agents/main');
  });
});
