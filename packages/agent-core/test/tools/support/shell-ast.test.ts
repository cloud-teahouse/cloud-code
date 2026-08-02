import { afterEach, describe, expect, it, vi } from 'vitest';

import { literalRulePattern, matchesGlobRuleSubject } from '../../../src/tools/support/rule-match';
import {
  analyzeBashCommand,
  classifyGitSegment,
  clearBashAnalysisCacheForTests,
  stripWrapperPrefixes,
  stripWrapperTokens,
  type GitSegmentClass,
} from '../../../src/tools/support/shell-ast';
import { resetBashParserForTests } from '../../../src/tools/support/shell-ast/parser';

const wasmMock = vi.hoisted(() => ({ fail: false }));

vi.mock('web-tree-sitter', async (importOriginal) => {
  const actual = await importOriginal<typeof import('web-tree-sitter')>();
  class MockParser extends actual.Parser {
    static override async init(
      moduleOptions?: Parameters<typeof actual.Parser.init>[0],
    ): Promise<void> {
      if (wasmMock.fail) throw new Error('mock wasm init failure');
      return actual.Parser.init(moduleOptions);
    }
  }
  return { ...actual, Parser: MockParser };
});

afterEach(() => {
  wasmMock.fail = false;
  resetBashParserForTests();
  clearBashAnalysisCacheForTests();
});

describe('analyzeBashCommand', () => {
  it('splits a baseline compound command on &&', async () => {
    const analysis = await analyzeBashCommand('git add . && git push');
    expect(analysis.degraded).toBe(false);
    expect(analysis.subjects).toEqual(['git add .', 'git push']);
    expect(analysis.approvalRules).toEqual(['Bash(git add *)', 'Bash(git push *)']);
  });

  it('keeps the redirect in the subject but out of the arity prefix', async () => {
    const analysis = await analyzeBashCommand('cat a > b');
    expect(analysis.subjects).toEqual(['cat a > b']);
    expect(analysis.approvalRules).toEqual(['Bash(cat *)']);
  });

  it('recurses into $() command substitutions', async () => {
    const analysis = await analyzeBashCommand('rm -rf $(echo x)');
    expect(analysis.subjects).toEqual(['rm -rf $(echo x)', 'echo x']);
    expect(analysis.approvalRules).toEqual(['Bash(rm *)', 'Bash(echo *)']);
  });

  it('exposes nested destructive commands inside substitutions', async () => {
    const analysis = await analyzeBashCommand('git push $(rm -rf ~)');
    expect(analysis.subjects).toEqual(['git push $(rm -rf ~)', 'rm -rf ~']);
    expect(analysis.approvalRules).toContain('Bash(rm *)');
  });

  it('recurses into backtick substitutions', async () => {
    const analysis = await analyzeBashCommand('rm `echo x`');
    expect(analysis.subjects).toEqual(['rm `echo x`', 'echo x']);
    expect(analysis.approvalRules).toEqual(['Bash(rm *)', 'Bash(echo *)']);
  });

  it('splits pipelines into one subject per stage', async () => {
    const analysis = await analyzeBashCommand('ps aux | grep node');
    expect(analysis.subjects).toEqual(['ps aux', 'grep node']);
    expect(analysis.approvalRules).toEqual(['Bash(ps *)', 'Bash(grep *)']);
  });

  it('skips leading variable assignments when computing the prefix', async () => {
    const analysis = await analyzeBashCommand('FOO=1 make build');
    expect(analysis.subjects).toEqual(['FOO=1 make build']);
    expect(analysis.approvalRules).toEqual(['Bash(make build *)']);
  });

  it('treats every command inside a subshell as its own segment', async () => {
    // Deliberate divergence from opencode, which emits no pattern for cd:
    // segments stay uniform so ∀-allow coverage has no special cases.
    const analysis = await analyzeBashCommand('(cd /tmp && rm x)');
    expect(analysis.subjects).toEqual(['cd /tmp', 'rm x']);
    expect(analysis.approvalRules).toEqual(['Bash(cd *)', 'Bash(rm *)']);
  });

  it('cannot see inside bash -c (known limitation)', async () => {
    const analysis = await analyzeBashCommand("bash -c 'rm -rf /'");
    expect(analysis.subjects).toEqual(["bash -c 'rm -rf /'"]);
    expect(analysis.approvalRules).toEqual(['Bash(bash *)']);
  });

  it('strips sudo before the arity prefix (C3 P2 fixes the over-broad grant)', async () => {
    const analysis = await analyzeBashCommand('sudo rm -rf /');
    expect(analysis.approvalRules).toEqual(['Bash(rm *)']);
  });

  it('counts flags as prefix tokens for git -C (inherited arity-table defect)', async () => {
    const analysis = await analyzeBashCommand('git -C /x log');
    expect(analysis.approvalRules).toEqual(['Bash(git -C *)']);
  });

  it('fails safe when a subject contains a tab', async () => {
    const analysis = await analyzeBashCommand('git\tpush origin main');
    expect(analysis.degraded).toBe(false);
    expect(analysis.subjects).toEqual(['git\tpush origin main']);
    // The arity prefix is computed from tokens, but the generated glob can
    // never match the tabbed subject — the call degrades to asking, which
    // is the safe direction.
    expect(analysis.approvalRules).toEqual(['Bash(git push *)']);
    expect(matchesGlobRuleSubject('git push *', analysis.subjects[0]!)).toBe(false);
  });

  it('parses heredocs as a single segment', async () => {
    const analysis = await analyzeBashCommand('cat <<EOF\nhello world\nEOF');
    expect(analysis.degraded).toBe(false);
    expect(analysis.subjects).toEqual(['cat <<EOF\nhello world\nEOF']);
    expect(analysis.approvalRules).toEqual(['Bash(cat *)']);
  });

  it('does not throw on unparseable input and degrades instead', async () => {
    const analysis = await analyzeBashCommand('(((');
    expect(analysis.degraded).toBe(true);
    expect(analysis.subjects).toEqual(['(((']);
    expect(analysis.approvalRules).toEqual([literalRulePattern('Bash', '(((')]);
  });

  it('does not throw on an empty command and degrades instead', async () => {
    const analysis = await analyzeBashCommand('');
    expect(analysis.degraded).toBe(true);
    expect(analysis.subjects).toEqual(['']);
  });

  it('handles very long commands', async () => {
    const command = `echo ${'x'.repeat(10 * 1024)}`;
    const analysis = await analyzeBashCommand(command);
    expect(analysis.degraded).toBe(false);
    expect(analysis.subjects).toEqual([command]);
    expect(analysis.approvalRules).toEqual(['Bash(echo *)']);
  });

  it('memoizes analyses per command string', async () => {
    const first = await analyzeBashCommand('git status');
    const second = await analyzeBashCommand('git status');
    expect(second).toBe(first);
  });

  it('parses 1000 typical commands within the smoke budget', async () => {
    const startedAt = performance.now();
    for (let i = 0; i < 1000; i++) {
      await analyzeBashCommand(`git checkout -b feature/${String(i)} && git push`);
    }
    // Loose CI-friendly threshold; locally this runs in well under 1s once
    // the parser is warm.
    expect(performance.now() - startedAt).toBeLessThan(10_000);
  }, 30_000);

  describe('degradation', () => {
    it('falls back to whole-string matching when wasm init fails', async () => {
      wasmMock.fail = true;
      resetBashParserForTests();
      const command = 'git st && rm x --wasm-init-failure-marker';
      const analysis = await analyzeBashCommand(command);

      expect(analysis.degraded).toBe(true);
      expect(analysis.subjects).toEqual([command]);
      expect(analysis.approvalRules).toEqual([literalRulePattern('Bash', command)]);
    });

    it('keeps pre-F2 matching semantics in the degraded form', async () => {
      wasmMock.fail = true;
      resetBashParserForTests();
      const command = 'printf hello --degraded-marker';
      const analysis = await analyzeBashCommand(command);

      // Single subject == whole command: ∃/∀ collapse to the old behavior,
      // including `!` negation.
      const [subject] = analysis.subjects;
      expect(matchesGlobRuleSubject('printf *', subject!)).toBe(true);
      expect(matchesGlobRuleSubject('!printf *', subject!)).toBe(false);
    });
  });
});

describe('git classification', () => {
  async function gitClassOf(command: string): Promise<GitSegmentClass> {
    const analysis = await analyzeBashCommand(command);
    expect(analysis.degraded).toBe(false);
    expect(analysis.segments).toHaveLength(1);
    return analysis.segments[0]!.gitClass;
  }

  it('classifies read-only subcommands as read', async () => {
    for (const command of ['git status', 'git log --oneline', 'git diff', 'git show v1.0']) {
      expect(await gitClassOf(command)).toBe('read');
    }
  });

  it('classifies plain local mutations as local-write', async () => {
    for (const args of [
      'commit -m x',
      'add .',
      'checkout main',
      'switch -c topic',
      'restore a.txt',
      'merge topic',
      'stash',
      'pull',
      'fetch origin',
      'tag v1.0',
      'branch topic',
    ]) {
      expect(await gitClassOf(`git ${args}`)).toBe('local-write');
    }
  });

  it('classifies push as shared-remote', async () => {
    expect(await gitClassOf('git push origin main')).toBe('shared-remote');
  });

  it('classifies history rewriting as history-write', async () => {
    for (const args of [
      'reset --hard HEAD~1',
      'rebase main',
      'commit --amend',
      'update-ref refs/heads/topic HEAD',
      'filter-branch --force',
      'reflog expire --expire=now --all',
      'branch -D topic',
      'tag -f v1.0',
    ]) {
      expect(await gitClassOf(`git ${args}`)).toBe('history-write');
    }
  });

  it('classifies the inline-config trio as config-injection', async () => {
    for (const command of [
      'git -c alias.x=!rm co',
      'git --exec-path=/tmp/x status',
      'git --config-env=FOO=bar co',
    ]) {
      expect(await gitClassOf(command)).toBe('config-injection');
    }
  });

  it('classifies unknown subcommands (possibly aliases) as unknown', async () => {
    expect(await gitClassOf('git co')).toBe('unknown');
  });

  it('classifies non-git commands as undefined', async () => {
    expect(await gitClassOf('ls -la')).toBeUndefined();
    expect(await gitClassOf('echo hello')).toBeUndefined();
  });

  it('recognizes git by basename', async () => {
    expect(await gitClassOf('/usr/bin/git push origin main')).toBe('shared-remote');
  });

  it('treats -C as a path flag, not config injection', async () => {
    expect(await gitClassOf('git -C /tmp log')).toBe('read');
  });

  it('escalates commit to history-write only with --amend', async () => {
    expect(await gitClassOf('git commit -m x')).toBe('local-write');
    expect(await gitClassOf('git commit --amend -m x')).toBe('history-write');
  });

  it('classifies every segment of a compound command independently', async () => {
    const analysis = await analyzeBashCommand('git status && ls && git push');
    expect(analysis.segments.map((segment) => segment.gitClass)).toEqual([
      'read',
      undefined,
      'shared-remote',
    ]);
  });

  it('leaves the degraded form unclassified', async () => {
    wasmMock.fail = true;
    resetBashParserForTests();
    const analysis = await analyzeBashCommand('git push --degraded-marker');
    expect(analysis.degraded).toBe(true);
    expect(analysis.segments).toEqual([
      { subject: 'git push --degraded-marker', tokens: [], gitClass: undefined },
    ]);
  });
});

describe('classifyGitSegment global-flag consumption', () => {
  const cases: Array<{ tokens: readonly string[]; expected: GitSegmentClass }> = [
    // `-C` consumes the next token as a path; the subcommand sits behind it.
    { tokens: ['git', '-C', '/tmp', 'push'], expected: 'shared-remote' },
    // Separate-value long options consume their value too.
    { tokens: ['git', '--git-dir', '/x', 'log'], expected: 'read' },
    { tokens: ['git', '--work-tree', '/x', 'status'], expected: 'read' },
    { tokens: ['git', '--namespace', 'ns', 'push'], expected: 'shared-remote' },
    // The `=` spellings are self-contained.
    { tokens: ['git', '--git-dir=/x', 'log'], expected: 'read' },
    // Valueless global options are skipped without consuming.
    { tokens: ['git', '--no-pager', 'log'], expected: 'read' },
    // Config injection, separate and attached spellings alike.
    { tokens: ['git', '-c', 'alias.x=!rm', 'status'], expected: 'config-injection' },
    { tokens: ['git', '-calias.x=!rm', 'status'], expected: 'config-injection' },
    { tokens: ['git', '--config-env', 'FOO=bar', 'status'], expected: 'config-injection' },
    { tokens: ['git', '--exec-path', '/tmp/x', 'status'], expected: 'config-injection' },
    // Injection flags only count before the subcommand.
    { tokens: ['git', 'push', '-c', 'x=y'], expected: 'shared-remote' },
    // git without a subcommand prints usage/version or errors out.
    { tokens: ['git'], expected: 'read' },
    { tokens: ['git', '--version'], expected: 'read' },
    { tokens: ['git', '-C'], expected: 'read' },
    // classifyGitSegment itself still runs on whatever token view it is
    // given: wrappers are not stripped inside the classifier, so the name
    // is not git. (The analysis layer DOES feed it the stripped view —
    // see "git classification with wrapper stripping" below.)
    { tokens: ['sudo', 'git', 'push'], expected: undefined },
    // Flag arguments stop at the `--` pathspec separator.
    { tokens: ['git', 'commit', '--', '--amend'], expected: 'local-write' },
    { tokens: ['git', 'tag', '-f', '--', 'v1'], expected: 'history-write' },
    { tokens: ['git', 'branch', '--delete', '--force', 'topic'], expected: 'history-write' },
    { tokens: ['git', 'branch', '-d', 'topic'], expected: 'local-write' },
    { tokens: ['git', 'reflog'], expected: 'read' },
    { tokens: ['git', 'reflog', 'delete', 'ref@{1}'], expected: 'history-write' },
  ];

  it('follows the documented consumption table', () => {
    for (const { tokens, expected } of cases) {
      expect(classifyGitSegment(tokens), tokens.join(' ')).toBe(expected);
    }
  });
});

describe('git classification with wrapper stripping (C3 P3)', () => {
  async function gitClassOf(command: string, stripWrappers?: boolean): Promise<GitSegmentClass> {
    const analysis = await analyzeBashCommand(command, { stripWrappers });
    expect(analysis.degraded).toBe(false);
    // First segment is the (possibly wrapped) outer command; substitutions
    // in it surface as their own later segments.
    return analysis.segments[0]!.gitClass;
  }

  it('classifies a wrapped git command by what actually runs', async () => {
    expect(await gitClassOf('sudo git push origin main')).toBe('shared-remote');
    expect(await gitClassOf('FOO=bar sudo git push origin main')).toBe('shared-remote');
    expect(await gitClassOf('timeout 10 git commit -m x')).toBe('local-write');
    expect(await gitClassOf('env FOO=bar sudo git reset --hard')).toBe('history-write');
  });

  it('falls back to the raw view when the strip is refused', async () => {
    // `sudo -u $(whoami) git push`: the substituted flag value refuses the
    // strip, the raw tokens start with sudo, and the gate stays blind —
    // exactly the pre-P3 visibility for adversarial wrappers.
    expect(await gitClassOf('sudo -u $(whoami) git push')).toBeUndefined();
  });

  it('keeps raw-token classification with stripWrappers: false', async () => {
    expect(await gitClassOf('sudo git push origin main', false)).toBeUndefined();
  });
});

describe('wrapper stripping for rule generation (C3 P2)', () => {
  async function rulesOf(command: string, stripWrappers?: boolean): Promise<readonly string[]> {
    const analysis = await analyzeBashCommand(command, { stripWrappers });
    expect(analysis.degraded).toBe(false);
    return analysis.approvalRules;
  }

  it('strips sudo so `sudo git push` grants `git push *`, not `sudo *`', async () => {
    expect(await rulesOf('sudo git push origin main')).toEqual(['Bash(git push *)']);
  });

  it('strips wrapper chains and leading env assignments', async () => {
    // The leading `FOO=bar` assignment never reaches the token stream
    // (the parser keeps it out of `parts()`), sudo is peeled.
    expect(await rulesOf('FOO=bar sudo git push origin main')).toEqual(['Bash(git push *)']);
    expect(await rulesOf('sudo -- rm x')).toEqual(['Bash(rm *)']);
    expect(await rulesOf('sudo -u root rm x')).toEqual(['Bash(rm *)']);
    expect(await rulesOf('doas rm x')).toEqual(['Bash(rm *)']);
    expect(await rulesOf('/usr/bin/sudo rm x')).toEqual(['Bash(rm *)']);
  });

  it('strips timeout including the DURATION, but refuses unsafe flag values', async () => {
    expect(await rulesOf('timeout 10 ls')).toEqual(['Bash(ls *)']);
    expect(await rulesOf('timeout -k 5 10 sudo ls -la')).toEqual(['Bash(ls *)']);
    expect(await rulesOf('timeout --signal=TERM 1.5m git push')).toEqual(['Bash(git push *)']);
    // `timeout -k$(id) 10 ls`: the flag value leaves the [A-Za-z0-9_.+-]
    // allowlist, so the strip is refused for the whole segment and the
    // pre-P2 shape comes back. The inner `id` stays its own segment.
    expect(await rulesOf('timeout -k$(id) 10 ls')).toEqual(['Bash(timeout *)', 'Bash(id *)']);
  });

  it('refuses the whole strip when one wrapper in the chain is unsafe', async () => {
    // sudo alone would strip, but the refused timeout behind it rolls
    // the segment back to raw tokens.
    expect(await rulesOf('sudo timeout -k$(id) 10 ls')).toEqual(['Bash(sudo *)', 'Bash(id *)']);
    // A substituted flag value stays visible as a `$(...)` token and
    // fails the allowlist instead of letting `-u` eat the next word.
    expect(await rulesOf('sudo -u $(whoami) rm x')).toEqual(['Bash(sudo *)', 'Bash(whoami *)']);
  });

  it('honors the two-phase boundary: VAR=val after a wrapper is command text', async () => {
    // Phase 1 (pre-wrapper assignments) is invisible in tokens, so after
    // peeling sudo the `FOO=bar` token is the command sudo would exec —
    // stripping must stop there (HackerOne #3543050).
    expect(await rulesOf('sudo FOO=bar rm x')).toEqual(['Bash(FOO=bar *)']);
  });

  it('strips env including its own VAR=val arguments, then keeps unwrapping', async () => {
    expect(await rulesOf('env FOO=bar sudo rm x')).toEqual(['Bash(rm *)']);
    expect(await rulesOf('env -i FOO=bar PATH=/usr/bin ls -la')).toEqual(['Bash(ls *)']);
    // env with only assignments prints the environment: nothing to strip to.
    expect(await rulesOf('env FOO=bar')).toEqual(['Bash(env *)']);
  });

  it('strips the remaining wrappers of the table', async () => {
    expect(await rulesOf('nice -n 5 rm x')).toEqual(['Bash(rm *)']);
    expect(await rulesOf('nice -5 rm x')).toEqual(['Bash(rm *)']);
    expect(await rulesOf('nohup git push')).toEqual(['Bash(git push *)']);
    expect(await rulesOf('time git push')).toEqual(['Bash(git push *)']);
    expect(await rulesOf('stdbuf -o0 git push')).toEqual(['Bash(git push *)']);
    expect(await rulesOf('command ls -la')).toEqual(['Bash(ls *)']);
    expect(await rulesOf('builtin cd /tmp')).toEqual(['Bash(cd *)']);
  });

  it('does not strip non-executing forms', async () => {
    // `command -v ls` looks ls up instead of running it.
    expect(await rulesOf('command -v ls')).toEqual(['Bash(command *)']);
    // Unknown sudo flags refuse the strip (safe direction).
    expect(await rulesOf('sudo --preserve-env=FOO rm x')).toEqual(['Bash(rm *)']);
    expect(await rulesOf('sudo -X rm x')).toEqual(['Bash(sudo *)']);
  });

  it('restores pre-P2 rule shapes with stripWrappers: false', async () => {
    expect(await rulesOf('sudo git push origin main', false)).toEqual(['Bash(sudo *)']);
    expect(await rulesOf('timeout 10 ls', false)).toEqual(['Bash(timeout *)']);
  });

  it('never strips the degraded whole-string form', async () => {
    wasmMock.fail = true;
    resetBashParserForTests();
    const command = 'sudo git push --degraded-wrapper-marker';
    const analysis = await analyzeBashCommand(command);
    expect(analysis.degraded).toBe(true);
    expect(analysis.approvalRules).toEqual([literalRulePattern('Bash', command)]);
  });
});

describe('stripWrapperTokens', () => {
  it('peels wrapper chains down to the command', () => {
    expect(stripWrapperTokens(['sudo', 'git', 'push'])).toEqual({
      tokens: ['git', 'push'],
      stripped: true,
    });
    expect(stripWrapperTokens(['env', 'FOO=bar', 'sudo', 'rm', 'x'])).toEqual({
      tokens: ['rm', 'x'],
      stripped: true,
    });
  });

  it('stops at VAR=val tokens after a wrapper (they are the command)', () => {
    expect(stripWrapperTokens(['sudo', 'FOO=bar', 'rm', 'x'])).toEqual({
      tokens: ['FOO=bar', 'rm', 'x'],
      stripped: true,
    });
  });

  it('refuses the whole strip on unsafe flag values or bare wrappers', () => {
    const unsafe = ['timeout', '-k$(id)', '10', 'ls'];
    expect(stripWrapperTokens(unsafe)).toEqual({ tokens: unsafe, stripped: false });
    const bare = ['sudo'];
    expect(stripWrapperTokens(bare)).toEqual({ tokens: bare, stripped: false });
  });
});

describe('stripWrapperPrefixes', () => {
  it('strips every leading assignment for deny, only safe-listed ones for allow', () => {
    expect(stripWrapperPrefixes('FOO=bar sudo rm x', 'deny')).toEqual({
      command: 'rm x',
      stripped: true,
    });
    expect(stripWrapperPrefixes('FOO=bar sudo rm x', 'allow')).toEqual({
      command: 'FOO=bar sudo rm x',
      stripped: false,
    });
    expect(stripWrapperPrefixes('TZ=UTC sudo rm x', 'allow')).toEqual({
      command: 'rm x',
      stripped: true,
    });
  });

  it('never strips binary-hijack variables for allow', () => {
    for (const subject of [
      'DOCKER_HOST=evil docker ps',
      'PATH=/evil ls',
      'LD_PRELOAD=/evil.so ls',
      'DYLD_INSERT_LIBRARIES=/evil.dylib ls',
    ]) {
      expect(stripWrapperPrefixes(subject, 'allow').command).toBe(subject);
    }
    // Deny strips them all — deny rules must be hard to circumvent.
    expect(stripWrapperPrefixes('PATH=/evil ls', 'deny').command).toBe('ls');
    expect(stripWrapperPrefixes('DOCKER_HOST=evil docker ps', 'deny').command).toBe('docker ps');
  });

  it('keeps VAR=val after a wrapper as command text (HackerOne #3543050)', () => {
    expect(stripWrapperPrefixes('sudo FOO=bar rm x', 'deny')).toEqual({
      command: 'FOO=bar rm x',
      stripped: true,
    });
    expect(stripWrapperPrefixes('sudo FOO=bar rm x', 'allow')).toEqual({
      command: 'FOO=bar rm x',
      stripped: true,
    });
  });

  it('refuses timeout with an unsafe flag value', () => {
    const command = 'timeout -k$(id) 10 ls';
    expect(stripWrapperPrefixes(command, 'deny')).toEqual({ command, stripped: false });
    expect(stripWrapperPrefixes('timeout 10 ls', 'deny')).toEqual({
      command: 'ls',
      stripped: true,
    });
  });

  it('does not strip across newlines', () => {
    const command = 'sudo\nrm x';
    expect(stripWrapperPrefixes(command, 'deny')).toEqual({ command, stripped: false });
  });
});
