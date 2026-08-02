import { describe, expect, it } from 'vitest';

import {
  agentTaskInfoSchema,
  taskInfoSchema,
  type AgentTaskInfo,
} from '../events';

const base = {
  taskId: 'agent-abcdef12',
  description: 'Ingestion owner',
  status: 'running' as const,
  startedAt: 1_800_000_000_000,
  endedAt: null,
};

describe('agentTaskInfoSchema', () => {
  it('round-trips a plain agent task', () => {
    const info: AgentTaskInfo = { ...base, kind: 'agent', agentId: 'agent-1', subagentType: 'coder' };
    expect(agentTaskInfoSchema.parse(info)).toEqual(info);
  });

  it('round-trips a teammate-carrying agent task', () => {
    const info: AgentTaskInfo = {
      ...base,
      kind: 'agent',
      agentId: 'agent-1',
      subagentType: 'coder',
      teammate: { name: 'researcher', teamName: 'core' },
    };
    expect(agentTaskInfoSchema.parse(info)).toEqual(info);
  });

  it('round-trips a teammate without a team', () => {
    const info: AgentTaskInfo = {
      ...base,
      kind: 'agent',
      teammate: { name: 'researcher' },
    };
    expect(agentTaskInfoSchema.parse(info)).toEqual(info);
  });

  it('rejects a malformed teammate entry', () => {
    const bad = { ...base, kind: 'agent', teammate: { teamName: 'core' } };
    expect(agentTaskInfoSchema.safeParse(bad).success).toBe(false);
  });
});

describe('taskInfoSchema union', () => {
  it('keeps teammate metadata through union discrimination', () => {
    const info = {
      ...base,
      kind: 'agent',
      agentId: 'agent-1',
      teammate: { name: 'researcher', teamName: 'core' },
    };
    expect(taskInfoSchema.parse(info)).toEqual(info);
  });

  it('still discriminates process tasks', () => {
    const info = { ...base, kind: 'process', command: 'ls', pid: 1, exitCode: null };
    expect(taskInfoSchema.parse(info)).toEqual(info);
  });
});
