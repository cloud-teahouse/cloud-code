import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { join } from 'pathe';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { USER_PROMPT_ORIGIN } from '../../../src/agent/context';
import { InMemoryAgentRecordPersistence } from '../../../src/agent/records';
import type { SnapshotConfig } from '../../../src/config';
import { encodeWorkDirKey } from '../../../src/session/store/workdir-key';
import { testKaos } from '../../fixtures/test-kaos';
import { testAgent, type TestAgentContext } from '../harness/agent';

// Real-git integration tests for the shadow snapshot manager: every
// scenario runs against a tmp workspace and a tmp brand home (the
// CLOUD_CODE_HOME stand-in, passed explicitly as `brandHomeDir`), with git
// executed through a real LocalKaos.

const roots: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    roots
      .splice(0)
      // Retries ride out background gc still holding files in the shadow repo.
      .map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })),
  );
});

async function makeWorkspace(): Promise<{ workdir: string; brandHome: string }> {
  const root = await mkdtemp(join(tmpdir(), 'cloud-code-snapshot-test-'));
  roots.push(root);
  const workdir = join(root, 'work');
  const brandHome = join(root, 'cloud-code-home');
  await mkdir(workdir, { recursive: true });
  await mkdir(brandHome, { recursive: true });
  return { workdir, brandHome };
}

function git(args: readonly string[], cwd: string): string {
  return execFileSync('git', [...args], { cwd, encoding: 'utf8' }).trim();
}

function shadowGitdir(brandHome: string, workdir: string): string {
  return join(brandHome, 'snapshots', encodeWorkDirKey(workdir));
}

function makeCtx(
  workdir: string,
  brandHome: string,
  snapshot?: SnapshotConfig,
): TestAgentContext {
  return testAgent({
    kaos: testKaos.withCwd(workdir),
    brandHomeDir: brandHome,
    initialConfig: {
      providers: {},
      ...(snapshot !== undefined ? { snapshot } : {}),
    },
  });
}

function lastWireRecord(
  ctx: TestAgentContext,
  type: string,
): Record<string, unknown> | undefined {
  const entry = ctx.allEvents.findLast((e) => e.type === '[wire]' && e.event === type);
  return entry?.args as Record<string, unknown> | undefined;
}

function wireRecordCount(ctx: TestAgentContext, type: string): number {
  return ctx.allEvents.filter((e) => e.type === '[wire]' && e.event === type).length;
}

describe('SnapshotManager', () => {
  it('tracks a baseline in a non-git workdir and keeps node_modules out', async () => {
    const { workdir, brandHome } = await makeWorkspace();
    await writeFile(join(workdir, 'a.txt'), 'hello');
    await mkdir(join(workdir, 'node_modules'));
    await writeFile(join(workdir, 'node_modules', 'dep.js'), 'module.exports = 1;');
    const ctx = makeCtx(workdir, brandHome);

    await ctx.agent.snapshot.trackTurnBaseline(0, USER_PROMPT_ORIGIN);

    const record = lastWireRecord(ctx, 'snapshot.track');
    expect(record?.['kind']).toBe('turn_baseline');
    expect(record?.['files']).toEqual([]);
    const tree = record?.['tree'];
    expect(tree).toMatch(/^[0-9a-f]{40}$/);

    const gitdir = shadowGitdir(brandHome, workdir);
    const listing = git(['--git-dir', gitdir, 'ls-tree', '-r', '--name-only', tree as string], workdir);
    expect(listing.split('\n')).toContain('a.txt');
    expect(listing).not.toContain('node_modules');

    const excludes = await readFile(join(gitdir, 'info', 'exclude'), 'utf8');
    expect(excludes).toContain('node_modules/');
    expect(excludes).toContain('.git/');
  });

  it('leaves the user repo untouched and patches only changed files', async () => {
    const { workdir, brandHome } = await makeWorkspace();
    await writeFile(join(workdir, 'a.txt'), 'one');
    git(['init'], workdir);
    git(['config', 'user.email', 'snapshot@test.local'], workdir);
    git(['config', 'user.name', 'Snapshot Test'], workdir);
    git(['add', 'a.txt'], workdir);
    git(['commit', '-m', 'init'], workdir);
    // Uncommitted user change: must be captured by the baseline but never
    // written back into the user's repo.
    await writeFile(join(workdir, 'a.txt'), 'one-dirty');
    const indexPath = join(workdir, '.git', 'index');
    const statusBefore = git(['status', '--porcelain'], workdir);
    const headBefore = git(['rev-parse', 'HEAD'], workdir);
    // Read the index AFTER the test-side `git status` (which may itself
    // refresh the index) so the zero-touch comparison brackets only the
    // snapshot operation.
    const indexBefore = await readFile(indexPath);

    const ctx = makeCtx(workdir, brandHome);
    await ctx.agent.snapshot.trackTurnBaseline(0, USER_PROMPT_ORIGIN);

    // Zero-touch assertions: user index bytes, status output, and HEAD are
    // all identical after tracking.
    expect(await readFile(indexPath)).toEqual(indexBefore);
    expect(git(['status', '--porcelain'], workdir)).toBe(statusBefore);
    expect(git(['rev-parse', 'HEAD'], workdir)).toBe(headBefore);

    // The baseline tree captured the dirty content.
    const gitdir = shadowGitdir(brandHome, workdir);
    const baselineTree = lastWireRecord(ctx, 'snapshot.track')?.['tree'] as string;
    expect(git(['--git-dir', gitdir, 'show', `${baselineTree}:a.txt`], workdir)).toBe('one-dirty');

    await writeFile(join(workdir, 'a.txt'), 'two');
    await writeFile(join(workdir, 'b.txt'), 'new');
    const statusAfterEdits = git(['status', '--porcelain'], workdir);
    // `git status` itself opportunistically rewrites the user index, so the
    // zero-touch comparison must bracket exactly the snapshot operation.
    const indexBeforeStep = await readFile(indexPath);
    await ctx.agent.snapshot.trackAfterStep(0, 1);

    const step = lastWireRecord(ctx, 'snapshot.track');
    expect(step?.['kind']).toBe('step');
    expect(step?.['step']).toBe(1);
    expect(step?.['files']).toEqual(['a.txt', 'b.txt']);

    expect(await readFile(indexPath)).toEqual(indexBeforeStep);
    expect(git(['status', '--porcelain'], workdir)).toBe(statusAfterEdits);
  });

  it('rewinds only the files the turn touched', async () => {
    const { workdir, brandHome } = await makeWorkspace();
    await mkdir(join(workdir, 'sub', 'dir'), { recursive: true });
    await writeFile(join(workdir, 'sub', 'dir', 'a.txt'), 'original');
    await writeFile(join(workdir, 'c.txt'), 'original-c');
    const ctx = makeCtx(workdir, brandHome);
    await ctx.agent.snapshot.trackTurnBaseline(0, USER_PROMPT_ORIGIN);

    // Agent edits A (nested path) and creates B during the turn.
    await writeFile(join(workdir, 'sub', 'dir', 'a.txt'), 'changed');
    await writeFile(join(workdir, 'b.txt'), 'created');
    await ctx.agent.snapshot.trackAfterStep(0, 1);

    // Concurrent user edit AFTER the last track: outside the rewind file set.
    await writeFile(join(workdir, 'c.txt'), 'user-edit');

    const result = await ctx.rpc.rewindFiles({ count: 1 });
    expect(result.turnId).toBe(0);
    expect(result.files).toEqual(['b.txt', 'sub/dir/a.txt']);
    expect(result.preRewindTree).toMatch(/^[0-9a-f]{40}$/);

    expect(await readFile(join(workdir, 'sub', 'dir', 'a.txt'), 'utf8')).toBe('original');
    await expect(stat(join(workdir, 'b.txt'))).rejects.toThrow();
    expect(await readFile(join(workdir, 'c.txt'), 'utf8')).toBe('user-edit');

    const record = lastWireRecord(ctx, 'snapshot.rewind');
    expect(record?.['turnId']).toBe(0);
    expect(record?.['preRewindTree']).toBe(result.preRewindTree);
    expect(record?.['files']).toEqual(['b.txt', 'sub/dir/a.txt']);
  });

  it('rewinds across later anchored turns to the picked baseline', async () => {
    const { workdir, brandHome } = await makeWorkspace();
    await writeFile(join(workdir, 'a.txt'), 'v0');
    const ctx = makeCtx(workdir, brandHome);

    // Turn 0: agent changes a.txt to v1.
    await ctx.agent.snapshot.trackTurnBaseline(0, USER_PROMPT_ORIGIN);
    await writeFile(join(workdir, 'a.txt'), 'v1');
    await ctx.agent.snapshot.trackAfterStep(0, 1);

    // Turn 1: agent changes a.txt to v2 and creates b.txt.
    await ctx.agent.snapshot.trackTurnBaseline(1, USER_PROMPT_ORIGIN);
    await writeFile(join(workdir, 'a.txt'), 'v2');
    await writeFile(join(workdir, 'b.txt'), 'b');
    await ctx.agent.snapshot.trackAfterStep(1, 1);

    const result = await ctx.rpc.rewindFiles({ count: 2 });
    expect(result.turnId).toBe(0);
    expect(result.files).toEqual(['a.txt', 'b.txt']);
    expect(await readFile(join(workdir, 'a.txt'), 'utf8')).toBe('v0');
    await expect(stat(join(workdir, 'b.txt'))).rejects.toThrow();
  });

  it('excludes files over the size limit and leaves them alone on rewind', async () => {
    const { workdir, brandHome } = await makeWorkspace();
    await writeFile(join(workdir, 'big.bin'), 'x'.repeat(2048));
    await writeFile(join(workdir, 'small.txt'), 'small');
    const ctx = makeCtx(workdir, brandHome, { maxFileSizeBytes: 1024 });
    await ctx.agent.snapshot.trackTurnBaseline(0, USER_PROMPT_ORIGIN);

    await writeFile(join(workdir, 'big.bin'), 'y'.repeat(2048));
    await writeFile(join(workdir, 'small.txt'), 'small-changed');
    await ctx.agent.snapshot.trackAfterStep(0, 1);

    const step = lastWireRecord(ctx, 'snapshot.track');
    expect(step?.['files']).toEqual(['small.txt']);

    const excludes = await readFile(
      join(shadowGitdir(brandHome, workdir), 'info', 'exclude'),
      'utf8',
    );
    expect(excludes).toContain('/big.bin');

    await ctx.rpc.rewindFiles({ count: 1 });
    expect(await readFile(join(workdir, 'small.txt'), 'utf8')).toBe('small');
    expect(await readFile(join(workdir, 'big.bin'), 'utf8')).toBe('y'.repeat(2048));
  });

  it('rebuilds the snapshot index from the wire log on resume', async () => {
    const { workdir, brandHome } = await makeWorkspace();
    await writeFile(join(workdir, 'a.txt'), 'original');
    const persistence = new InMemoryAgentRecordPersistence();
    const ctx = testAgent({
      kaos: testKaos.withCwd(workdir),
      brandHomeDir: brandHome,
      persistence,
      initialConfig: { providers: {} },
    });
    await ctx.agent.snapshot.trackTurnBaseline(0, USER_PROMPT_ORIGIN);
    await writeFile(join(workdir, 'a.txt'), 'changed');
    await ctx.agent.snapshot.trackAfterStep(0, 1);

    const resumed = testAgent({
      kaos: testKaos.withCwd(workdir),
      brandHomeDir: brandHome,
      persistence: new InMemoryAgentRecordPersistence([...persistence.records]),
      initialConfig: { providers: {} },
    });
    await resumed.agent.resume();

    const result = await resumed.rpc.rewindFiles({ count: 1 });
    expect(result.turnId).toBe(0);
    expect(result.files).toEqual(['a.txt']);
    expect(await readFile(join(workdir, 'a.txt'), 'utf8')).toBe('original');
  });

  it('silently disables snapshots when git is missing and the turn still completes', async () => {
    vi.stubEnv('PATH', '');
    const { workdir, brandHome } = await makeWorkspace();
    await writeFile(join(workdir, 'a.txt'), 'content');
    const ctx = makeCtx(workdir, brandHome);
    ctx.configure();

    ctx.mockNextResponse({ type: 'text', text: 'done' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Hi' }] });
    await ctx.untilTurnEnd();

    expect(wireRecordCount(ctx, 'snapshot.track')).toBe(0);
    await expect(ctx.rpc.rewindFiles({ count: 1 })).rejects.toThrow(
      'file rewind unavailable (git not found)',
    );
  });

  it('stays off when [snapshot] enabled = false', async () => {
    const { workdir, brandHome } = await makeWorkspace();
    await writeFile(join(workdir, 'a.txt'), 'content');
    const ctx = makeCtx(workdir, brandHome, { enabled: false });

    await ctx.agent.snapshot.trackTurnBaseline(0, USER_PROMPT_ORIGIN);

    expect(wireRecordCount(ctx, 'snapshot.track')).toBe(0);
    await expect(ctx.rpc.rewindFiles({ count: 1 })).rejects.toThrow(
      'file rewind unavailable (snapshots disabled)',
    );
  });

  it('rejects a rewind count beyond the anchored turns', async () => {
    const { workdir, brandHome } = await makeWorkspace();
    await writeFile(join(workdir, 'a.txt'), 'content');
    const ctx = makeCtx(workdir, brandHome);
    await ctx.agent.snapshot.trackTurnBaseline(0, USER_PROMPT_ORIGIN);

    await expect(ctx.rpc.rewindFiles({ count: 2 })).rejects.toThrow(/only 1 turn has/);
  });

  it('does not track for sub-agents', async () => {
    const { workdir, brandHome } = await makeWorkspace();
    await writeFile(join(workdir, 'a.txt'), 'content');
    const ctx = testAgent({
      kaos: testKaos.withCwd(workdir),
      brandHomeDir: brandHome,
      type: 'sub',
      initialConfig: { providers: {} },
    });

    await ctx.agent.snapshot.trackTurnBaseline(0, USER_PROMPT_ORIGIN);

    expect(wireRecordCount(ctx, 'snapshot.track')).toBe(0);
    await expect(stat(shadowGitdir(brandHome, workdir))).rejects.toThrow();
  });
});
