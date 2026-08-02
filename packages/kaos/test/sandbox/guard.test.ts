/**
 * Sandbox execution guard tests (bare-repo scrub + control-plane denyWrite).
 *
 * Unit-level coverage for `guard.ts`, plus end-to-end coverage of
 * `SandboxedKaos`'s per-exec guard: a fake identity backend captures the
 * policy the guard produced, and a real (optionally gated) bwrap run proves
 * the ro-bind actually denies writes inside the sandbox.
 */

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'pathe';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LocalKaos } from '#/local';
import type { KaosProcess } from '#/process';
import { isLikelySandboxDenied } from '#/sandbox/denial';
import {
  BARE_GIT_REPO_FILES,
  bareGitRepoGuardPaths,
  planSandboxGuard,
  scrubReplacedGuardSymlinks,
  scrubSandboxGuardPaths,
} from '#/sandbox/guard';
import { SandboxManager } from '#/sandbox/manager';
import { SandboxedKaos } from '#/sandbox/sandboxed-kaos';
import type {
  SandboxBackend,
  SandboxExecRequest,
  SandboxPolicy,
  SandboxProbeResult,
} from '#/sandbox/types';

const BWRAP_SMOKE =
  process.platform === 'linux' &&
  spawnSync('bwrap', ['--ro-bind', '/', '/', '--', 'true'], { stdio: 'ignore' }).status === 0;

/** Identity backend: reports available, records the policy, wraps nothing. */
class FakeBackend implements SandboxBackend {
  readonly name = 'fake';
  readonly policies: SandboxPolicy[] = [];

  probe(): Promise<SandboxProbeResult> {
    return Promise.resolve({ available: true });
  }

  buildCommand(req: SandboxExecRequest): { argv: string[]; env: Record<string, string> } {
    this.policies.push(req.policy);
    return { argv: [...req.argv], env: { ...req.env } };
  }
}

describe('bareGitRepoGuardPaths', () => {
  it('emits the five git-detection files per distinct base dir', () => {
    const paths = bareGitRepoGuardPaths(['/a', '/b', '/a']);
    expect(paths).toHaveLength(BARE_GIT_REPO_FILES.length * 2);
    for (const file of BARE_GIT_REPO_FILES) {
      expect(paths).toContain(resolve('/a', file));
      expect(paths).toContain(resolve('/b', file));
    }
  });
});

describe('planSandboxGuard', () => {
  let root: string;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'kaos-guard-plan-')));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('partitions scrub candidates by existence', () => {
    const existing = join(root, 'existing');
    writeFileSync(existing, 'x');
    const missing = join(root, 'missing');

    const plan = planSandboxGuard({ scrubCandidates: [existing, missing] });
    expect(plan.readOnlySubpaths).toEqual([resolve(existing)]);
    expect(plan.scrubPaths).toEqual([resolve(missing)]);
  });

  it('keeps existing read-only candidates and drops missing ones (never scrubbed)', () => {
    const existing = join(root, 'brand-home');
    mkdirSync(existing);
    const missing = join(root, 'not-there');

    const plan = planSandboxGuard({ readOnlyCandidates: [existing, missing] });
    expect(plan.readOnlySubpaths).toEqual([resolve(existing)]);
    expect(plan.scrubPaths).toEqual([]);
  });

  it('gives scrub semantics precedence when a path sits in both groups', () => {
    const missing = join(root, 'overlap');
    const plan = planSandboxGuard({
      scrubCandidates: [missing],
      readOnlyCandidates: [missing],
    });
    expect(plan.scrubPaths).toEqual([resolve(missing)]);
    expect(plan.readOnlySubpaths).toEqual([]);
  });

  it('dedups candidates across groups', () => {
    const existing = join(root, 'dup');
    writeFileSync(existing, 'x');
    const plan = planSandboxGuard({
      scrubCandidates: [existing, existing],
      readOnlyCandidates: [existing],
    });
    expect(plan.readOnlySubpaths).toEqual([resolve(existing)]);
  });

  it('ro-binds a symlink via its target AND records an identity watch', () => {
    const target = join(root, 'legit-target');
    mkdirSync(target);
    const link = join(root, '.cloud-code');
    symlinkSync(target, link);

    const plan = planSandboxGuard({ scrubCandidates: [link] });
    expect(plan.readOnlySubpaths).toEqual([resolve(link)]);
    expect(plan.scrubPaths).toEqual([]);
    expect(plan.symlinkWatches).toHaveLength(1);
    const watch = plan.symlinkWatches[0]!;
    expect(watch.path).toBe(resolve(link));
    expect(watch.target).toBe(target);
    expect(watch.ino).toBe(lstatSync(link).ino);
  });
});

describe('scrubReplacedGuardSymlinks', () => {
  let root: string;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'kaos-guard-link-')));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function watchFor(link: string, target: string) {
    return { path: resolve(link), ino: lstatSync(link).ino, target };
  }

  it('leaves an untouched symlink alone', () => {
    const target = join(root, 'target');
    mkdirSync(target);
    const link = join(root, 'link');
    symlinkSync(target, link);

    expect(scrubReplacedGuardSymlinks([watchFor(link, target)])).toEqual([]);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
  });

  it('scrubs a symlink replaced by a real directory (the review probe)', () => {
    const target = join(root, 'target');
    mkdirSync(target);
    writeFileSync(join(target, 'keep.md'), 'safe');
    const link = join(root, '.cloud-code');
    symlinkSync(target, link);
    const watch = watchFor(link, target);

    // The sandbox-side swap: the link path is a plain writable dentry, so
    // rm+mkdir replaces the whole entry while the ro-bound target survives.
    rmSync(link);
    mkdirSync(join(link, 'skills'), { recursive: true });
    writeFileSync(join(link, 'skills', 'SKILL.md'), '# planted');

    expect(scrubReplacedGuardSymlinks([watch])).toEqual([resolve(link)]);
    expect(existsSync(link)).toBe(false);
    expect(readFileSync(join(target, 'keep.md'), 'utf-8')).toBe('safe');
  });

  it('removes a symlink replaced by another symlink (target untouched)', () => {
    const target = join(root, 'target');
    mkdirSync(target);
    const decoy = join(root, 'decoy');
    mkdirSync(decoy);
    writeFileSync(join(decoy, 'x'), 'x');
    const link = join(root, 'link');
    symlinkSync(target, link);
    const watch = watchFor(link, target);

    rmSync(link);
    symlinkSync(decoy, link);

    expect(scrubReplacedGuardSymlinks([watch])).toEqual([resolve(link)]);
    expect(existsSync(link)).toBe(false);
    expect(existsSync(join(decoy, 'x'))).toBe(true);
  });

  it('ignores a deleted link with nothing planted in its place', () => {
    const target = join(root, 'target');
    mkdirSync(target);
    const link = join(root, 'link');
    symlinkSync(target, link);
    const watch = watchFor(link, target);

    rmSync(link);
    expect(scrubReplacedGuardSymlinks([watch])).toEqual([]);
    expect(existsSync(target)).toBe(true);
  });
});

describe('scrubSandboxGuardPaths', () => {
  let root: string;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'kaos-guard-scrub-')));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('removes planted files and directories, returns the removed paths', () => {
    const file = join(root, 'config');
    writeFileSync(file, '[core]\n\tfsmonitor = evil');
    const dir = join(root, 'objects');
    mkdirSync(join(dir, 'aa'), { recursive: true });
    writeFileSync(join(dir, 'aa', 'payload'), 'x');

    const removed = scrubSandboxGuardPaths([file, dir, join(root, 'never-existed')]);
    expect(removed).toEqual([file, dir]);
    expect(existsSync(file)).toBe(false);
    expect(existsSync(dir)).toBe(false);
  });

  it('removes a planted symlink without touching its target', () => {
    const target = join(root, 'target');
    writeFileSync(target, 'keep-me');
    const link = join(root, 'HEAD');
    symlinkSync(target, link);

    const removed = scrubSandboxGuardPaths([link]);
    expect(removed).toEqual([link]);
    expect(() => lstatSync(link)).toThrow();
    expect(readFileSync(target, 'utf-8')).toBe('keep-me');
  });

  it('is a silent no-op when nothing was planted', () => {
    expect(scrubSandboxGuardPaths([join(root, 'nope')])).toEqual([]);
  });
});

describe('SandboxedKaos execution guard (fake backend)', () => {
  let root: string;
  let workspace: string;
  let inner: LocalKaos;
  let backend: FakeBackend;

  beforeEach(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'kaos-guard-exec-')));
    workspace = join(root, 'ws');
    mkdirSync(workspace, { recursive: true });
    inner = (await LocalKaos.create()).withCwd(workspace);
    backend = new FakeBackend();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function sandboxed(
    guard?: { scrubPaths?: readonly string[]; readOnlyPaths?: readonly string[]; onScrub?: (p: readonly string[]) => void },
    mode: 'off' | 'auto' | 'enforce' = 'enforce',
  ): SandboxedKaos {
    const manager = new SandboxManager({ backends: [backend] });
    return new SandboxedKaos(
      inner,
      manager,
      { mode, network: 'allow', workspaceCwd: workspace },
      undefined,
      guard,
    );
  }

  async function run(proc: KaosProcess): Promise<number> {
    // Drain stdio so the process can exit, then wait for it.
    void (async () => {
      for await (const _ of proc.stdout) void _;
    })();
    void (async () => {
      for await (const _ of proc.stderr) void _;
    })();
    return proc.wait();
  }

  it('scrubs bare-repo payloads planted at the workspace after the command exits', async () => {
    const onScrub = vi.fn();
    const kaos = sandboxed({ onScrub });
    const proc = await kaos.exec(
      'sh',
      '-c',
      'mkdir -p objects refs hooks && echo "[core] fsmonitor = evil" > config && echo ref > HEAD',
    );
    expect(await run(proc)).toBe(0);

    for (const file of BARE_GIT_REPO_FILES) {
      expect(existsSync(join(workspace, file))).toBe(false);
    }
    const scrubbed = onScrub.mock.calls.flatMap((call) => call[0] as readonly string[]);
    for (const file of BARE_GIT_REPO_FILES) {
      expect(scrubbed).toContain(resolve(join(workspace, file)));
    }
  });

  it('ro-binds pre-existing bare-repo files instead of scrubbing them', async () => {
    // A pre-existing HEAD (e.g. the user genuinely works inside a bare repo)
    // must be protected in place — never deleted.
    writeFileSync(join(workspace, 'HEAD'), 'ref: refs/heads/main');
    const kaos = sandboxed();
    const proc = await kaos.exec('sh', '-c', 'echo planted > objects');
    expect(await run(proc)).toBe(0);

    const policy = backend.policies.at(-1);
    expect(policy?.readOnlySubpaths).toContain(resolve(join(workspace, 'HEAD')));
    expect(readFileSync(join(workspace, 'HEAD'), 'utf-8')).toBe('ref: refs/heads/main');
    // ...while the planted `objects` file was scrubbed.
    expect(existsSync(join(workspace, 'objects'))).toBe(false);
  });

  it('covers guard scrubPaths: existing control-plane dirs ro-bound, planted ones scrubbed', async () => {
    const skillsDir = join(workspace, '.cloud-code', 'skills');
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(join(skillsDir, 'SKILL.md'), '# legit');
    const agentsSkills = join(workspace, '.agents', 'skills');

    const kaos = sandboxed({
      scrubPaths: [join(workspace, '.cloud-code'), agentsSkills],
    });
    const proc = await kaos.exec(
      'sh',
      '-c',
      'mkdir -p .agents/skills/evil && echo x > .agents/skills/evil/SKILL.md',
    );
    expect(await run(proc)).toBe(0);

    const policy = backend.policies.at(-1);
    expect(policy?.readOnlySubpaths).toContain(resolve(join(workspace, '.cloud-code')));
    // The planted skills dir is gone; the pre-existing one is untouched.
    expect(existsSync(agentsSkills)).toBe(false);
    expect(readFileSync(join(skillsDir, 'SKILL.md'), 'utf-8')).toBe('# legit');
  });

  it('never scrubs readOnlyPaths that did not exist at exec time', async () => {
    const futureDir = join(workspace, 'future');
    const kaos = sandboxed({ readOnlyPaths: [futureDir] });
    const proc = await kaos.exec('sh', '-c', 'mkdir future && echo x > future/file');
    expect(await run(proc)).toBe(0);

    // Missing read-only candidates are dropped (bwrap cannot bind them), and
    // the guard deliberately does not scrub them afterwards.
    expect(backend.policies.at(-1)?.readOnlySubpaths ?? []).not.toContain(resolve(futureDir));
    expect(existsSync(join(futureDir, 'file'))).toBe(true);
  });

  it('does not guard unsandboxed runs', async () => {
    const kaos = sandboxed(undefined, 'off');
    const proc = await kaos.exec('sh', '-c', 'mkdir -p HEAD objects refs && echo x > config');
    expect(await run(proc)).toBe(0);
    expect(existsSync(join(workspace, 'HEAD'))).toBe(true);
    expect(existsSync(join(workspace, 'config'))).toBe(true);
  });

  it('applies the guard to execWithEnv too', async () => {
    const kaos = sandboxed();
    const proc = await kaos.execWithEnv(['sh', '-c', 'echo planted > HEAD'], { FOO: '1' });
    expect(await run(proc)).toBe(0);
    expect(existsSync(join(workspace, 'HEAD'))).toBe(false);
  });

  it('scrubs a planted .git/hooks directory while a real one would be ro-bound', async () => {
    // A non-repo workspace: `.git/hooks` does not exist at exec time, so a
    // command creating hook scripts plants executable payload for the next
    // host-side git run — it must not survive the command.
    const kaos = sandboxed({
      scrubPaths: [join(workspace, '.git', 'hooks')],
      readOnlyPaths: [join(workspace, '.git', 'config')],
    });
    const proc = await kaos.exec(
      'sh',
      '-c',
      'mkdir -p .git/hooks && echo "#!/bin/sh\nevil" > .git/hooks/pre-commit',
    );
    expect(await run(proc)).toBe(0);
    expect(existsSync(join(workspace, '.git', 'hooks'))).toBe(false);
  });

  it('scrubs a symlinked control-plane dir replaced mid-command, target intact', async () => {
    // Review probe: `.cloud-code` is a symlink. The ro-bind lands on the
    // link TARGET, leaving the link path a writable dentry — rm+mkdir swaps
    // the whole entry. The identity watch must catch the swap.
    const outside = join(root, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'legit.md'), 'safe');
    symlinkSync(outside, join(workspace, '.cloud-code'));

    const onScrub = vi.fn();
    const kaos = sandboxed({ scrubPaths: [join(workspace, '.cloud-code')], onScrub });
    const proc = await kaos.exec(
      'sh',
      '-c',
      'rm .cloud-code && mkdir -p .cloud-code/skills && echo planted > .cloud-code/skills/SKILL.md',
    );
    expect(await run(proc)).toBe(0);

    // The replacement is gone; the link target is untouched.
    expect(existsSync(join(workspace, '.cloud-code'))).toBe(false);
    expect(readFileSync(join(outside, 'legit.md'), 'utf-8')).toBe('safe');
    const scrubbed = onScrub.mock.calls.flatMap((call) => call[0] as readonly string[]);
    expect(scrubbed).toContain(resolve(join(workspace, '.cloud-code')));
  });

  it('leaves an untouched symlinked control-plane dir alone', async () => {
    const outside = join(root, 'outside');
    mkdirSync(outside);
    symlinkSync(outside, join(workspace, '.cloud-code'));

    const kaos = sandboxed({ scrubPaths: [join(workspace, '.cloud-code')] });
    const proc = await kaos.exec('sh', '-c', 'echo harmless');
    expect(await run(proc)).toBe(0);
    expect(lstatSync(join(workspace, '.cloud-code')).isSymbolicLink()).toBe(true);
  });

  it('ignores a control-plane symlink that was deleted without replacement', async () => {
    const outside = join(root, 'outside');
    mkdirSync(outside);
    symlinkSync(outside, join(workspace, '.cloud-code'));

    const kaos = sandboxed({ scrubPaths: [join(workspace, '.cloud-code')] });
    const proc = await kaos.exec('sh', '-c', 'rm .cloud-code');
    expect(await run(proc)).toBe(0);
    // Nothing to scrub (the deletion already happened); the target survives.
    expect(existsSync(join(workspace, '.cloud-code'))).toBe(false);
    expect(existsSync(outside)).toBe(true);
  });
});

describe.skipIf(!BWRAP_SMOKE)('SandboxedKaos guard (real bwrap)', () => {
  let root: string;
  let workspace: string;
  let inner: LocalKaos;

  beforeEach(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'kaos-guard-bwrap-')));
    workspace = join(root, 'ws');
    mkdirSync(workspace, { recursive: true });
    inner = (await LocalKaos.create()).withCwd(workspace);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function collect(proc: KaosProcess): Promise<{ exitCode: number; stderr: string }> {
    const stderrChunks: Buffer[] = [];
    void (async () => {
      for await (const chunk of proc.stdout) void chunk;
    })();
    void (async () => {
      for await (const chunk of proc.stderr) stderrChunks.push(Buffer.from(chunk as Buffer));
    })();
    const exitCode = await proc.wait();
    return { exitCode, stderr: Buffer.concat(stderrChunks).toString('utf-8') };
  }

  it('denies writes to a pre-existing skills dir inside the sandbox', async () => {
    const skillsDir = join(workspace, '.cloud-code', 'skills');
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(join(skillsDir, 'SKILL.md'), '# legit');

    const manager = new SandboxManager();
    const kaos = new SandboxedKaos(
      inner,
      manager,
      { mode: 'enforce', network: 'allow', workspaceCwd: workspace },
      undefined,
      { scrubPaths: [join(workspace, '.cloud-code')] },
    );
    const proc = await kaos.exec(
      'sh',
      '-c',
      'echo poison > .cloud-code/skills/evil.md && echo WROTE || echo DENIED',
    );
    const result = await collect(proc);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toContain('WROTE');
    expect(existsSync(join(skillsDir, 'evil.md'))).toBe(false);
    expect(readFileSync(join(skillsDir, 'SKILL.md'), 'utf-8')).toBe('# legit');
  });

  it('lets a missing skills dir be created inside the sandbox, then scrubs it on the host', async () => {
    const manager = new SandboxManager();
    const kaos = new SandboxedKaos(
      inner,
      manager,
      { mode: 'enforce', network: 'allow', workspaceCwd: workspace },
      undefined,
      { scrubPaths: [join(workspace, '.cloud-code')] },
    );
    const proc = await kaos.exec(
      'sh',
      '-c',
      'mkdir -p .cloud-code/skills/evil && echo x > .cloud-code/skills/evil/SKILL.md',
    );
    const result = await collect(proc);
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(workspace, '.cloud-code'))).toBe(false);
  });
});

const GIT_OK =
  process.platform === 'linux' &&
  spawnSync('git', ['--version'], { stdio: 'ignore' }).status === 0;

function gitOrThrow(cwd: string, args: readonly string[]): void {
  const result = spawnSync('git', [...args], { cwd, stdio: 'ignore' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed with status ${String(result.status)}`);
  }
}

describe.skipIf(!BWRAP_SMOKE || !GIT_OK)('SandboxedKaos guard (real bwrap, real git)', () => {
  let root: string;
  let workspace: string;
  let inner: LocalKaos;

  beforeEach(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'kaos-guard-git-')));
    workspace = join(root, 'ws');
    mkdirSync(workspace, { recursive: true });
    inner = (await LocalKaos.create()).withCwd(workspace);
    // A real repo: .git/hooks and .git/config exist and get ro-bound.
    gitOrThrow(workspace, ['init']);
    writeFileSync(join(workspace, 'f.txt'), 'x');
    gitOrThrow(workspace, ['add', '.']);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function collect(proc: KaosProcess): Promise<{ exitCode: number; stderr: string }> {
    const stderrChunks: Buffer[] = [];
    void (async () => {
      for await (const chunk of proc.stdout) void chunk;
    })();
    void (async () => {
      for await (const chunk of proc.stderr) stderrChunks.push(Buffer.from(chunk as Buffer));
    })();
    const exitCode = await proc.wait();
    return { exitCode, stderr: Buffer.concat(stderrChunks).toString('utf-8') };
  }

  function sandboxedGit(): SandboxedKaos {
    return new SandboxedKaos(
      inner,
      new SandboxManager(),
      { mode: 'enforce', network: 'allow', workspaceCwd: workspace },
      undefined,
      {
        scrubPaths: [join(workspace, '.git', 'hooks')],
        readOnlyPaths: [join(workspace, '.git', 'config')],
      },
    );
  }

  it('denies hook drops and config writes, but git commit still works', async () => {
    const kaos = sandboxedGit();

    // Dropping a hook is executable payload for the next host git run.
    const hook = await collect(await kaos.exec('sh', '-c', 'echo evil > .git/hooks/pre-commit'));
    expect(hook.exitCode).not.toBe(0);
    expect(isLikelySandboxDenied({ exitCode: hook.exitCode, output: hook.stderr })).toBe(true);
    expect(existsSync(join(workspace, '.git', 'hooks', 'pre-commit'))).toBe(false);

    // core.sshCommand / core.fsmonitor injection via git config is denied
    // the same way (accepted tradeoff: the denial matches the heuristic, so
    // the escalation approval channel offers an unsandboxed retry). git
    // writes config via lock+rename onto the ro-bound mountpoint, which
    // fails EBUSY — the heuristic covers that shape too (see denial.ts).
    // LC_ALL=C: the heuristic matches English keywords, and git localizes.
    const config = await collect(
      await kaos.execWithEnv(['git', 'config', 'user.email', 'evil@x.y'], { LC_ALL: 'C' }),
    );
    expect(config.exitCode).not.toBe(0);
    expect(isLikelySandboxDenied({ exitCode: config.exitCode, output: config.stderr })).toBe(true);
    expect(readFileSync(join(workspace, '.git', 'config'), 'utf-8')).not.toContain('evil@x.y');

    // `.git` is NOT guarded wholesale: objects/index/refs stay writable, so
    // sandboxed git commit keeps working. gpgsign is off: the host's global
    // config may require signing, and the deny-read mask hides ~/.gnupg.
    const commit = await collect(
      await kaos.exec(
        'git',
        '-c',
        'user.email=t@t.c',
        '-c',
        'user.name=t',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '--allow-empty',
        '-m',
        'x',
      ),
    );
    expect(commit.exitCode).toBe(0);
    const log = spawnSync('git', ['log', '--oneline'], { cwd: workspace, encoding: 'utf-8' });
    expect(log.stdout.trim().split('\n')).toHaveLength(1);
  });

  it('scrubs a hooks dir planted over a deleted real one only when the swap is detectable', async () => {
    // The real hooks dir is ro-bind mounted: rm of the mountpoint fails
    // (EBUSY), so an in-sandbox swap is denied outright — belt and braces
    // on top of the write denial asserted above.
    const kaos = sandboxedGit();
    const swap = await collect(
      await kaos.exec('sh', '-c', 'rm -rf .git/hooks && mkdir .git/hooks && echo evil > .git/hooks/pre-commit'),
    );
    expect(swap.exitCode).not.toBe(0);
    expect(existsSync(join(workspace, '.git', 'hooks', 'pre-commit'))).toBe(false);
    // The real hooks dir (with its samples) is still in place on the host.
    expect(existsSync(join(workspace, '.git', 'hooks'))).toBe(true);
  });
});
