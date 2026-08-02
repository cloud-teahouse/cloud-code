import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ToolCall } from '@cloud-code/kosong';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readConfigFile } from '#/config';
import type { Agent } from '../../../src/agent';
import {
  PermissionManager,
  type ApprovalResponse,
  type PermissionPolicyContext,
  type PermissionRule,
} from '../../../src/agent/permission';
import { persistAllowRulesToUserConfig } from '../../../src/agent/permission/persist-always-rules';
import { ToolAccesses } from '../../../src/loop';
import {
  literalRulePattern,
  matchesGlobRuleSubject,
} from '../../../src/tools/support/rule-match';
import { createFakeKaos } from '../../tools/fixtures/fake-kaos';

let workDirs: string[] = [];

beforeEach(() => {
  workDirs = [];
});

afterEach(async () => {
  await Promise.all(workDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cloud-code-always-approval-'));
  workDirs.push(dir);
  return dir;
}

interface ManagerHarness {
  readonly manager: PermissionManager;
  readonly requestApproval: ReturnType<typeof vi.fn>;
  readonly emitEvent: ReturnType<typeof vi.fn>;
}

function makeManager(input: {
  readonly homeDir: string | undefined;
  readonly approval: ApprovalResponse;
  readonly initialRules?: readonly PermissionRule[];
  readonly parent?: PermissionManager;
}): ManagerHarness {
  const requestApproval = vi.fn(async () => input.approval);
  const emitEvent = vi.fn();
  const agent = {
    type: 'main',
    config: { cwd: '/workspace' },
    brandHomeDir: input.homeDir,
    kaos: createFakeKaos(),
    getAdditionalDirs: () => [],
    emitStatusUpdated: vi.fn(),
    records: { logRecord: vi.fn() },
    replayBuilder: { push: vi.fn() },
    rpc: { requestApproval, emitEvent },
    log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
    planMode: { isActive: false, planFilePath: null },
    swarmMode: { isActive: false },
  } as unknown as Agent;
  const manager = new PermissionManager(agent, {
    initialRules: input.initialRules,
    parent: input.parent,
  });
  Object.assign(agent, { permission: manager });
  return { manager, requestApproval, emitEvent };
}

function bashHookContext(id: string, command: string): PermissionPolicyContext {
  const args = { command, timeout: 60 };
  const toolCall: ToolCall = {
    type: 'function',
    id,
    name: 'Bash',
    arguments: JSON.stringify(args),
  };
  return {
    turnId: '0',
    stepNumber: 1,
    signal: new AbortController().signal,
    llm: {} as PermissionPolicyContext['llm'],
    toolCall,
    toolCalls: [toolCall],
    args,
    execution: {
      description: `Running: ${command}`,
      display: { kind: 'command', command, language: 'bash' },
      accesses: ToolAccesses.all(),
      approvalRule: literalRulePattern('Bash', command),
      matchesRule: (ruleArgs: string) => matchesGlobRuleSubject(ruleArgs, command),
      execute: async () => ({ output: '' }),
    },
  };
}

function compoundHookContext(
  id: string,
  subjects: readonly string[],
  approvalRules: readonly string[],
): PermissionPolicyContext {
  const command = subjects.join(' && ');
  const args = { command, timeout: 60 };
  const toolCall: ToolCall = {
    type: 'function',
    id,
    name: 'Bash',
    arguments: JSON.stringify(args),
  };
  return {
    turnId: '0',
    stepNumber: 1,
    signal: new AbortController().signal,
    llm: {} as PermissionPolicyContext['llm'],
    toolCall,
    toolCalls: [toolCall],
    args,
    execution: {
      description: `Running: ${command}`,
      display: { kind: 'command', command, language: 'bash' },
      accesses: ToolAccesses.all(),
      approvalRule: literalRulePattern('Bash', command),
      approvalRules,
      ruleMatch: {
        subjects,
        matches: (ruleArgs: string, subject: string) =>
          matchesGlobRuleSubject(ruleArgs, subject),
      },
      execute: async () => ({ output: '' }),
    },
  };
}

function configRules(homeDir: string): PermissionRule[] {
  return readConfigFile(join(homeDir, 'config.toml')).permission?.rules ?? [];
}

describe('approve always (rule persistence)', () => {
  it('writes the approved rule to the user config and applies it immediately', async () => {
    const home = await makeHome();
    const { manager, requestApproval } = makeManager({
      homeDir: home,
      approval: { decision: 'approved', scope: 'always' },
    });

    await expect(manager.beforeToolCall(bashHookContext('call_1', 'printf hi'))).resolves.toBeUndefined();
    expect(requestApproval).toHaveBeenCalledTimes(1);

    // Round-trip: the rule survives on disk as a scope-user allow rule.
    expect(configRules(home)).toEqual([
      {
        decision: 'allow',
        scope: 'user',
        pattern: 'Bash(printf hi)',
        reason: 'approve always',
      },
    ]);
    // Adopted in-memory for the current session too.
    expect(manager.data().rules).toEqual([
      {
        decision: 'allow',
        scope: 'user',
        pattern: 'Bash(printf hi)',
        reason: 'approve always',
      },
    ]);
    // Session-scope memory stays empty — this is a user-configured rule now.
    expect(manager.sessionApprovalRulePatterns).toEqual([]);

    // Later identical calls are approved by user-configured-allow, no RPC.
    await expect(manager.beforeToolCall(bashHookContext('call_2', 'printf hi'))).resolves.toBeUndefined();
    expect(requestApproval).toHaveBeenCalledTimes(1);

    // Permanence: a fresh manager booted from the written config approves
    // without ever asking.
    const revived = makeManager({
      homeDir: home,
      approval: { decision: 'rejected' },
      initialRules: configRules(home),
    });
    await expect(
      revived.manager.beforeToolCall(bashHookContext('call_3', 'printf hi')),
    ).resolves.toBeUndefined();
    expect(revived.requestApproval).not.toHaveBeenCalled();
  });

  it('preserves unrelated config content across the write-back (round-trip)', async () => {
    const home = await makeHome();
    await writeFile(
      join(home, 'config.toml'),
      [
        'default_model = "kimi-for-coding"',
        '',
        '[permission]',
        'rules = [',
        '  { decision = "deny", pattern = "Bash(rm *)" },',
        ']',
        '',
      ].join('\n'),
      'utf-8',
    );
    const { manager } = makeManager({
      homeDir: home,
      approval: { decision: 'approved', scope: 'always' },
    });

    await expect(manager.beforeToolCall(bashHookContext('call_1', 'printf hi'))).resolves.toBeUndefined();

    const text = await readFile(join(home, 'config.toml'), 'utf-8');
    expect(text).toContain('default_model = "kimi-for-coding"');
    expect(configRules(home)).toEqual([
      { decision: 'deny', scope: 'user', pattern: 'Bash(rm *)' },
      {
        decision: 'allow',
        scope: 'user',
        pattern: 'Bash(printf hi)',
        reason: 'approve always',
      },
    ]);
  });

  it('persists per-segment rules for decomposable compound approvals', async () => {
    const home = await makeHome();
    const { manager } = makeManager({
      homeDir: home,
      approval: { decision: 'approved', scope: 'always' },
    });
    const segmentRules = ['Bash(git add *)', 'Bash(git push *)'];

    await expect(
      manager.beforeToolCall(compoundHookContext('call_1', ['git add .', 'git push'], segmentRules)),
    ).resolves.toBeUndefined();

    // One rule per segment — never the whole compound command.
    expect(configRules(home).map((rule) => rule.pattern)).toEqual(segmentRules);

    // A later compound call whose segments are all covered needs no prompt:
    // the union of persisted allow rules covers every subject.
    const { manager: second, requestApproval } = (() => {
      const harness = makeManager({
        homeDir: home,
        approval: { decision: 'rejected' },
        initialRules: configRules(home),
      });
      return { manager: harness.manager, requestApproval: harness.requestApproval };
    })();
    await expect(
      second.beforeToolCall(
        compoundHookContext('call_2', ['git add -A', 'git push origin main'], segmentRules),
      ),
    ).resolves.toBeUndefined();
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it('does not duplicate a rule that is already configured', async () => {
    const home = await makeHome();
    const { manager } = makeManager({
      homeDir: home,
      approval: { decision: 'approved', scope: 'always' },
    });

    await expect(manager.beforeToolCall(bashHookContext('call_1', 'printf hi'))).resolves.toBeUndefined();
    await expect(manager.beforeToolCall(bashHookContext('call_2', 'printf hi'))).resolves.toBeUndefined();

    expect(configRules(home)).toHaveLength(1);
    expect(manager.data().rules).toHaveLength(1);
  });

  it('degrades to session scope with a warning when the config cannot be written', async () => {
    const home = await makeHome();
    const invalid = '[permission]\nrules = [{ decision = "maybe", pattern = "Bash" }]\n';
    await writeFile(join(home, 'config.toml'), invalid, 'utf-8');
    const { manager, requestApproval, emitEvent } = makeManager({
      homeDir: home,
      approval: { decision: 'approved', scope: 'always' },
    });

    await expect(manager.beforeToolCall(bashHookContext('call_1', 'printf hi'))).resolves.toBeUndefined();

    // Session-scope fallback: the grant is honored for the rest of the session.
    expect(manager.sessionApprovalRulePatterns).toEqual(['Bash(printf hi)']);
    await expect(manager.beforeToolCall(bashHookContext('call_2', 'printf hi'))).resolves.toBeUndefined();
    expect(requestApproval).toHaveBeenCalledTimes(1);

    // The user is told the rule was not saved.
    expect(emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'warning',
        code: 'permission-always-persist-failed',
      }),
    );
    // Atomicity: the invalid config is left untouched (no partial write).
    expect(await readFile(join(home, 'config.toml'), 'utf-8')).toBe(invalid);
  });

  it('degrades to session scope when no user config path is available', async () => {
    const { manager, emitEvent } = makeManager({
      homeDir: undefined,
      approval: { decision: 'approved', scope: 'always' },
    });

    await expect(manager.beforeToolCall(bashHookContext('call_1', 'printf hi'))).resolves.toBeUndefined();

    expect(manager.sessionApprovalRulePatterns).toEqual(['Bash(printf hi)']);
    expect(manager.data().rules).toEqual([]);
    expect(emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'warning', code: 'permission-always-persist-failed' }),
    );
  });

  it('keeps user-configured deny rules ahead of a persisted always-allow', async () => {
    const home = await makeHome();
    const { manager, requestApproval } = makeManager({
      homeDir: home,
      approval: { decision: 'approved', scope: 'always' },
    });

    await expect(manager.beforeToolCall(bashHookContext('call_1', 'git status'))).resolves.toBeUndefined();
    expect(configRules(home)).toHaveLength(1);

    // A deny rule added later (config reload, admin policy) still wins.
    manager.rules.push({ decision: 'deny', scope: 'user', pattern: 'Bash(git status)' });
    const blocked = await manager.beforeToolCall(bashHookContext('call_2', 'git status'));
    expect(blocked?.block).toBe(true);
    expect(requestApproval).toHaveBeenCalledTimes(1);
  });

  it('mixes session and always grants when covering compound segments', async () => {
    const home = await makeHome();
    const { manager, requestApproval } = makeManager({
      homeDir: home,
      approval: { decision: 'approved', scope: 'always' },
    });

    // Session-scope grant for one segment.
    manager.recordApprovalResult({
      turnId: 0,
      toolCallId: 'call_session',
      toolName: 'Bash',
      action: 'run command',
      sessionApprovalRule: 'Bash(git add *)',
      result: { decision: 'approved', scope: 'session' },
    });
    // Always-scope grant for the other segment.
    await expect(manager.beforeToolCall(bashHookContext('call_1', 'git push'))).resolves.toBeUndefined();
    expect(configRules(home).map((rule) => rule.pattern)).toEqual(['Bash(git push)']);

    // The union of session + persisted allow rules covers the compound call.
    await expect(
      manager.beforeToolCall(
        compoundHookContext('call_2', ['git add .', 'git push'], ['Bash(git add *)', 'Bash(git push)']),
      ),
    ).resolves.toBeUndefined();
    expect(requestApproval).toHaveBeenCalledTimes(1);
  });

  it('adopts persisted rules at the root manager so sub-agents inherit them', async () => {
    const home = await makeHome();
    const root = makeManager({ homeDir: home, approval: { decision: 'rejected' } });
    const child = makeManager({
      homeDir: home,
      approval: { decision: 'approved', scope: 'always' },
      parent: root.manager,
    });

    await expect(child.manager.beforeToolCall(bashHookContext('call_1', 'printf hi'))).resolves.toBeUndefined();

    expect(root.manager.data().rules.map((rule) => rule.pattern)).toEqual(['Bash(printf hi)']);
    expect(child.manager.rules).toEqual([]);

    // A sibling sub-agent created later inherits via the parent chain.
    const sibling = makeManager({
      homeDir: home,
      approval: { decision: 'rejected' },
      parent: root.manager,
    });
    await expect(
      sibling.manager.beforeToolCall(bashHookContext('call_2', 'printf hi')),
    ).resolves.toBeUndefined();
    expect(sibling.requestApproval).not.toHaveBeenCalled();
  });
});

describe('persistAllowRulesToUserConfig', () => {
  it('reports already-present rules without rewriting the file', async () => {
    const home = await makeHome();
    const configPath = join(home, 'config.toml');

    const first = await persistAllowRulesToUserConfig({ configPath, patterns: ['Bash(ls)'] });
    expect(first).toEqual({ added: ['Bash(ls)'], alreadyPresent: [] });
    const afterFirst = await readFile(configPath, 'utf-8');

    const second = await persistAllowRulesToUserConfig({
      configPath,
      patterns: ['Bash(ls)', 'Bash(pwd)'],
    });
    expect(second).toEqual({ added: ['Bash(pwd)'], alreadyPresent: ['Bash(ls)'] });
    const afterSecond = await readFile(configPath, 'utf-8');
    expect(afterSecond).not.toBe(afterFirst);
    expect(configRules(home).map((rule) => rule.pattern)).toEqual(['Bash(ls)', 'Bash(pwd)']);
  });

  it('is a no-op for an empty pattern list', async () => {
    const home = await makeHome();
    const result = await persistAllowRulesToUserConfig({
      configPath: join(home, 'config.toml'),
      patterns: [],
    });
    expect(result).toEqual({ added: [], alreadyPresent: [] });
  });
});
