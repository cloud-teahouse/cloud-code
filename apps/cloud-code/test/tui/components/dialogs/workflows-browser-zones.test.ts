import type { MouseEvent, Terminal } from '@cloud-code/pi-tui';
import { describe, expect, it, vi } from 'vitest';

import { WorkflowsBrowserApp, type WorkflowsBrowserProps } from '#/tui/components/dialogs/workflows-browser';
import type { WorkflowAgentNode } from '#/tui/controllers/workflows-tracker';

const now = new Date('2026-06-15T12:00:00Z').getTime();
const terminal = { rows: 24 } as unknown as Terminal;

function agent(overrides: Partial<WorkflowAgentNode> = {}): WorkflowAgentNode {
  return {
    agentId: 'main',
    name: 'main',
    parentAgentId: undefined,
    parentToolCallId: undefined,
    swarmIndex: undefined,
    runInBackground: true,
    description: undefined,
    prompt: undefined,
    status: 'running',
    statusDetail: undefined,
    lastEventAt: now,
    currentActivity: { kind: 'tool', label: 'Read', toolName: 'Read' },
    model: undefined,
    step: 1,
    startedAt: now - 20_000,
    endedAt: undefined,
    usage: undefined,
    contextTokens: undefined,
    lastOutput: undefined,
    progress: undefined,
    taskId: 'task-main',
    teamName: 'core',
    taskSubject: 'Inspect files',
    thinkingText: '',
    thinkingTruncated: false,
    tools: [],
    toolCallCount: 0,
    activity: [],
    activityTruncated: false,
    resultSummary: undefined,
    revision: 1,
    ...overrides,
  };
}

function makeBrowser(overrides: Partial<WorkflowsBrowserProps> = {}): {
  app: WorkflowsBrowserApp;
  onSelect: ReturnType<typeof vi.fn>;
} {
  const onSelect = vi.fn();
  const app = new WorkflowsBrowserApp(
    {
      agents: [
        agent(),
        agent({
          agentId: 'worker',
          name: 'worker',
          currentActivity: { kind: 'waiting-approval', label: 'Approve release' },
          status: 'waiting',
          taskId: 'task-worker',
          taskSubject: 'Review release',
        }),
        agent({
          agentId: 'done',
          name: 'done',
          status: 'done',
          endedAt: now - 1_000,
          currentActivity: { kind: 'idle', label: 'Idle' },
        }),
      ],
      selectedAgentId: 'main',
      onSelect,
      onCancel: vi.fn(),
      ...overrides,
    },
    terminal,
  );
  app.render(90);
  return { app, onSelect };
}

const press = (row: number, col = 5): MouseEvent => ({
  type: 'press',
  button: 0,
  row,
  col,
  slotRelative: false,
});

const wheel = (button: 64 | 65, row: number, col: number): MouseEvent => ({
  type: 'wheel',
  button,
  row,
  col,
  slotRelative: false,
});

describe('WorkflowsBrowserApp run-dashboard hit zones', () => {
  it('declares team, done-group, and agent row zones (the tree owns the list view)', () => {
    const { app } = makeBrowser();
    const ids = [...app.hitZones()].map((zone) => zone.id);
    expect(ids).toContain('toggle:team:core');
    expect(ids).toContain('toggle:done:core');
    expect(ids.some((id) => id === 'row:1')).toBe(true);
    // The split preview pane is gone — the tree is full-width in list mode.
    expect(ids).not.toContain('pane:tree');
    expect(ids).not.toContain('pane:detail');
  });

  it('folds and expands a team through its arrow zone', () => {
    const { app } = makeBrowser();
    const toggle = [...app.hitZones()].find((zone) => zone.id === 'toggle:team:core');
    expect(toggle).toBeDefined();
    app.onHitZone(toggle!.id, press(toggle!.row, toggle!.col));
    expect(app.render(90).join('\n')).not.toContain('Review release');
    const expandedToggle = [...app.hitZones()].find((zone) => zone.id === 'toggle:team:core');
    app.onHitZone(expandedToggle!.id, press(expandedToggle!.row, expandedToggle!.col));
    expect(app.render(90).join('\n')).toContain('@worker');
  });

  it('selects a row and re-clicking the selected row opens detail', () => {
    const { app, onSelect } = makeBrowser();
    const workerRow = [...app.hitZones()].find((zone) => zone.id === 'row:1');
    expect(workerRow).toBeDefined();
    app.onHitZone(workerRow!.id, press(workerRow!.row));
    expect(onSelect).toHaveBeenCalledWith('worker');
    app.onHitZone(workerRow!.id, press(workerRow!.row));
    // The conversation detail takes over the whole body.
    expect(app.render(90).join('\n')).toContain('Approve release');
  });

  it('uses hoverBackground for rows and clears hover on leave', () => {
    const { app } = makeBrowser();
    expect(app.setHoveredZone('row:1')).not.toBe(false);
    app.render(90);
    expect(app.setHoveredZone(null)).not.toBe(false);
  });

  it('routes the wheel to the roster selection in list mode', () => {
    const { app, onSelect } = makeBrowser({
      agents: [
        agent(),
        agent({ agentId: 'worker', name: 'worker', taskSubject: 'Review release' }),
      ],
      selectedAgentId: 'main',
    });
    app.handleMouse(wheel(65, 4, 5));
    expect(onSelect).toHaveBeenCalledWith('worker');
    app.handleMouse(wheel(64, 4, 70));
    expect(onSelect).toHaveBeenLastCalledWith('main');
    expect(app.render(90).length).toBe(terminal.rows);
  });
});
