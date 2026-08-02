import { describe, expect, it, vi } from 'vitest';

import { HookEngine } from '../../src/session/hooks';
import { matchesGlobRuleSubject } from '../../src/tools/support/rule-match';

const NODE_MARKER_HOOK =
  'node -e "let s=\\"\\";process.stdin.on(\\"data\\",d=>s+=d);process.stdin.on(\\"end\\",()=>{process.stdout.write(\\"fired\\")})"';

function bashIfContext(command: string) {
  return {
    toolName: 'Bash',
    execution: {
      matchesRule: (ruleArgs: string) => matchesGlobRuleSubject(ruleArgs, command),
    },
  } as const;
}

describe('HookEngine `if` conditions', () => {
  it('fires the hook when the if condition matches the tool input', async () => {
    const engine = new HookEngine([
      { event: 'PreToolUse', command: NODE_MARKER_HOOK, if: 'Bash(git *)', timeout: 5 },
    ]);
    const results = await engine.trigger('PreToolUse', {
      matcherValue: 'Bash',
      inputData: { toolName: 'Bash', toolInput: { command: 'git status' } },
      ifContext: bashIfContext('git status'),
    });
    expect(results).toHaveLength(1);
    expect(results[0]?.stdout).toContain('fired');
  });

  it('skips the hook without spawning a process when the if condition does not match', async () => {
    const onTriggered = vi.fn();
    const engine = new HookEngine(
      [{ event: 'PreToolUse', command: NODE_MARKER_HOOK, if: 'Bash(git *)', timeout: 5 }],
      { onTriggered },
    );
    const results = await engine.trigger('PreToolUse', {
      matcherValue: 'Bash',
      inputData: { toolName: 'Bash', toolInput: { command: 'rm -rf /' } },
      ifContext: bashIfContext('rm -rf /'),
    });
    expect(results).toHaveLength(0);
    // onTriggered fires only after matching — zero matched hooks means no spawn happened.
    expect(onTriggered).not.toHaveBeenCalled();
  });

  it('matches a tool-name-only if condition without an arg pattern', async () => {
    const engine = new HookEngine([
      { event: 'PreToolUse', command: NODE_MARKER_HOOK, if: 'Bash', timeout: 5 },
    ]);
    const matched = await engine.trigger('PreToolUse', {
      matcherValue: 'Bash',
      inputData: {},
      ifContext: bashIfContext('anything'),
    });
    expect(matched).toHaveLength(1);

    const otherTool = await engine.trigger('PreToolUse', {
      matcherValue: 'Write',
      inputData: {},
      ifContext: { toolName: 'Write' },
    });
    expect(otherTool).toHaveLength(0);
  });

  it('skips an arg-pattern condition when no rule matcher is available', async () => {
    const engine = new HookEngine([
      { event: 'PreToolUse', command: NODE_MARKER_HOOK, if: 'Bash(git *)', timeout: 5 },
    ]);
    const results = await engine.trigger('PreToolUse', {
      matcherValue: 'Bash',
      inputData: { toolName: 'Bash', toolInput: { command: 'git status' } },
      ifContext: { toolName: 'Bash' },
    });
    expect(results).toHaveLength(0);
  });

  it('skips hooks with if conditions on non-tool events (no ifContext)', async () => {
    const engine = new HookEngine([
      { event: 'Stop', command: NODE_MARKER_HOOK, if: 'Bash(git *)', timeout: 5 },
    ]);
    const results = await engine.trigger('Stop', { inputData: {} });
    expect(results).toHaveLength(0);
  });

  it('skips a malformed if condition instead of failing the trigger', async () => {
    const engine = new HookEngine([
      { event: 'PreToolUse', command: NODE_MARKER_HOOK, if: 'Bash(git *', timeout: 5 },
    ]);
    const results = await engine.trigger('PreToolUse', {
      matcherValue: 'Bash',
      inputData: {},
      ifContext: bashIfContext('git status'),
    });
    expect(results).toHaveLength(0);
  });

  it('fires when any segment subject matches via ruleMatch (existential)', async () => {
    const engine = new HookEngine([
      { event: 'PreToolUse', command: NODE_MARKER_HOOK, if: 'Bash(git *)', timeout: 5 },
    ]);
    const results = await engine.trigger('PreToolUse', {
      matcherValue: 'Bash',
      inputData: { toolName: 'Bash', toolInput: { command: 'ls && git status' } },
      ifContext: {
        toolName: 'Bash',
        execution: {
          ruleMatch: {
            subjects: ['ls', 'git status'],
            matches: (ruleArgs: string, subject: string) =>
              matchesGlobRuleSubject(ruleArgs, subject),
          },
        },
      },
    });
    expect(results).toHaveLength(1);
  });

  it('supports negated patterns through the shared rule syntax', async () => {
    const engine = new HookEngine([
      { event: 'PreToolUse', command: NODE_MARKER_HOOK, if: 'Bash(!git *)', timeout: 5 },
    ]);
    const nonGit = await engine.trigger('PreToolUse', {
      matcherValue: 'Bash',
      inputData: {},
      ifContext: bashIfContext('ls -la'),
    });
    expect(nonGit).toHaveLength(1);

    const git = await engine.trigger('PreToolUse', {
      matcherValue: 'Bash',
      inputData: {},
      ifContext: bashIfContext('git status'),
    });
    expect(git).toHaveLength(0);
  });
});
