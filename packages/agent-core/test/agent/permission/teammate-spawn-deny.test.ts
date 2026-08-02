import type { ToolCall } from '@cloud-code/kosong';
import { describe, expect, it } from 'vitest';

import type { PermissionPolicyContext } from '../../../src/agent/permission';
import { TeammateSpawnDenyPermissionPolicy } from '../../../src/agent/permission/policies/teammate-spawn-deny';
import { ToolAccesses } from '../../../src/loop';

const signal = new AbortController().signal;

function fakeAgent(isTeammate: boolean) {
  return { isTeammate } as never;
}

function policyContext(toolName: string, args: Record<string, unknown> = {}): PermissionPolicyContext {
  return {
    turnId: '0',
    stepNumber: 1,
    signal,
    llm: {},
    args,
    toolCall: {
      type: 'function',
      id: `call_${toolName}`,
      name: toolName,
      arguments: JSON.stringify(args),
    } satisfies ToolCall,
    execution: {
      accesses: ToolAccesses.none(),
      approvalRule: toolName,
      execute: async () => ({ output: '' }),
    },
  } as unknown as PermissionPolicyContext;
}

describe('TeammateSpawnDenyPermissionPolicy', () => {
  it('denies a nested teammate spawn (Agent with name) for a teammate', () => {
    const policy = new TeammateSpawnDenyPermissionPolicy(fakeAgent(true));
    const result = policy.evaluate(
      policyContext('Agent', { prompt: 'p', description: 'd', name: 'helper' }),
    );
    expect(result?.kind).toBe('deny');
    if (result?.kind !== 'deny') throw new Error('expected deny');
    expect(result.message).toContain('cannot spawn other teammates');
    expect(result.reason).toEqual({ teammate_nested_spawn: true });
  });

  it('denies a background agent launch (Agent with run_in_background) for a teammate', () => {
    const policy = new TeammateSpawnDenyPermissionPolicy(fakeAgent(true));
    const result = policy.evaluate(
      policyContext('Agent', { prompt: 'p', description: 'd', run_in_background: true }),
    );
    expect(result?.kind).toBe('deny');
    if (result?.kind !== 'deny') throw new Error('expected deny');
    expect(result.message).toContain('cannot launch background agents');
    expect(result.reason).toEqual({ teammate_background_agent: true });
  });

  it('denies a background resume for a teammate', () => {
    const policy = new TeammateSpawnDenyPermissionPolicy(fakeAgent(true));
    const result = policy.evaluate(
      policyContext('Agent', { prompt: 'p', description: 'd', resume: 'agent-9', run_in_background: true }),
    );
    expect(result?.kind).toBe('deny');
  });

  it('reads the args from the wire arguments when the parsed args are absent', () => {
    const policy = new TeammateSpawnDenyPermissionPolicy(fakeAgent(true));
    const context = policyContext('Agent', { name: 'helper' });
    expect(policy.evaluate({ ...context, args: undefined })?.kind).toBe('deny');
  });

  it('allows a plain foreground subagent spawn for a teammate', () => {
    const policy = new TeammateSpawnDenyPermissionPolicy(fakeAgent(true));
    expect(
      policy.evaluate(policyContext('Agent', { prompt: 'p', description: 'd' })),
    ).toBeUndefined();
  });

  it('allows AgentSwarm and every other tool for a teammate', () => {
    const policy = new TeammateSpawnDenyPermissionPolicy(fakeAgent(true));
    for (const toolName of ['AgentSwarm', 'Read', 'Write', 'Edit', 'Bash', 'TaskList', 'TaskOutput', 'TaskStop']) {
      expect(policy.evaluate(policyContext(toolName, { run_in_background: true, name: 'x' }))).toBeUndefined();
    }
  });

  it('allows everything for a non-teammate agent', () => {
    const policy = new TeammateSpawnDenyPermissionPolicy(fakeAgent(false));
    expect(
      policy.evaluate(policyContext('Agent', { name: 'helper', run_in_background: true })),
    ).toBeUndefined();
    expect(policy.evaluate(policyContext('AgentSwarm'))).toBeUndefined();
  });

  it('ignores blank teammate names (they never reach the teammate path)', () => {
    const policy = new TeammateSpawnDenyPermissionPolicy(fakeAgent(true));
    expect(
      policy.evaluate(policyContext('Agent', { prompt: 'p', description: 'd', name: '   ' })),
    ).toBeUndefined();
  });
});
