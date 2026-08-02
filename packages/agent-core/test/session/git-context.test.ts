import { Readable } from 'node:stream';

import type { Kaos, KaosProcess } from '@cloud-code/kaos';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  _clearGitStatusSnapshotCacheForTests,
  collectGitContext,
  collectGitStatusSnapshot,
  getGitStatusSnapshot,
  parseProjectName,
  sanitizeRemoteUrl,
} from '../../src/session/git-context';
import { createFakeKaos } from '../tools/fixtures/fake-kaos';

function fakeProcess(stdout: string, exitCode = 0, stderr = ''): KaosProcess {
  return {
    stdin: { write: () => true, end: () => {} } as never,
    stdout: Readable.from([stdout]),
    stderr: Readable.from([stderr]),
    pid: 1,
    exitCode,
    wait: async () => exitCode,
    kill: async () => {},
    dispose: async () => {},
  };
}

/** Scripted git output keyed by the git subcommand (`args[3]`). */
type GitScript = Record<string, { stdout: string; exitCode?: number; stderr?: string }>;

function gitKaos(script: GitScript): Kaos {
  return createFakeKaos({
    exec: async (...args: string[]): Promise<KaosProcess> => {
      const subcommand = args[3] ?? '';
      // Match the full git invocation first (e.g. `rev-parse --abbrev-ref
      // HEAD`) so two commands sharing a subcommand (both `rev-parse`) can be
      // scripted distinctly; fall back to the bare subcommand.
      const full = args.slice(3).join(' ');
      const scripted = script[full] ?? script[subcommand];
      if (scripted === undefined) return fakeProcess('', 1);
      return fakeProcess(scripted.stdout, scripted.exitCode ?? 0, scripted.stderr ?? '');
    },
  });
}

describe('collectGitContext', () => {
  it('returns an unavailable block when the directory is not a git repository', async () => {
    const kaos = gitKaos({
      'rev-parse': {
        stdout: '',
        exitCode: 128,
        stderr: 'fatal: not a git repository (or any of the parent directories): .git',
      },
    });
    expect(await collectGitContext(kaos, '/project')).toBe(
      `<git-context status="unavailable" reason="not-a-repo"/>`,
    );
  });

  it('returns an empty string when rev-parse fails for a reason other than not-a-repo', async () => {
    const kaos = gitKaos({
      'rev-parse': { stdout: '', exitCode: 1, stderr: 'fatal: some other git error' },
    });
    expect(await collectGitContext(kaos, '/project')).toBe('');
  });

  it('returns an empty string when git fails to spawn', async () => {
    const kaos = createFakeKaos({
      exec: async (): Promise<KaosProcess> => {
        throw new Error('spawn failed');
      },
    });
    expect(await collectGitContext(kaos, '/project')).toBe('');
  });

  it('builds a git-context block with all sections', async () => {
    const kaos = gitKaos({
      'rev-parse': { stdout: 'true' },
      remote: { stdout: 'https://github.com/acme/widgets.git' },
      'symbolic-ref --short HEAD': { stdout: 'main' },
      status: { stdout: ' M src/a.ts\n?? src/b.ts' },
      log: { stdout: 'abc123 first commit\ndef456 second commit' },
    });

    const block = await collectGitContext(kaos, '/project');

    expect(block.startsWith('<git-context>\n')).toBe(true);
    expect(block.endsWith('\n</git-context>')).toBe(true);
    expect(block).toContain('Working directory: /project');
    expect(block).toContain('Remote: https://github.com/acme/widgets.git');
    expect(block).toContain('Project: acme/widgets');
    expect(block).toContain('Branch: main');
    expect(block).toContain('Dirty files (2):');
    expect(block).toContain('  ?? src/b.ts');
    expect(block).toContain('Recent commits:');
    expect(block).toContain('  abc123 first commit');
  });

  it('caps dirty files at 20 and reports the remainder', async () => {
    const dirty = Array.from({ length: 25 }, (_, i) => ` M src/f${String(i)}.ts`).join('\n');
    const kaos = gitKaos({
      'rev-parse': { stdout: 'true' },
      remote: { stdout: '' },
      'symbolic-ref --short HEAD': { stdout: '' },
      status: { stdout: dirty },
      log: { stdout: '' },
    });

    const block = await collectGitContext(kaos, '/project');

    expect(block).toContain('Dirty files (25):');
    expect(block).toContain('  ... and 5 more');
  });

  it('returns an empty string when only the working directory is known', async () => {
    const kaos = gitKaos({ 'rev-parse': { stdout: 'true' } });
    expect(await collectGitContext(kaos, '/project')).toBe('');
  });

  it('omits both Remote and Project for a disallowed remote host', async () => {
    const kaos = gitKaos({
      'rev-parse': { stdout: 'true' },
      remote: { stdout: 'git@internal.corp:secret/repo.git' },
      'symbolic-ref --short HEAD': { stdout: 'main' },
      status: { stdout: '' },
      log: { stdout: '' },
    });

    const block = await collectGitContext(kaos, '/project');

    expect(block).not.toContain('Remote:');
    expect(block).not.toContain('Project:');
    expect(block).not.toContain('secret/repo');
    expect(block).toContain('Branch: main');
  });

  it('keeps branch and status when the origin remote is absent', async () => {
    const kaos = gitKaos({
      'rev-parse': { stdout: 'true' },
      remote: { stdout: '', exitCode: 2, stderr: "error: No such remote 'origin'" },
      'symbolic-ref --short HEAD': { stdout: 'main' },
      status: { stdout: ' M src/a.ts' },
      log: { stdout: 'abc123 first commit' },
    });

    const block = await collectGitContext(kaos, '/project');

    expect(block).toContain('Branch: main');
    expect(block).toContain('Dirty files (1):');
    expect(block).toContain('Recent commits:');
    expect(block).not.toContain('Remote:');
    expect(block).not.toContain('Project:');
  });

  it('keeps branch and status when the repository has no commits yet', async () => {
    const kaos = gitKaos({
      'rev-parse': { stdout: 'true' },
      remote: { stdout: 'https://github.com/acme/widgets.git' },
      'symbolic-ref --short HEAD': { stdout: 'main' },
      status: { stdout: '' },
      log: {
        stdout: '',
        exitCode: 128,
        stderr: "fatal: your current branch 'main' does not have any commits yet",
      },
    });

    const block = await collectGitContext(kaos, '/project');

    expect(block).toContain('Branch: main');
    expect(block).toContain('Remote: https://github.com/acme/widgets.git');
    expect(block).toContain('Project: acme/widgets');
    expect(block).not.toContain('Recent commits:');
  });

  it('omits the Branch section in detached HEAD state', async () => {
    const kaos = gitKaos({
      'rev-parse': { stdout: 'true' },
      'symbolic-ref --short HEAD': {
        stdout: '',
        exitCode: 128,
        stderr: 'fatal: ref HEAD is not a symbolic ref',
      },
      remote: { stdout: 'https://github.com/acme/widgets.git' },
      status: { stdout: '' },
      log: { stdout: 'abc123 first commit' },
    });

    const block = await collectGitContext(kaos, '/project');

    expect(block).not.toContain('Branch:');
    expect(block).toContain('Remote: https://github.com/acme/widgets.git');
    expect(block).toContain('Recent commits:');
  });

  it('treats a hanging git command as a failure (timeout)', async () => {
    vi.useFakeTimers();
    try {
      const kaos = createFakeKaos({
        exec: async (): Promise<KaosProcess> => {
          let release: (code: number) => void = () => {};
          const exited = new Promise<number>((resolve) => {
            release = resolve;
          });
          return {
            stdin: { write: () => true, end: () => {} } as never,
            stdout: Readable.from(['']),
            stderr: Readable.from(['']),
            pid: 1,
            exitCode: null,
            wait: () => exited,
            // A real process exits once it receives SIGKILL.
            kill: async () => {
              release(137);
            },
            dispose: async () => {},
          };
        },
      });

      const promise = collectGitContext(kaos, '/project');
      await vi.advanceTimersByTimeAsync(6_000);
      expect(await promise).toBe('');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('sanitizeRemoteUrl', () => {
  it('strips credentials from an allowed HTTPS host', () => {
    expect(sanitizeRemoteUrl('https://user:pass@github.com/acme/widgets.git')).toBe(
      'https://github.com/acme/widgets.git',
    );
  });

  it('passes through an allowed SSH host', () => {
    expect(sanitizeRemoteUrl('git@github.com:acme/widgets.git')).toBe(
      'git@github.com:acme/widgets.git',
    );
  });

  it('rejects an unrecognized HTTPS host', () => {
    expect(sanitizeRemoteUrl('https://internal.corp/acme/widgets.git')).toBeNull();
  });

  it('rejects an unrecognized SSH host', () => {
    expect(sanitizeRemoteUrl('git@internal.corp:acme/widgets.git')).toBeNull();
  });

  it('passes through the SourceHut git host', () => {
    expect(sanitizeRemoteUrl('git@git.sr.ht:~user/repo')).toBe('git@git.sr.ht:~user/repo');
  });
});

describe('parseProjectName', () => {
  it('extracts owner/repo from an SSH URL', () => {
    expect(parseProjectName('git@github.com:acme/widgets.git')).toBe('acme/widgets');
  });

  it('extracts owner/repo from an HTTPS URL', () => {
    expect(parseProjectName('https://github.com/acme/widgets.git')).toBe('acme/widgets');
  });

  it('extracts owner/repo from an HTTPS URL without a .git suffix', () => {
    expect(parseProjectName('https://gitee.com/acme/widgets')).toBe('acme/widgets');
  });

  it('keeps the full namespace for nested GitLab groups (HTTPS)', () => {
    expect(parseProjectName('https://gitlab.com/group/subgroup/repo.git')).toBe(
      'group/subgroup/repo',
    );
  });

  it('keeps the full namespace for nested GitLab groups (SSH)', () => {
    expect(parseProjectName('git@gitlab.com:group/subgroup/repo.git')).toBe('group/subgroup/repo');
  });
});

describe('collectGitStatusSnapshot', () => {
  it('returns an empty string when the directory is not a git repository', async () => {
    const kaos = gitKaos({
      'rev-parse --is-inside-work-tree': {
        stdout: '',
        exitCode: 128,
        stderr: 'fatal: not a git repository (or any of the parent directories): .git',
      },
    });
    expect(await collectGitStatusSnapshot(kaos, '/project')).toBe('');
  });

  it('builds a snapshot with branch, main branch, status, and recent commits', async () => {
    const kaos = gitKaos({
      'rev-parse --is-inside-work-tree': { stdout: 'true' },
      'symbolic-ref --short HEAD': { stdout: 'feature/login' },
      'symbolic-ref --short refs/remotes/origin/HEAD': { stdout: 'origin/develop' },
      '--no-optional-locks status --short': { stdout: ' M src/a.ts\n?? src/b.ts' },
      '--no-optional-locks log --oneline -n 5': {
        stdout: 'abc123 first commit\ndef456 second commit',
      },
    });

    const snapshot = await collectGitStatusSnapshot(kaos, '/project');

    expect(snapshot).toContain('This is the git status at the start of the conversation.');
    expect(snapshot).toContain('will not update during the conversation');
    expect(snapshot).toContain('Current branch: feature/login');
    expect(snapshot).toContain('Main branch (you will usually use this for PRs): develop');
    // `runGit` trims stdout, so the porcelain marker on the first status line
    // loses its leading space (same behavior as Claude Code's snapshot).
    expect(snapshot).toContain('Status:\nM src/a.ts\n?? src/b.ts');
    expect(snapshot).toContain('Recent commits:\nabc123 first commit\ndef456 second commit');
  });

  it('reports a clean status as (clean)', async () => {
    const kaos = gitKaos({
      'rev-parse --is-inside-work-tree': { stdout: 'true' },
      'symbolic-ref --short HEAD': { stdout: 'main' },
      'symbolic-ref --short refs/remotes/origin/HEAD': { stdout: 'origin/main' },
      '--no-optional-locks status --short': { stdout: '' },
      '--no-optional-locks log --oneline -n 5': { stdout: 'abc123 first commit' },
    });

    const snapshot = await collectGitStatusSnapshot(kaos, '/project');

    expect(snapshot).toContain('Status:\n(clean)');
  });

  it('falls back to a local main branch when origin/HEAD is absent', async () => {
    const kaos = gitKaos({
      'rev-parse --is-inside-work-tree': { stdout: 'true' },
      'symbolic-ref --short HEAD': { stdout: 'main' },
      'rev-parse --verify refs/heads/main': { stdout: 'abc123' },
      '--no-optional-locks status --short': { stdout: '' },
      '--no-optional-locks log --oneline -n 5': { stdout: '' },
    });

    const snapshot = await collectGitStatusSnapshot(kaos, '/project');

    expect(snapshot).toContain('Main branch (you will usually use this for PRs): main');
  });

  it('falls back to a local master branch when neither origin/HEAD nor main exists', async () => {
    const kaos = gitKaos({
      'rev-parse --is-inside-work-tree': { stdout: 'true' },
      'symbolic-ref --short HEAD': { stdout: 'master' },
      'rev-parse --verify refs/heads/master': { stdout: 'abc123' },
      '--no-optional-locks status --short': { stdout: '' },
      '--no-optional-locks log --oneline -n 5': { stdout: '' },
    });

    const snapshot = await collectGitStatusSnapshot(kaos, '/project');

    expect(snapshot).toContain('Main branch (you will usually use this for PRs): master');
  });

  it("defaults the main branch to 'main' when no candidate resolves", async () => {
    const kaos = gitKaos({
      'rev-parse --is-inside-work-tree': { stdout: 'true' },
      'symbolic-ref --short HEAD': { stdout: 'feature/x' },
      '--no-optional-locks status --short': { stdout: '' },
      '--no-optional-locks log --oneline -n 5': { stdout: '' },
    });

    const snapshot = await collectGitStatusSnapshot(kaos, '/project');

    expect(snapshot).toContain('Main branch (you will usually use this for PRs): main');
  });

  it('truncates a status summary beyond 2k characters', async () => {
    const kaos = gitKaos({
      'rev-parse --is-inside-work-tree': { stdout: 'true' },
      'symbolic-ref --short HEAD': { stdout: 'main' },
      'symbolic-ref --short refs/remotes/origin/HEAD': { stdout: 'origin/main' },
      '--no-optional-locks status --short': { stdout: ` M ${'x'.repeat(3_000)}` },
      '--no-optional-locks log --oneline -n 5': { stdout: '' },
    });

    const snapshot = await collectGitStatusSnapshot(kaos, '/project');

    expect(snapshot).toContain('truncated because it exceeds 2k characters');
    expect(snapshot.length).toBeLessThan(3_000);
  });

  it('omits Recent commits when the repository has no commits yet', async () => {
    const kaos = gitKaos({
      'rev-parse --is-inside-work-tree': { stdout: 'true' },
      'symbolic-ref --short HEAD': { stdout: 'main' },
      'symbolic-ref --short refs/remotes/origin/HEAD': { stdout: 'origin/main' },
      '--no-optional-locks status --short': { stdout: '' },
      '--no-optional-locks log --oneline -n 5': {
        stdout: '',
        exitCode: 128,
        stderr: "fatal: your current branch 'main' does not have any commits yet",
      },
    });

    const snapshot = await collectGitStatusSnapshot(kaos, '/project');

    expect(snapshot).toContain('Current branch: main');
    expect(snapshot).not.toContain('Recent commits:');
  });

  it('omits the Current branch line in detached HEAD state', async () => {
    const kaos = gitKaos({
      'rev-parse --is-inside-work-tree': { stdout: 'true' },
      'symbolic-ref --short HEAD': {
        stdout: '',
        exitCode: 128,
        stderr: 'fatal: ref HEAD is not a symbolic ref',
      },
      'symbolic-ref --short refs/remotes/origin/HEAD': { stdout: 'origin/main' },
      '--no-optional-locks status --short': { stdout: '' },
      '--no-optional-locks log --oneline -n 5': { stdout: 'abc123 first commit' },
    });

    const snapshot = await collectGitStatusSnapshot(kaos, '/project');

    expect(snapshot).not.toContain('Current branch:');
    expect(snapshot).toContain('Recent commits:');
  });
});

describe('getGitStatusSnapshot (session memoization)', () => {
  afterEach(() => {
    _clearGitStatusSnapshotCacheForTests();
  });

  function countingGitKaos(script: GitScript): { kaos: Kaos; callCount: () => number } {
    let count = 0;
    const kaos = createFakeKaos({
      exec: async (...args: string[]): Promise<KaosProcess> => {
        count += 1;
        const subcommand = args[3] ?? '';
        const full = args.slice(3).join(' ');
        const scripted = script[full] ?? script[subcommand];
        if (scripted === undefined) return fakeProcess('', 1);
        return fakeProcess(scripted.stdout, scripted.exitCode ?? 0, scripted.stderr ?? '');
      },
    });
    return { kaos, callCount: () => count };
  }

  const repoScript: GitScript = {
    'rev-parse --is-inside-work-tree': { stdout: 'true' },
    'symbolic-ref --short HEAD': { stdout: 'main' },
    'symbolic-ref --short refs/remotes/origin/HEAD': { stdout: 'origin/main' },
    '--no-optional-locks status --short': { stdout: ' M src/a.ts' },
    '--no-optional-locks log --oneline -n 5': { stdout: 'abc123 first commit' },
  };

  it('computes the snapshot only once per cwd and reuses it on later renders', async () => {
    const { kaos, callCount } = countingGitKaos(repoScript);

    const first = await getGitStatusSnapshot(kaos, '/project');
    const execsAfterFirst = callCount();
    expect(execsAfterFirst).toBeGreaterThan(0);

    // Same-process re-renders (post-compaction refresh, post-resume refresh)
    // must reuse the memoized snapshot byte-for-byte instead of re-running
    // git — the system prompt is a stable prefix for prompt caching.
    const second = await getGitStatusSnapshot(kaos, '/project');
    expect(second).toBe(first);
    expect(callCount()).toBe(execsAfterFirst);
  });

  it('memoizes per cwd', async () => {
    const { kaos, callCount } = countingGitKaos(repoScript);

    await getGitStatusSnapshot(kaos, '/project');
    const afterFirst = callCount();
    await getGitStatusSnapshot(kaos, '/other-project');
    expect(callCount()).toBeGreaterThan(afterFirst);
  });

  it('memoizes the empty (non-git) result as well', async () => {
    const { kaos, callCount } = countingGitKaos({
      'rev-parse --is-inside-work-tree': {
        stdout: '',
        exitCode: 128,
        stderr: 'fatal: not a git repository (or any of the parent directories): .git',
      },
    });

    expect(await getGitStatusSnapshot(kaos, '/nowhere')).toBe('');
    const afterFirst = callCount();
    expect(await getGitStatusSnapshot(kaos, '/nowhere')).toBe('');
    expect(callCount()).toBe(afterFirst);
  });
});
