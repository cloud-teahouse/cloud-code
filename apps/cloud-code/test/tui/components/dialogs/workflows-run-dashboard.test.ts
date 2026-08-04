import type { Terminal } from '@cloud-code/pi-tui';
import { describe, expect, it, vi } from 'vitest';

import { WorkflowsBrowserApp } from '#/tui/components/dialogs/workflows-browser';
import { WorkflowsAgentDetail } from '#/tui/components/dialogs/workflows-agent-detail';
import {
  buildWorkflowsRosterRows,
  WorkflowsRoster,
} from '#/tui/components/dialogs/workflows-roster';
import type { WorkflowAgentNode } from '#/tui/controllers/workflows-tracker';
import { setLocalePreference } from '#/tui/i18n';

const terminal = { rows: 20 } as unknown as Terminal;
const now = new Date('2026-06-15T12:00:00Z').getTime();
const strip = (text: string): string => text.replaceAll(/\x1b\[[0-9;]*m/g, '');

function agent(overrides: Partial<WorkflowAgentNode> = {}): WorkflowAgentNode {
  return {
    agentId: 'agent-1',
    name: 'agent-1',
    parentAgentId: undefined,
    parentToolCallId: undefined,
    swarmIndex: undefined,
    runInBackground: true,
    description: undefined,
    status: 'running',
    statusDetail: undefined,
    lastEventAt: now,
    currentActivity: { kind: 'tool', label: 'Reading files', toolName: 'Read' },
    model: 'kimi-k2',
    step: 2,
    startedAt: now - 65_000,
    endedAt: undefined,
    usage: undefined,
    contextTokens: 4_000,
    lastOutput: 'working',
    progress: { done: 2, total: 5 },
    taskId: 'task-1',
    teamName: 'core',
    taskSubject: 'Inspect the repository',
    thinkingText: 'secret chain text',
    thinkingTruncated: false,
    tools: [],
    toolCallCount: 1,
    activity: [{ kind: 'thinking', text: 'secret chain text' }],
    activityTruncated: false,
    resultSummary: undefined,
    revision: 1,
    ...overrides,
  };
}

describe('workflows run dashboard', () => {
  it('renders empty, running/waiting, and completed/error states', () => {
    setLocalePreference('en');
    const empty = new WorkflowsBrowserApp(
      { agents: [], selectedAgentId: undefined, onSelect: vi.fn(), onCancel: vi.fn() },
      terminal,
    );
    const emptyText = strip(empty.render(90).join('\n'));
    expect(emptyText).toContain('No workflows are running yet');
    expect(emptyText).toContain('Start an Agent or AgentSwarm');
    expect(emptyText).toContain('task to see it here');

    const running = agent();
    const waiting = agent({
      agentId: 'agent-waiting',
      name: 'agent-waiting',
      currentActivity: { kind: 'waiting-approval', label: 'Approve deployment' },
      status: 'waiting',
      taskId: 'task-waiting',
      lastOutput: 'waiting for approval',
    });
    const runningText = strip(
      new WorkflowsBrowserApp(
        {
          agents: [running, waiting],
          selectedAgentId: 'agent-waiting',
          onSelect: vi.fn(),
          onCancel: vi.fn(),
        },
        terminal,
      ).render(110).join('\n'),
    );
    expect(runningText).toContain('core · alive 2 · waiting 1 · attention 1 · done 0');
    expect(runningText.indexOf('@agent-waiting')).toBeLessThan(runningText.indexOf('@agent-1'));
    expect(runningText).toContain('Approve deployment');

    const completed = agent({
      status: 'done',
      endedAt: now - 1_000,
      currentActivity: { kind: 'idle', label: 'Idle' },
      resultSummary: 'completed successfully',
      taskId: undefined,
    });
    const completedText = strip(
      new WorkflowsBrowserApp(
        { agents: [completed], selectedAgentId: 'agent-1', onSelect: vi.fn(), onCancel: vi.fn() },
        terminal,
      ).render(100).join('\n'),
    );
    expect(completedText).toContain('done 1');
    expect(completedText).toContain('completed successfully');

    const failed = agent({
      status: 'failed',
      endedAt: now - 1_000,
      statusDetail: 'build failed',
      currentActivity: { kind: 'idle', label: 'Idle' },
    });
    const detail = new WorkflowsAgentDetail({ agent: failed as never, thinkingExpanded: false });
    expect(strip(detail.render(80, 20).join('\n'))).toContain('build failed');
  });

  it('confirms stop and dispatches output/foreground actions with Alt and bare aliases', () => {
    const stop = vi.fn();
    const output = vi.fn();
    const foreground = vi.fn();
    const app = new WorkflowsBrowserApp(
      {
        agents: [agent()],
        selectedAgentId: 'agent-1',
        onSelect: vi.fn(),
        onCancel: vi.fn(),
        onStopConfirmed: stop,
        onOpenOutput: output,
        onForeground: foreground,
      },
      terminal,
    );
    app.render(90);

    app.handleInput('\u001bx');
    expect(stop).not.toHaveBeenCalled();
    app.handleInput('n');
    app.handleInput('x');
    app.handleInput('y');
    expect(stop).toHaveBeenCalledWith('task-1');

    app.handleInput('\u001bo');
    expect(output).toHaveBeenCalledWith('task-1');
    app.handleInput('f');
    expect(foreground).toHaveBeenCalledWith('task-1');
  });

  it('does not advertise foreground without a bridge', () => {
    const ignored = vi.fn();
    const app = new WorkflowsBrowserApp(
      {
        agents: [agent()],
        selectedAgentId: 'agent-1',
        onSelect: vi.fn(),
        onCancel: vi.fn(),
        onActionIgnored: ignored,
      },
      terminal,
    );
    expect(strip(app.render(90).join('\n'))).not.toContain('Alt+F');
    app.handleInput('f');
    expect(ignored).toHaveBeenCalledWith('foreground', 'agent-1');
  });

  it('keeps thinking collapsed until t and folds completed roster rows by default', () => {
    const running = agent();
    const done = agent({ agentId: 'done', name: 'done', status: 'done', endedAt: now - 1_000 });
    const rows = buildWorkflowsRosterRows([running, done], new Set(), new Set(['core']));
    expect(rows.some((row) => row.kind === 'done-group' && row.collapsed)).toBe(true);
    expect(rows.filter((row) => row.kind === 'agent').some((row) => row.agent.agentId === 'done')).toBe(false);

    const roster = new WorkflowsRoster({
      agents: [running, done],
      selectedAgentId: 'agent-1',
      collapsedTeams: new Set(),
      collapsedDoneTeams: new Set(['core']),
    });
    expect(strip(roster.render(80, 10).join('\n'))).toContain('done (1)');

    const app = new WorkflowsBrowserApp(
      { agents: [running], selectedAgentId: 'agent-1', onSelect: vi.fn(), onCancel: vi.fn() },
      terminal,
    );
    const collapsed = strip(app.render(100).join('\n'));
    expect(collapsed).not.toContain('secret chain text');
    app.handleInput('t');
    expect(strip(app.render(100).join('\n'))).toContain('secret chain text');
  });
});
