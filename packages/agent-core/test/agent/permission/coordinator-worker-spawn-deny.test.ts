import type { ToolCall } from '@cloud-code/kosong';
import { describe, expect, it } from 'vitest';

import type { PermissionPolicyContext } from '../../../src/agent/permission';
import { CoordinatorWorkerSpawnDenyPermissionPolicy } from '../../../src/agent/permission/policies/coordinator-worker-spawn-deny';
import { ToolAccesses } from '../../../src/loop';

const signal = new AbortController().signal;

function fakeAgent(isCoordinatorWorker: boolean) {
  return { isCoordinatorWorker } as never;
}

function policyContext(toolName: string): PermissionPolicyContext {
  return {
    turnId: '0',
    stepNumber: 1,
    signal,
    llm: {},
    args: {},
    toolCall: {
      type: 'function',
      id: `call_${toolName}`,
      name: toolName,
      arguments: '{}',
    } satisfies ToolCall,
    execution: {
      accesses: ToolAccesses.none(),
      approvalRule: toolName,
      execute: async () => ({ output: '' }),
    },
  } as unknown as PermissionPolicyContext;
}

describe('CoordinatorWorkerSpawnDenyPermissionPolicy', () => {
  it('denies Agent for a coordinator worker', () => {
    const policy = new CoordinatorWorkerSpawnDenyPermissionPolicy(fakeAgent(true));
    const result = policy.evaluate(policyContext('Agent'));
    expect(result?.kind).toBe('deny');
    if (result?.kind !== 'deny') throw new Error('expected deny');
    expect(result.message).toContain('cannot spawn other workers');
  });

  it('denies AgentSwarm for a coordinator worker', () => {
    const policy = new CoordinatorWorkerSpawnDenyPermissionPolicy(fakeAgent(true));
    expect(policy.evaluate(policyContext('AgentSwarm'))?.kind).toBe('deny');
  });

  it('allows every other tool for a coordinator worker', () => {
    const policy = new CoordinatorWorkerSpawnDenyPermissionPolicy(fakeAgent(true));
    for (const toolName of ['Read', 'Write', 'Edit', 'Bash', 'TaskList', 'TaskOutput', 'TaskStop']) {
      expect(policy.evaluate(policyContext(toolName))).toBeUndefined();
    }
  });

  it('allows Agent and AgentSwarm for a plain subagent (not a coordinator worker)', () => {
    const policy = new CoordinatorWorkerSpawnDenyPermissionPolicy(fakeAgent(false));
    expect(policy.evaluate(policyContext('Agent'))).toBeUndefined();
    expect(policy.evaluate(policyContext('AgentSwarm'))).toBeUndefined();
  });
});
