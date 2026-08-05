import type { Terminal } from '@cloud-code/pi-tui';
import { describe, expect, it, vi } from 'vitest';

import { WorkflowsBrowserApp } from '#/tui/components/dialogs/workflows-browser';
import { renderAgentStatusBars, WorkflowsAgentDetail } from '#/tui/components/dialogs/workflows-agent-detail';
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
    prompt: undefined,
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
    const completedApp = new WorkflowsBrowserApp(
      { agents: [completed], selectedAgentId: 'agent-1', onSelect: vi.fn(), onCancel: vi.fn() },
      terminal,
    );
    const completedList = strip(completedApp.render(100).join('\n'));
    expect(completedList).toContain('done 1');
    // The result lives in the conversation detail (→ opens it).
    completedApp.handleInput('\x1b[C');
    expect(strip(completedApp.render(100).join('\n'))).toContain('completed successfully');

    const failed = agent({
      status: 'failed',
      endedAt: now - 1_000,
      statusDetail: 'build failed',
      currentActivity: { kind: 'idle', label: 'Idle' },
    });
    const detail = new WorkflowsAgentDetail({ agent: failed as never });
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

  it('folds completed roster rows by default and shows the stream in the detail view', () => {
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
    // The tree overview shows no chain content…
    expect(strip(app.render(100).join('\n'))).not.toContain('secret chain text');
    // …the conversation detail always renders the full stream.
    app.handleInput('\x1b[C');
    expect(strip(app.render(100).join('\n'))).toContain('secret chain text');
  });

  it('Esc in the detail view asks before interrupting a running agent, returns for a finished one', () => {
    const stop = vi.fn();
    const onCancel = vi.fn();
    const running = agent();
    const done = agent({
      agentId: 'done',
      name: 'done',
      status: 'done',
      endedAt: now - 1_000,
      taskId: undefined,
      currentActivity: { kind: 'idle', label: 'Idle' },
    });
    const app = new WorkflowsBrowserApp(
      { agents: [running, done], selectedAgentId: 'agent-1', onSelect: vi.fn(), onCancel, onStopConfirmed: stop },
      terminal,
    );
    app.render(90);

    // Detail on the running agent: Esc arms the inline interrupt confirm.
    app.handleInput('\x1b[C');
    app.handleInput('\x1b');
    expect(strip(app.render(90).join('\n'))).toContain('y/N');
    expect(stop).not.toHaveBeenCalled();
    app.handleInput('y');
    expect(stop).toHaveBeenCalledWith('task-1');

    // Detail on the finished agent: Esc goes straight back to the tree.
    const app2 = new WorkflowsBrowserApp(
      { agents: [done], selectedAgentId: 'done', onSelect: vi.fn(), onCancel, onStopConfirmed: stop },
      terminal,
    );
    app2.render(90);
    app2.handleInput('\x1b[C');
    expect(strip(app2.render(90).join('\n'))).toContain('Conversation');
    app2.handleInput('\x1b');
    expect(strip(app2.render(90).join('\n'))).toContain('Roster');
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('renders the parent prompt as the first user message in the detail view', () => {
    const withPrompt = agent({ prompt: 'Review the parser for edge cases' });
    const detail = new WorkflowsAgentDetail({ agent: withPrompt as never });
    const out = strip(detail.render(80, 30).join('\n'));
    expect(out).toContain('Instruction from the main agent:');
    expect(out).toContain('❯ Review the parser for edge cases');
    // The selected agent's own model/context bars, not the main session's.
    const bars = strip(renderAgentStatusBars(withPrompt as never, 80).join('\n'));
    expect(bars).toContain('Model: ');
    expect(bars).toContain('kimi-k2');
  });
});
