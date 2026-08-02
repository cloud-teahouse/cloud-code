/**
 * WorktreeMode integration tests: real git repositories in temp dirs, a real
 * LocalKaos, and the harness Agent — covering the enter/exit lifecycle, the
 * session cwd switch (including the rebuilt builtin tools), the safety
 * rails, and wire-record resume.
 */

import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LocalKaos } from '@cloud-code/kaos';
import { afterEach, describe, expect, it } from 'vitest';

import { InMemoryAgentRecordPersistence } from '../../src/agent/records';
import { validateWorktreeSlug } from '../../src/agent/worktree/git';
import type { ResolvedAgentProfile } from '../../src/profile/types';
import { executeTool } from '../tools/fixtures/execute-tool';
import { testAgent, type TestAgentContext } from './harness/agent';

const signal = new AbortController().signal;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf-8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
}

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cloudcode-worktree-'));
  tempDirs.push(dir);
  return dir;
}

function initRepo(): string {
  const dir = makeTempDir();
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test User');
  writeFileSync(join(dir, 'README.md'), 'hello\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'initial');
  return dir;
}

async function makeRepoAgent(repoDir: string): Promise<{
  ctx: TestAgentContext;
  persistence: InMemoryAgentRecordPersistence;
}> {
  const kaos = (await LocalKaos.create()).withCwd(repoDir);
  const persistence = new InMemoryAgentRecordPersistence();
  const ctx = testAgent({ kaos, persistence });
  // Provider is required for `config.update` to rebuild builtin tools;
  // configure() parks cwd at process.cwd(), so reposition into the repo.
  ctx.configure();
  ctx.agent.config.update({ cwd: repoDir });
  return { ctx, persistence };
}

function worktreePath(repoDir: string, name: string): string {
  return join(repoDir, '.cloud-code', 'worktrees', name);
}

describe('validateWorktreeSlug', () => {
  it('accepts simple and grouped slugs', () => {
    expect(() => {
      validateWorktreeSlug('feature-x');
    }).not.toThrow();
    expect(() => {
      validateWorktreeSlug('user/feature_x.1');
    }).not.toThrow();
  });

  it('rejects traversal, absolute paths, empty segments, and bad characters', () => {
    for (const slug of ['..', '../escape', 'a/../../b', '/abs', 'a//b', 'trailing/', 'has space', 'a+b']) {
      expect(() => {
        validateWorktreeSlug(slug);
      }, slug).toThrow();
    }
  });

  it('rejects slugs over 64 chars', () => {
    expect(() => {
      validateWorktreeSlug('x'.repeat(65));
    }).toThrow(/64/);
  });
});

describe('WorktreeMode.enter', () => {
  it('creates the worktree and branch, switches the session cwd, and journals records', async () => {
    const repo = initRepo();
    const { ctx, persistence } = await makeRepoAgent(repo);

    const { state, resumed } = await ctx.agent.worktree.enter({ name: 'feature-a' });

    expect(resumed).toBe(false);
    expect(state.path).toBe(worktreePath(repo, 'feature-a'));
    expect(state.branch).toBe('worktree-feature-a');
    expect(state.originalCwd).toBe(repo);
    expect(state.mainRepoRoot).toBe(repo);
    expect(existsSync(join(state.path, 'README.md'))).toBe(true);
    expect(git(repo, 'branch', '--list', 'worktree-feature-a')).toContain('worktree-feature-a');

    // The session followed: config cwd, kaos cwd, and state.
    expect(ctx.agent.config.cwd).toBe(state.path);
    expect(ctx.agent.kaos.getcwd()).toBe(state.path);
    expect(ctx.agent.worktree.current).toEqual(state);

    // The wire carries the enter and the paired cwd switch, in that order.
    const types = persistence.records.map((record) => record.type);
    const enterIndex = types.indexOf('worktree.enter');
    expect(enterIndex).toBeGreaterThanOrEqual(0);
    const cwdRecord = persistence.records.slice(enterIndex + 1).find(
      (record) => record.type === 'config.update' && 'cwd' in record,
    );
    expect(cwdRecord).toMatchObject({ type: 'config.update', cwd: state.path });

    // The rebuilt Write tool runs inside the worktree.
    const write = ctx.agent.tools.getBuiltinTool('Write');
    expect(write).toBeDefined();
    const result = await executeTool(write!, {
      turnId: '0',
      toolCallId: 'tc_write',
      args: { path: 'wt-note.txt', content: 'from the worktree' },
      signal,
    });
    expect(result).not.toMatchObject({ isError: true });
    expect(readFileSync(join(state.path, 'wt-note.txt'), 'utf-8')).toBe('from the worktree');
    expect(existsSync(join(repo, 'wt-note.txt'))).toBe(false);
  });

  it('creates the branch from an explicit base ref', async () => {
    const repo = initRepo();
    writeFileSync(join(repo, 'second.txt'), 'two\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'second');
    const firstSha = git(repo, 'rev-list', '--max-parents=0', 'HEAD').trim();
    const { ctx } = await makeRepoAgent(repo);

    const { state } = await ctx.agent.worktree.enter({ name: 'based', base: firstSha });

    expect(state.headCommit).toBe(firstSha);
    expect(git(state.path, 'rev-parse', 'HEAD').trim()).toBe(firstSha);
    expect(existsSync(join(state.path, 'second.txt'))).toBe(false);
  });

  it('allows a dirty original checkout: the worktree starts clean and local state stays put', async () => {
    const repo = initRepo();
    writeFileSync(join(repo, 'README.md'), 'modified but uncommitted\n');
    writeFileSync(join(repo, 'scratch.txt'), 'untracked\n');
    mkdirSync(join(repo, '.cloud-code'));
    writeFileSync(join(repo, '.cloud-code', 'local.toml'), '[workspace]\nadditional_dir = []\n');
    writeFileSync(join(repo, '.gitignore'), '.env.local\n');
    writeFileSync(join(repo, '.env.local'), 'SECRET=1\n');
    writeFileSync(join(repo, '.worktreeinclude'), '.env.local\n');
    const { ctx } = await makeRepoAgent(repo);

    const { state, carriedFiles } = await ctx.agent.worktree.enter({ name: 'dirty-base' });

    // Worktree content comes from the commit, not the dirty tree.
    expect(readFileSync(join(state.path, 'README.md'), 'utf-8')).toBe('hello\n');
    // Untracked, non-ignored files are not carried.
    expect(existsSync(join(state.path, 'scratch.txt'))).toBe(false);
    // .worktreeinclude-matched gitignored files and the workspace local config are.
    expect(readFileSync(join(state.path, '.env.local'), 'utf-8')).toBe('SECRET=1\n');
    expect(carriedFiles).toEqual(['.env.local']);
    expect(readFileSync(join(state.path, '.cloud-code', 'local.toml'), 'utf-8')).toContain(
      'additional_dir',
    );
    // The original checkout is untouched.
    expect(readFileSync(join(repo, 'README.md'), 'utf-8')).toBe('modified but uncommitted\n');
    expect(git(repo, 'status', '--porcelain')).not.toBe('');
  });

  it('re-renders the system prompt working-directory reference on enter and exit', async () => {
    const repo = initRepo();
    const { ctx } = await makeRepoAgent(repo);
    const profile = {
      name: 'worktree-test-profile',
      tools: [],
      systemPrompt: (vars: { cwd: string }) =>
        `# Test\n\n## Working Directory\n\nThe current working directory is \`${vars.cwd}\`.\n`,
    } as unknown as ResolvedAgentProfile;
    ctx.agent.useProfile(profile);
    await ctx.agent.refreshSystemPrompt();
    expect(ctx.agent.config.systemPrompt).toContain(`\`${repo}\``);

    const { state } = await ctx.agent.worktree.enter({ name: 'prompt-wt' });
    expect(ctx.agent.config.systemPrompt).toContain(`\`${state.path}\``);
    expect(ctx.agent.config.systemPrompt).not.toContain(`\`${repo}\``);

    await ctx.agent.worktree.exit({ action: 'keep' });
    expect(ctx.agent.config.systemPrompt).toContain(`\`${repo}\``);
    expect(ctx.agent.config.systemPrompt).not.toContain(`\`${state.path}\``);
  });

  it('re-attaches to an existing same-name worktree instead of recreating it', async () => {
    const repo = initRepo();
    const { ctx } = await makeRepoAgent(repo);

    const first = await ctx.agent.worktree.enter({ name: 'same-name' });
    writeFileSync(join(first.state.path, 'progress.txt'), 'keep me\n');
    await ctx.agent.worktree.exit({ action: 'keep' });

    const second = await ctx.agent.worktree.enter({ name: 'same-name' });
    expect(second.resumed).toBe(true);
    expect(second.state.path).toBe(first.state.path);
    expect(second.state.branch).toBe(first.state.branch);
    expect(readFileSync(join(first.state.path, 'progress.txt'), 'utf-8')).toBe('keep me\n');
  });

  it('refuses to nest a second worktree session', async () => {
    const repo = initRepo();
    const { ctx } = await makeRepoAgent(repo);
    await ctx.agent.worktree.enter({ name: 'first-wt' });

    await expect(ctx.agent.worktree.enter({ name: 'second-wt' })).rejects.toThrow(
      /Already in worktree "first-wt"/,
    );
    // State and cwd are untouched.
    expect(ctx.agent.worktree.current?.name).toBe('first-wt');
    expect(ctx.agent.config.cwd).toBe(worktreePath(repo, 'first-wt'));
  });

  it('creates the worktree at the canonical main root when entered from a foreign worktree', async () => {
    const repo = initRepo();
    const foreign = join(makeTempDir(), 'foreign');
    git(repo, 'worktree', 'add', '-q', '-b', 'foreign-branch', foreign, 'HEAD');
    const { ctx } = await makeRepoAgent(foreign);

    const { state } = await ctx.agent.worktree.enter({ name: 'from-foreign' });

    expect(state.mainRepoRoot).toBe(repo);
    expect(state.path).toBe(worktreePath(repo, 'from-foreign'));
    expect(state.originalCwd).toBe(foreign);
    expect(existsSync(join(state.path, 'README.md'))).toBe(true);
  });

  it('works from inside a submodule: the worktree belongs to the submodule repo', async () => {
    const sub = initRepo();
    const superRepo = makeTempDir();
    git(superRepo, 'init', '-q', '-b', 'main');
    git(superRepo, 'config', 'user.email', 'test@example.com');
    git(superRepo, 'config', 'user.name', 'Test User');
    git(superRepo, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 'libs/sub');
    git(superRepo, 'commit', '-qm', 'add submodule');
    const subWorkdir = join(superRepo, 'libs', 'sub');
    const { ctx } = await makeRepoAgent(subWorkdir);

    const { state } = await ctx.agent.worktree.enter({ name: 'sub-wt' });

    expect(state.mainRepoRoot).toBe(subWorkdir);
    expect(state.path).toBe(worktreePath(subWorkdir, 'sub-wt'));
    expect(existsSync(join(state.path, 'README.md'))).toBe(true);
    expect(git(subWorkdir, 'branch', '--list', 'worktree-sub-wt')).toContain('worktree-sub-wt');
  });

  it('resolves the canonical root through a linked worktree of a submodule', async () => {
    const sub = initRepo();
    const superRepo = makeTempDir();
    git(superRepo, 'init', '-q', '-b', 'main');
    git(superRepo, 'config', 'user.email', 'test@example.com');
    git(superRepo, 'config', 'user.name', 'Test User');
    git(superRepo, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 'libs/sub');
    git(superRepo, 'commit', '-qm', 'add submodule');
    const subWorkdir = join(superRepo, 'libs', 'sub');
    const linked = join(makeTempDir(), 'linked');
    git(subWorkdir, 'worktree', 'add', '-q', '-B', 'sub-linked', linked, 'HEAD');
    const { ctx } = await makeRepoAgent(linked);

    const { state } = await ctx.agent.worktree.enter({ name: 'sub-linked-wt' });

    expect(state.mainRepoRoot).toBe(subWorkdir);
    expect(state.path).toBe(worktreePath(subWorkdir, 'sub-linked-wt'));
    expect(existsSync(join(state.path, 'README.md'))).toBe(true);
  });
});

describe('WorktreeMode.exit', () => {
  it('keep: restores the original cwd and leaves the worktree and branch on disk', async () => {
    const repo = initRepo();
    const { ctx, persistence } = await makeRepoAgent(repo);
    const { state } = await ctx.agent.worktree.enter({ name: 'keep-me' });
    writeFileSync(join(state.path, 'wip.txt'), 'work in progress\n');

    const result = await ctx.agent.worktree.exit({ action: 'keep' });

    expect(result.action).toBe('keep');
    expect(result.originalCwd).toBe(repo);
    expect(ctx.agent.config.cwd).toBe(repo);
    expect(ctx.agent.kaos.getcwd()).toBe(repo);
    expect(ctx.agent.worktree.isActive).toBe(false);
    expect(existsSync(join(state.path, 'wip.txt'))).toBe(true);
    expect(git(repo, 'branch', '--list', state.branch)).toContain(state.branch);
    expect(persistence.records.map((record) => record.type)).toContain('worktree.exit');
  });

  it('remove: deletes the worktree and branch and restores the cwd', async () => {
    const repo = initRepo();
    const { ctx } = await makeRepoAgent(repo);
    const { state } = await ctx.agent.worktree.enter({ name: 'remove-me' });

    const result = await ctx.agent.worktree.exit({ action: 'remove' });

    expect(result.action).toBe('remove');
    expect(result.discardedFiles).toBe(0);
    expect(result.discardedCommits).toBe(0);
    expect(ctx.agent.config.cwd).toBe(repo);
    expect(existsSync(state.path)).toBe(false);
    expect(git(repo, 'branch', '--list', state.branch)).not.toContain(state.branch);
    expect(git(repo, 'worktree', 'list', '--porcelain')).not.toContain(state.path);
  });

  it('remove refuses dirty work without discardChanges, then reports what it discarded', async () => {
    const repo = initRepo();
    const { ctx } = await makeRepoAgent(repo);
    const { state } = await ctx.agent.worktree.enter({ name: 'dirty-exit' });
    writeFileSync(join(state.path, 'new-file.txt'), 'uncommitted\n');
    writeFileSync(join(state.path, 'committed.txt'), 'committed\n');
    git(state.path, 'add', 'committed.txt');
    git(state.path, 'commit', '-qm', 'worktree commit');

    const summary = await ctx.agent.worktree.countChanges();
    expect(summary).toEqual({ changedFiles: 1, commits: 1 });
    await expect(ctx.agent.worktree.exit({ action: 'remove' })).rejects.toThrow(/Refusing to remove/);
    expect(ctx.agent.worktree.isActive).toBe(true);
    expect(existsSync(state.path)).toBe(true);

    const result = await ctx.agent.worktree.exit({ action: 'remove', discardChanges: true });
    expect(result.discardedFiles).toBe(1);
    expect(result.discardedCommits).toBe(1);
    expect(existsSync(state.path)).toBe(false);
    expect(git(repo, 'branch', '--list', state.branch)).not.toContain(state.branch);
  });

  it('fails closed when the worktree state cannot be verified', async () => {
    const repo = initRepo();
    const { ctx } = await makeRepoAgent(repo);
    const { state } = await ctx.agent.worktree.enter({ name: 'gone-exit' });
    rmSync(state.path, { recursive: true, force: true });

    expect(await ctx.agent.worktree.countChanges()).toBeNull();
    await expect(ctx.agent.worktree.exit({ action: 'remove' })).rejects.toThrow(/Refusing to remove/);
    // discardChanges forces past the unverifiable state; git treats the
    // already-missing directory as a successful removal.
    const result = await ctx.agent.worktree.exit({ action: 'remove', discardChanges: true });
    expect(result.action).toBe('remove');
    expect(ctx.agent.worktree.isActive).toBe(false);
    expect(git(repo, 'worktree', 'list', '--porcelain')).not.toContain(state.path);
  });

  it('keeps the session fully intact when git fails to remove the worktree', async () => {
    const repo = initRepo();
    const { ctx } = await makeRepoAgent(repo);
    const { state } = await ctx.agent.worktree.enter({ name: 'stuck-exit' });
    const lockedDir = join(state.path, 'locked');
    mkdirSync(lockedDir);
    writeFileSync(join(lockedDir, 'x.txt'), 'x\n');
    chmodSync(lockedDir, 0o555);

    try {
      await expect(
        ctx.agent.worktree.exit({ action: 'remove', discardChanges: true }),
      ).rejects.toThrow(/Failed to remove worktree/);
      expect(ctx.agent.worktree.isActive).toBe(true);
      expect(ctx.agent.config.cwd).toBe(state.path);
      expect(existsSync(state.path)).toBe(true);
    } finally {
      chmodSync(lockedDir, 0o755);
    }

    // The escape hatch still works afterwards.
    await ctx.agent.worktree.exit({ action: 'keep' });
    expect(ctx.agent.worktree.isActive).toBe(false);
    expect(ctx.agent.config.cwd).toBe(repo);
  });
});

describe('worktree session resume', () => {
  it('restores worktree state and cwd from the wire records', async () => {
    const repo = initRepo();
    const { ctx, persistence } = await makeRepoAgent(repo);
    const { state } = await ctx.agent.worktree.enter({ name: 'resume-wt' });
    writeFileSync(join(state.path, 'progress.txt'), 'resumable\n');

    const resumedKaos = (await LocalKaos.create()).withCwd(repo);
    const resumed = testAgent({
      kaos: resumedKaos,
      persistence: new InMemoryAgentRecordPersistence([...persistence.records]),
    });
    await resumed.agent.resume();

    expect(resumed.agent.worktree.isActive).toBe(true);
    expect(resumed.agent.worktree.current).toEqual(state);
    expect(resumed.agent.config.cwd).toBe(state.path);
    expect(resumed.agent.kaos.getcwd()).toBe(state.path);

    // The rebuilt tools of the resumed agent run inside the worktree.
    const write = resumed.agent.tools.getBuiltinTool('Write');
    const writeResult = await executeTool(write!, {
      turnId: '0',
      toolCallId: 'tc_resumed_write',
      args: { path: 'after-resume.txt', content: 'written after resume' },
      signal,
    });
    expect(writeResult).not.toMatchObject({ isError: true });
    expect(readFileSync(join(state.path, 'after-resume.txt'), 'utf-8')).toBe(
      'written after resume',
    );

    // Exit works after resume and returns to the original cwd.
    const exit = await resumed.agent.worktree.exit({ action: 'keep' });
    expect(exit.originalCwd).toBe(repo);
    expect(resumed.agent.config.cwd).toBe(repo);
    expect(resumed.agent.worktree.isActive).toBe(false);
  });

  it('does not restore worktree state after a recorded exit', async () => {
    const repo = initRepo();
    const { ctx, persistence } = await makeRepoAgent(repo);
    await ctx.agent.worktree.enter({ name: 'short-lived' });
    await ctx.agent.worktree.exit({ action: 'keep' });

    const resumed = testAgent({
      kaos: (await LocalKaos.create()).withCwd(repo),
      persistence: new InMemoryAgentRecordPersistence([...persistence.records]),
    });
    await resumed.agent.resume();

    expect(resumed.agent.worktree.isActive).toBe(false);
    expect(resumed.agent.config.cwd).toBe(repo);
  });
});
