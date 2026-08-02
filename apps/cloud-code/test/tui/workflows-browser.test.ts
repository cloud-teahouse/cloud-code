import type { MouseEvent, Terminal } from '@cloud-code/pi-tui';
import type { Event, TokenUsage } from '@cloud-code/sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { dispatchInput, type SlashCommandHost } from '@/tui/commands/dispatch';
import { findBuiltInSlashCommand } from '@/tui/commands/registry';
import { resolveSlashCommandInput } from '@/tui/commands/resolve';
import {
  WorkflowsBrowserApp,
  type WorkflowsBrowserProps,
} from '@/tui/components/dialogs/workflows-browser';
import { MAIN_AGENT_ID } from '@/tui/constant/cloud-code-tui';
import { WorkflowsBrowserController } from '@/tui/controllers/workflows-browser';
import {
  WorkflowTracker,
  workflowNodeTotalTokens,
  type WorkflowAgentNode,
  type WorkflowAgentStatus,
} from '@/tui/controllers/workflows-tracker';
import { setLocalePreference, t } from '#/tui/i18n';
import { currentTheme } from '#/tui/theme';

const ANSI_SGR = /\[[0-9;]*m/g;
function strip(text: string): string {
  return text.replaceAll(ANSI_SGR, '');
}

afterEach(() => {
  setLocalePreference('en');
});

/** Minimal Terminal stub — only `rows` is read by the component. */
function fakeTerminal(rows: number, columns = 120): Terminal {
  return {
    start: () => {},
    stop: () => {},
    drainInput: () => Promise.resolve(),
    write: () => {},
    get columns() {
      return columns;
    },
    get rows() {
      return rows;
    },
    get kittyProtocolActive() {
      return false;
    },
    moveBy: () => {},
    hideCursor: () => {},
    showCursor: () => {},
    clearLine: () => {},
    clearFromCursor: () => {},
    clearScreen: () => {},
    setTitle: () => {},
    setProgress: () => {},
    enterAltScreen: () => {},
    exitAltScreen: () => {},
    setMouseReporting: () => {},
  };
}

// ---------------------------------------------------------------------------
// Event helpers
// ---------------------------------------------------------------------------

const SESSION_ID = 'ses-1';

function ev(partial: Record<string, unknown> & { type: string }): Event {
  return { sessionId: SESSION_ID, agentId: 'main', ...partial } as unknown as Event;
}

function usage(input: number, output: number): TokenUsage {
  return { inputOther: input, output, inputCacheRead: 0, inputCacheCreation: 0 };
}

/**
 * Feed the acceptance scenario: main spawns coder (`a1`), coder spawns
 * explore (`b1`), plus a two-worker AgentSwarm batch (`w0`, `w1`).
 */
function feedTwoLevelPlusSwarm(tracker: WorkflowTracker): void {
  tracker.handleEvent(ev({ type: 'turn.started', turnId: 1, origin: { kind: 'user' } }));
  tracker.handleEvent(ev({ type: 'turn.step.started', turnId: 1, step: 1 }));

  // Level 1: coder subagent.
  tracker.handleEvent(
    ev({
      type: 'subagent.spawned',
      agentId: 'main',
      subagentId: 'a1',
      subagentName: 'coder',
      parentToolCallId: 'tc-agent-1',
      parentAgentId: 'main',
      description: 'implement feature',
      runInBackground: false,
    }),
  );
  tracker.handleEvent(ev({ type: 'subagent.started', agentId: 'main', subagentId: 'a1' }));
  tracker.handleEvent(ev({ type: 'turn.step.started', agentId: 'a1', turnId: 1, step: 2 }));
  tracker.handleEvent(ev({ type: 'thinking.delta', agentId: 'a1', turnId: 1, delta: 'let me plan ' }));
  tracker.handleEvent(ev({ type: 'thinking.delta', agentId: 'a1', turnId: 1, delta: 'the change' }));
  tracker.handleEvent(
    ev({
      type: 'tool.call.started',
      agentId: 'a1',
      turnId: 1,
      toolCallId: 'tc-read',
      name: 'Read',
      args: { file_path: 'src/a.ts' },
    }),
  );
  tracker.handleEvent(
    ev({ type: 'tool.result', agentId: 'a1', turnId: 1, toolCallId: 'tc-read', output: 'file body' }),
  );

  // Level 2: explore subagent spawned by coder.
  tracker.handleEvent(
    ev({
      type: 'subagent.spawned',
      agentId: 'a1',
      subagentId: 'b1',
      subagentName: 'explore',
      parentToolCallId: 'tc-agent-2',
      parentAgentId: 'a1',
      runInBackground: false,
    }),
  );
  tracker.handleEvent(ev({ type: 'subagent.started', agentId: 'a1', subagentId: 'b1' }));
  tracker.handleEvent(
    ev({
      type: 'subagent.completed',
      agentId: 'a1',
      subagentId: 'b1',
      resultSummary: 'found it',
      usage: usage(100, 20),
      contextTokens: 120,
    }),
  );

  // Suspension + resume on the coder.
  tracker.handleEvent(
    ev({ type: 'subagent.suspended', agentId: 'main', subagentId: 'a1', reason: 'rate limited' }),
  );
  tracker.handleEvent(ev({ type: 'subagent.started', agentId: 'main', subagentId: 'a1' }));
  tracker.handleEvent(
    ev({
      type: 'subagent.completed',
      agentId: 'main',
      subagentId: 'a1',
      resultSummary: 'feature done',
      usage: usage(900, 80),
      contextTokens: 980,
    }),
  );

  // Swarm batch: two workers under one AgentSwarm tool call.
  tracker.handleEvent(
    ev({
      type: 'tool.call.started',
      agentId: 'main',
      turnId: 1,
      toolCallId: 'tc-swarm',
      name: 'AgentSwarm',
      args: { tasks: [] },
    }),
  );
  for (const [id, index] of [
    ['w0', 0],
    ['w1', 1],
  ] as const) {
    tracker.handleEvent(
      ev({
        type: 'subagent.spawned',
        agentId: 'main',
        subagentId: id,
        subagentName: 'worker',
        parentToolCallId: 'tc-swarm',
        parentAgentId: 'main',
        swarmIndex: index,
        runInBackground: false,
      }),
    );
  }
  tracker.handleEvent(ev({ type: 'subagent.started', agentId: 'main', subagentId: 'w0' }));
  tracker.handleEvent(
    ev({ type: 'subagent.failed', agentId: 'main', subagentId: 'w1', error: 'boom' }),
  );
}

// ---------------------------------------------------------------------------
// WorkflowTracker
// ---------------------------------------------------------------------------

describe('WorkflowTracker', () => {
  it('builds a two-level tree plus a swarm batch with correct statuses', () => {
    const tracker = new WorkflowTracker();
    feedTwoLevelPlusSwarm(tracker);

    const agents = tracker.getAgents();
    const byId = new Map(agents.map((a) => [a.agentId, a]));

    const main = byId.get('main');
    expect(main?.status).toBe('running');
    expect(main?.step).toBe(1);
    expect(main?.parentAgentId).toBeUndefined();

    const coder = byId.get('a1');
    expect(coder?.parentAgentId).toBe('main');
    expect(coder?.status).toBe('done');
    expect(coder?.step).toBe(2);
    expect(coder?.resultSummary).toBe('feature done');
    expect(coder?.contextTokens).toBe(980);
    expect(coder?.endedAt).toBeDefined();

    const explore = byId.get('b1');
    expect(explore?.parentAgentId).toBe('a1');
    expect(explore?.status).toBe('done');

    const w0 = byId.get('w0');
    expect(w0?.parentAgentId).toBe('main');
    expect(w0?.parentToolCallId).toBe('tc-swarm');
    expect(w0?.swarmIndex).toBe(0);
    expect(w0?.status).toBe('running');

    const w1 = byId.get('w1');
    expect(w1?.swarmIndex).toBe(1);
    expect(w1?.status).toBe('failed');
    expect(w1?.statusDetail).toBe('boom');
  });

  it('records thinking and tool entries for the chain-of-thought view', () => {
    const tracker = new WorkflowTracker();
    feedTwoLevelPlusSwarm(tracker);

    const coder = tracker.getAgent('a1');
    expect(coder?.thinkingText).toBe('let me plan the change');
    expect(coder?.toolCallCount).toBe(1);
    const entry = coder?.tools[0];
    expect(entry?.name).toBe('Read');
    expect(entry?.status).toBe('done');
    expect(entry?.argsText).toContain('src/a.ts');
    expect(entry?.resultText).toBe('file body');

    // Token totals accumulate from subagent.completed usage.
    expect(coder?.usage?.inputOther).toBe(900);
    expect(coder === undefined ? 0 : workflowNodeTotalTokens(coder)).toBe(980);
  });

  it('tracks the suspended status and its reason', () => {
    const tracker = new WorkflowTracker();
    tracker.handleEvent(
      ev({
        type: 'subagent.spawned',
        subagentId: 'a1',
        subagentName: 'coder',
        parentToolCallId: 'tc-1',
        parentAgentId: 'main',
        runInBackground: false,
      }),
    );
    tracker.handleEvent(
      ev({ type: 'subagent.suspended', subagentId: 'a1', reason: 'waiting on approval' }),
    );
    const node = tracker.getAgent('a1');
    expect(node?.status).toBe('suspended');
    expect(node?.statusDetail).toBe('waiting on approval');
  });

  it('drives the main agent from turn boundaries', () => {
    const tracker = new WorkflowTracker();
    tracker.handleEvent(ev({ type: 'turn.started', turnId: 1, origin: { kind: 'user' } }));
    expect(tracker.getAgent('main')?.status).toBe('running');
    tracker.handleEvent(ev({ type: 'turn.ended', turnId: 1, reason: 'completed' }));
    expect(tracker.getAgent('main')?.status).toBe('idle');
  });

  it('captures usage from agent.status.updated for running agents', () => {
    const tracker = new WorkflowTracker();
    tracker.handleEvent(
      ev({
        type: 'agent.status.updated',
        agentId: 'w0',
        contextTokens: 512,
        usage: { total: usage(400, 40) },
      }),
    );
    const node = tracker.getAgent('w0');
    expect(node?.contextTokens).toBe(512);
    expect(node === undefined ? 0 : workflowNodeTotalTokens(node)).toBe(440);
  });

  it('records a tool result even when the start was missed', () => {
    const tracker = new WorkflowTracker();
    tracker.handleEvent(
      ev({
        type: 'tool.result',
        agentId: 'a1',
        turnId: 1,
        toolCallId: 'tc-x',
        output: 'late result',
        isError: true,
      }),
    );
    const entry = tracker.getAgent('a1')?.tools[0];
    expect(entry?.status).toBe('failed');
    expect(entry?.resultText).toBe('late result');
  });

  it('resets the chain when an agent is re-spawned for a new task', () => {
    const tracker = new WorkflowTracker();
    tracker.handleEvent(
      ev({
        type: 'subagent.spawned',
        subagentId: 'a1',
        subagentName: 'coder',
        parentToolCallId: 'tc-1',
        parentAgentId: 'main',
        runInBackground: false,
      }),
    );
    tracker.handleEvent(ev({ type: 'thinking.delta', agentId: 'a1', turnId: 1, delta: 'old run' }));
    tracker.handleEvent(
      ev({
        type: 'subagent.completed',
        subagentId: 'a1',
        resultSummary: 'done once',
      }),
    );
    tracker.handleEvent(
      ev({
        type: 'subagent.spawned',
        subagentId: 'a1',
        subagentName: 'coder',
        parentToolCallId: 'tc-2',
        parentAgentId: 'main',
        runInBackground: false,
      }),
    );
    const node = tracker.getAgent('a1');
    expect(node?.status).toBe('waiting');
    expect(node?.thinkingText).toBe('');
    expect(node?.tools).toHaveLength(0);
    expect(node?.resultSummary).toBeUndefined();
  });

  it('notifies subscribers on changes and reset', () => {
    const tracker = new WorkflowTracker();
    const listener = vi.fn();
    const unsubscribe = tracker.subscribe(listener);
    tracker.handleEvent(ev({ type: 'turn.started', turnId: 1, origin: { kind: 'user' } }));
    expect(listener).toHaveBeenCalled();
    listener.mockClear();
    unsubscribe();
    tracker.handleEvent(ev({ type: 'turn.ended', turnId: 1, reason: 'completed' }));
    expect(listener).not.toHaveBeenCalled();
  });

  it('captures the model from agent.status.updated', () => {
    const tracker = new WorkflowTracker();
    tracker.handleEvent(
      ev({ type: 'agent.status.updated', agentId: 'a1', model: 'kimi-for-coding' }),
    );
    expect(tracker.getAgent('a1')?.model).toBe('kimi-for-coding');
    // A status update without a model leaves the previous value alone.
    tracker.handleEvent(ev({ type: 'agent.status.updated', agentId: 'a1', contextTokens: 10 }));
    expect(tracker.getAgent('a1')?.model).toBe('kimi-for-coding');
  });

  it('interleaves thinking segments and tool calls in activity order', () => {
    const tracker = new WorkflowTracker();
    tracker.handleEvent(ev({ type: 'thinking.delta', agentId: 'a1', turnId: 1, delta: 'plan ' }));
    tracker.handleEvent(ev({ type: 'thinking.delta', agentId: 'a1', turnId: 1, delta: 'first' }));
    tracker.handleEvent(
      ev({
        type: 'tool.call.started',
        agentId: 'a1',
        turnId: 1,
        toolCallId: 'tc-1',
        name: 'Read',
        args: { file_path: 'a.ts' },
      }),
    );
    tracker.handleEvent(
      ev({ type: 'thinking.delta', agentId: 'a1', turnId: 1, delta: 'now edit' }),
    );
    tracker.handleEvent(
      ev({ type: 'tool.result', agentId: 'a1', turnId: 1, toolCallId: 'tc-1', output: 'body' }),
    );

    const node = tracker.getAgent('a1');
    expect(node?.activity.map((entry) => entry.kind)).toEqual(['thinking', 'tool', 'thinking']);
    const [first, toolEntry, second] = node!.activity;
    // Consecutive deltas coalesce into one thinking segment.
    expect(first?.kind === 'thinking' && first.text).toBe('plan first');
    // Tool entries are shared with the tools list, so results update live.
    expect(toolEntry?.kind === 'tool' && toolEntry.tool).toBe(node?.tools[0]);
    expect(toolEntry?.kind === 'tool' && toolEntry.tool.status).toBe('done');
    // A tool call closes the current segment; the next delta opens a new one.
    expect(second?.kind === 'thinking' && second.text).toBe('now edit');
  });

  it('resets the activity stream when an agent is re-spawned', () => {
    const tracker = new WorkflowTracker();
    tracker.handleEvent(
      ev({
        type: 'subagent.spawned',
        subagentId: 'a1',
        subagentName: 'coder',
        parentToolCallId: 'tc-1',
        parentAgentId: 'main',
        runInBackground: false,
      }),
    );
    tracker.handleEvent(ev({ type: 'thinking.delta', agentId: 'a1', turnId: 1, delta: 'old run' }));
    tracker.handleEvent(
      ev({
        type: 'subagent.spawned',
        subagentId: 'a1',
        subagentName: 'coder',
        parentToolCallId: 'tc-2',
        parentAgentId: 'main',
        runInBackground: false,
      }),
    );
    const node = tracker.getAgent('a1');
    expect(node?.activity).toHaveLength(0);
    expect(node?.activityTruncated).toBe(false);
  });

  it('caps the activity stream and flags truncation', () => {
    const tracker = new WorkflowTracker();
    for (let i = 0; i < 65; i++) {
      tracker.handleEvent(
        ev({
          type: 'tool.call.started',
          agentId: 'a1',
          turnId: 1,
          toolCallId: `tc-${i}`,
          name: 'Bash',
          args: {},
        }),
      );
    }
    const node = tracker.getAgent('a1');
    expect(node?.activity).toHaveLength(60);
    expect(node?.activityTruncated).toBe(true);
    // Newest entries survive the head drop.
    const tail = node?.activity[node.activity.length - 1];
    expect(tail?.kind === 'tool' && tail.tool.id).toBe('tc-64');
  });

  /** Minimal AgentTaskInfo-shaped payload for background.task.* events. */
  function agentTask(
    agentId: string,
    status: string,
    extra: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      kind: 'agent',
      agentId,
      taskId: `task-${agentId}`,
      description: 'background agent',
      status,
      startedAt: Date.now() - 1000,
      endedAt: null,
      ...extra,
    };
  }

  it('marks a detached foreground agent as background on task.started', () => {
    const tracker = new WorkflowTracker();
    tracker.handleEvent(
      ev({
        type: 'subagent.spawned',
        subagentId: 'a1',
        subagentName: 'coder',
        parentToolCallId: 'tc-1',
        parentAgentId: 'main',
        runInBackground: false,
      }),
    );
    expect(tracker.getAgent('a1')?.runInBackground).toBe(false);
    tracker.handleEvent(
      ev({ type: 'background.task.started', info: agentTask('a1', 'running') }),
    );
    expect(tracker.getAgent('a1')?.runInBackground).toBe(true);
    // Non-agent tasks (processes) never touch the agent tree.
    tracker.handleEvent(
      ev({
        type: 'background.task.started',
        info: { kind: 'process', taskId: 'p1', description: 'cmd', status: 'running', startedAt: 0, endedAt: null, command: 'ls', pid: 1, exitCode: null },
      }),
    );
    expect(tracker.getAgents().filter((a) => a.agentId !== 'a1' && a.agentId !== 'main')).toHaveLength(0);
  });

  it('maps agent task termination to killed / timed_out / lost / done', () => {
    const tracker = new WorkflowTracker();
    for (const id of ['a1', 'a2', 'a3', 'a4']) {
      tracker.handleEvent(
        ev({
          type: 'subagent.spawned',
          subagentId: id,
          subagentName: 'worker',
          parentToolCallId: 'tc-swarm',
          parentAgentId: 'main',
          runInBackground: true,
        }),
      );
      tracker.handleEvent(ev({ type: 'subagent.started', subagentId: id }));
    }
    tracker.handleEvent(
      ev({
        type: 'background.task.terminated',
        info: agentTask('a1', 'killed', { stopReason: 'Stopped by user', endedAt: Date.now() }),
      }),
    );
    tracker.handleEvent(
      ev({ type: 'background.task.terminated', info: agentTask('a2', 'timed_out') }),
    );
    tracker.handleEvent(
      ev({ type: 'background.task.terminated', info: agentTask('a3', 'lost') }),
    );
    tracker.handleEvent(
      ev({ type: 'background.task.terminated', info: agentTask('a4', 'completed') }),
    );

    const killed = tracker.getAgent('a1');
    expect(killed?.status).toBe('killed');
    expect(killed?.statusDetail).toBe('Stopped by user');
    expect(killed?.endedAt).toBeDefined();
    expect(tracker.getAgent('a2')?.status).toBe('timed_out');
    expect(tracker.getAgent('a3')?.status).toBe('lost');
    expect(tracker.getAgent('a4')?.status).toBe('done');

    // A kill after a failure event still resolves to the authoritative task
    // status; a non-terminal task event changes nothing.
    tracker.handleEvent(
      ev({ type: 'subagent.failed', subagentId: 'a2', error: 'aborted' }),
    );
    tracker.handleEvent(
      ev({ type: 'background.task.terminated', info: agentTask('a2', 'killed') }),
    );
    expect(tracker.getAgent('a2')?.status).toBe('killed');
    tracker.handleEvent(
      ev({ type: 'background.task.terminated', info: agentTask('a3', 'running') }),
    );
    expect(tracker.getAgent('a3')?.status).toBe('lost');
  });
});

// ---------------------------------------------------------------------------
// Component helpers
// ---------------------------------------------------------------------------

function node(overrides: Partial<WorkflowAgentNode> & { agentId: string }): WorkflowAgentNode {
  return {
    name: overrides.agentId,
    parentAgentId: undefined,
    parentToolCallId: undefined,
    swarmIndex: undefined,
    runInBackground: false,
    description: undefined,
    status: 'running',
    statusDetail: undefined,
    model: undefined,
    step: 0,
    startedAt: Date.now() - 65_000,
    endedAt: undefined,
    usage: undefined,
    contextTokens: undefined,
    thinkingText: '',
    thinkingTruncated: false,
    tools: [],
    toolCallCount: 0,
    activity: [],
    activityTruncated: false,
    resultSummary: undefined,
    revision: 0,
    ...overrides,
  };
}

function sampleAgents(): WorkflowAgentNode[] {
  const readTool = {
    id: 'tc-1',
    name: 'Read',
    argsText: '{"file_path":"src/a.ts"}',
    status: 'done' as const,
    resultText: 'export const a = 1;',
  };
  const bashTool = {
    id: 'tc-2',
    name: 'Bash',
    argsText: '{"command":"npm test"}',
    status: 'running' as const,
    resultText: undefined,
  };
  return [
    node({ agentId: 'main', name: 'main', status: 'running', step: 3, usage: usage(12000, 400) }),
    node({
      agentId: 'a1',
      name: 'coder',
      parentAgentId: 'main',
      status: 'running',
      step: 2,
      usage: usage(4000, 100),
      thinkingText: 'first thought\nsecond thought',
      thinkingTruncated: true,
      tools: [readTool, bashTool],
      toolCallCount: 8,
      activity: [
        { kind: 'thinking', text: 'first thought\nsecond thought' },
        { kind: 'tool', tool: readTool },
        { kind: 'tool', tool: bashTool },
      ],
    }),
    node({
      agentId: 'b1',
      name: 'explore',
      parentAgentId: 'a1',
      status: 'done',
      endedAt: Date.now() - 30_000,
      usage: usage(2000, 0),
    }),
    node({ agentId: 'w0', name: 'worker', parentAgentId: 'main', swarmIndex: 0, status: 'waiting' }),
    node({
      agentId: 'w1',
      name: 'worker',
      parentAgentId: 'main',
      swarmIndex: 1,
      status: 'failed',
      statusDetail: 'boom',
      endedAt: Date.now() - 5000,
    }),
  ];
}

function makeProps(overrides: Partial<WorkflowsBrowserProps> = {}): WorkflowsBrowserProps {
  return {
    agents: [],
    selectedAgentId: undefined,
    onSelect: vi.fn(),
    onCancel: vi.fn(),
    ...overrides,
  };
}

function makeApp(
  props: Partial<WorkflowsBrowserProps> = {},
  rows = 30,
  columns = 120,
): WorkflowsBrowserApp {
  return new WorkflowsBrowserApp(makeProps(props), fakeTerminal(rows, columns));
}

// ---------------------------------------------------------------------------
// WorkflowsBrowserApp — rendering
// ---------------------------------------------------------------------------

describe('WorkflowsBrowserApp — rendering', () => {
  it('fills exactly terminal.rows lines (height takeover)', () => {
    expect(makeApp({}, 30).render(120).length).toBe(30);
  });

  it('shows the header with title and status counts', () => {
    const out = strip(makeApp({ agents: sampleAgents() }).render(120).join('\n'));
    expect(out).toContain('WORKFLOWS');
    expect(out).toContain('2 running');
    expect(out).toContain('1 done');
    expect(out).toContain('1 failed');
    expect(out).toContain('5 total');
  });

  it('renders the agent tree with hierarchy, status, step, tokens and duration', () => {
    const out = strip(makeApp({ agents: sampleAgents() }).render(120).join('\n'));
    expect(out).toContain('main');
    expect(out).toContain('coder');
    expect(out).toContain('explore');
    // Swarm workers carry their index badge.
    expect(out).toContain('#0 worker');
    expect(out).toContain('#1 worker');
    // Step / token / duration readouts for the running coder.
    expect(out).toContain('step 2');
    expect(out).toContain('4k tok');
    expect(out).toMatch(/1m 5s/);
  });

  it('indents child agents under their parent', () => {
    const lines = makeApp({ agents: sampleAgents() }).render(120).map(strip);
    const coderLine = lines.find((l) => l.includes('coder'));
    const exploreLine = lines.find((l) => l.includes('explore'));
    expect(coderLine).toBeDefined();
    expect(exploreLine).toBeDefined();
    const coderIndent = coderLine!.indexOf('coder');
    const exploreIndent = exploreLine!.indexOf('explore');
    expect(exploreIndent).toBeGreaterThan(coderIndent);
  });

  it('shows the chain-of-thought pane for the selected agent', () => {
    const out = strip(
      makeApp({ agents: sampleAgents(), selectedAgentId: 'a1' }).render(120).join('\n'),
    );
    expect(out).toContain('Chain of Thought');
    // Interleaved stream: dim thinking line (✻), then tool calls in order.
    expect(out).toContain('✻ second thought');
    // Tool-use count moved into the header status line.
    expect(out).toContain('8 tools');
    expect(out).toContain('Read');
    expect(out).toContain('src/a.ts');
    expect(out).toContain('export const a = 1;');
    expect(out).toContain('Bash');
    // Truncation hint: thinkingTruncated is set and toolCallCount > kept tools.
    expect(out).toContain('use Read / TaskOutput');
  });

  it('renders the interleaved stream in activity order', () => {
    const lines = strip(
      makeApp({ agents: sampleAgents(), selectedAgentId: 'a1' }).render(120).join('\n'),
    ).split('\n');
    const thinkingIdx = lines.findIndex((l) => l.includes('✻ second thought'));
    const readIdx = lines.findIndex((l) => l.includes('Read'));
    const bashIdx = lines.findIndex((l) => l.includes('Bash'));
    expect(thinkingIdx).toBeGreaterThanOrEqual(0);
    expect(readIdx).toBeGreaterThan(thinkingIdx);
    expect(bashIdx).toBeGreaterThan(readIdx);
  });

  it('renders the killed status with the error icon and stop reason', () => {
    const agents = [
      node({ agentId: 'main', name: 'main' }),
      node({
        agentId: 'a1',
        name: 'coder',
        parentAgentId: 'main',
        status: 'killed',
        statusDetail: 'Stopped by user',
        endedAt: Date.now() - 1000,
      }),
    ];
    const out = strip(makeApp({ agents, selectedAgentId: 'a1' }).render(120).join('\n'));
    expect(out).toContain('✗ killed');
    expect(out).toContain('Stopped by user');
    // Killed agents roll up into the header's failed tally.
    expect(out).toContain('1 failed');
  });

  it('shows the model in the agent header when the tracker knows it', () => {
    const agents = [
      node({ agentId: 'main', name: 'main', model: 'kimi-for-coding' }),
      node({ agentId: 'a1', name: 'coder', parentAgentId: 'main' }),
    ];
    const withModel = strip(
      makeApp({ agents, selectedAgentId: 'main' }).render(120).join('\n'),
    );
    expect(withModel).toContain('kimi-for-coding');
    // Unknown model: no placeholder, the segment is simply absent.
    const withoutModel = strip(
      makeApp({ agents, selectedAgentId: 'a1' }).render(120).join('\n'),
    );
    expect(withoutModel).not.toContain('kimi-for-coding');
  });

  it('shows the failure detail for a failed agent', () => {
    const out = strip(
      makeApp({ agents: sampleAgents(), selectedAgentId: 'w1' }).render(120).join('\n'),
    );
    expect(out).toContain('Error: boom');
  });

  it('shows the empty state when no agent activity exists', () => {
    const out = strip(makeApp().render(120).join('\n'));
    expect(out).toContain('No agent activity in this session yet');
    expect(out).toContain('Select an agent to inspect its chain of thought');
  });

  it('hints that subagents will appear when only the main agent exists', () => {
    const out = strip(
      makeApp({ agents: [node({ agentId: 'main', name: 'main' })] }).render(120).join('\n'),
    );
    expect(out).toContain('No subagents yet');
  });

  it('renders zh-CN copy when the zh-CN locale is active', () => {
    setLocalePreference('zh-CN');
    const out = strip(
      makeApp({ agents: sampleAgents(), selectedAgentId: 'a1' }).render(120).join('\n'),
    );
    expect(out).toContain('工作流');
    expect(out).toContain('Agent 树');
    expect(out).toContain('思维链');
    expect(out).toContain('运行中');
    expect(out).toContain('主 agent');
    expect(out).toContain('8 次工具调用');
    expect(t('workflows.command.description')).toBe('查看 agent 树与子代理思维链');
  });

  it('renders the killed status in zh-CN', () => {
    setLocalePreference('zh-CN');
    const agents = [
      node({
        agentId: 'a1',
        name: 'coder',
        status: 'killed',
        statusDetail: '用户停止',
        endedAt: Date.now() - 1000,
      }),
    ];
    const out = strip(makeApp({ agents, selectedAgentId: 'a1' }).render(120).join('\n'));
    expect(out).toContain('已终止');
    expect(out).toContain('用户停止');
  });

  it('falls back to a single line when the terminal is too small', () => {
    const out = strip(makeApp({}, 5, 30).render(30).join('\n'));
    expect(out).toContain('too small');
  });
});

// ---------------------------------------------------------------------------
// WorkflowsBrowserApp — input handling
// ---------------------------------------------------------------------------

describe('WorkflowsBrowserApp — input handling', () => {
  it('Esc and q invoke onCancel', () => {
    const onCancel = vi.fn();
    const app = makeApp({ onCancel });
    app.handleInput('');
    app.handleInput('q');
    expect(onCancel).toHaveBeenCalledTimes(2);
  });

  it('arrow keys move selection and invoke onSelect', () => {
    const onSelect = vi.fn();
    const agents = sampleAgents();
    const app = makeApp({ agents, selectedAgentId: 'main', onSelect });
    app.handleInput('[B'); // ↓
    expect(onSelect).toHaveBeenLastCalledWith('a1');
    app.handleInput('j');
    expect(onSelect).toHaveBeenLastCalledWith('b1');
    app.handleInput('[A'); // ↑
    expect(onSelect).toHaveBeenLastCalledWith('a1');
  });

  it('Enter collapses and re-expands a node with children', () => {
    const agents = sampleAgents();
    const app = makeApp({ agents, selectedAgentId: 'a1' });
    // explore (child of a1) is visible initially.
    expect(strip(app.render(120).join('\n'))).toContain('explore');
    app.handleInput('\r');
    expect(strip(app.render(120).join('\n'))).not.toContain('explore');
    app.handleInput('\r');
    expect(strip(app.render(120).join('\n'))).toContain('explore');
  });

  it('Enter on a leaf node does nothing', () => {
    const onSelect = vi.fn();
    const app = makeApp({ agents: sampleAgents(), selectedAgentId: 'w0', onSelect });
    app.handleInput('\r');
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('supports Kitty CSI-u printable input', () => {
    const kitty = (ch: string): string => `[${String(ch.codePointAt(0) ?? 0)}u`;
    const onCancel = vi.fn();
    const onSelect = vi.fn();
    const app = makeApp({ agents: sampleAgents(), selectedAgentId: 'main', onSelect, onCancel });
    app.handleInput(kitty('j'));
    expect(onSelect).toHaveBeenLastCalledWith('a1');
    app.handleInput(kitty('q'));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('PgUp/PgDn scrolls the list-mode preview pane (teams-browser idiom)', () => {
    const app = makeApp({ agents: longContentAgents(), selectedAgentId: 'a1' }, 12, 70);
    // Tail-pinned by default: the latest tool result is visible.
    expect(strip(app.render(70).join('\n'))).toContain('long result body');
    // Page up into history: the header scrolls into view, the tail leaves.
    app.handleInput('\x1B[5~');
    const scrolled = strip(app.render(70).join('\n'));
    expect(scrolled).toContain('coder');
    expect(scrolled).not.toContain('long result body');
    // Page down returns to the tail.
    app.handleInput('\x1B[6~');
    expect(strip(app.render(70).join('\n'))).toContain('long result body');
  });

  it('preview keeps a scrolled-up position when new activity streams in', () => {
    const agents = longContentAgents();
    const app = makeApp({ agents, selectedAgentId: 'a1' }, 12, 70);
    app.handleInput('\x1B[5~'); // scroll the preview up into history
    const scrolled = strip(app.render(70).join('\n'));
    expect(scrolled).toContain('coder');
    // A live update (controller repaint) must not re-pin the preview.
    const a1 = agents[1]!;
    const newTool = {
      id: 'tc-9',
      name: 'Bash',
      argsText: '{"command":"npm test"}',
      status: 'done' as const,
      resultText: 'late arriving result',
    };
    const updated: WorkflowAgentNode = {
      ...a1,
      toolCallCount: 4,
      tools: [...a1.tools, newTool],
      activity: [...a1.activity, { kind: 'tool', tool: newTool }],
    };
    app.setProps({ ...makeProps({}), agents: [agents[0]!, updated], selectedAgentId: 'a1' });
    const still = strip(app.render(70).join('\n'));
    expect(still).toContain('coder');
    expect(still).not.toContain('late arriving result');
  });
});

// ---------------------------------------------------------------------------
// Command registration & dispatch
// ---------------------------------------------------------------------------

describe('/workflows command', () => {
  it('is registered with the /wf alias', () => {
    const command = findBuiltInSlashCommand('workflows');
    expect(command?.name).toBe('workflows');
    expect(command?.aliases).toContain('wf');
    expect(findBuiltInSlashCommand('wf')?.name).toBe('workflows');
    // Description is an i18n key in the workflows domain.
    expect(command?.description).toBe('workflows.command.description');
    expect(t('workflows.command.description')).toContain('agent tree');
  });

  it('resolves /wf to the builtin workflows intent', () => {
    const intent = resolveSlashCommandInput({
      input: '/wf',
      skillCommandMap: new Map(),
      pluginCommandMap: new Map(),
      isStreaming: false,
      isCompacting: false,
    });
    expect(intent).toMatchObject({ kind: 'builtin', name: 'workflows' });
  });

  it('is available while streaming (availability: always)', () => {
    const intent = resolveSlashCommandInput({
      input: '/workflows',
      skillCommandMap: new Map(),
      pluginCommandMap: new Map(),
      isStreaming: true,
      isCompacting: false,
    });
    expect(intent.kind).toBe('builtin');
  });

  it('dispatch opens the workflows browser', async () => {
    const show = vi.fn();
    const host = {
      state: { appState: { streamingPhase: 'idle', isCompacting: false } },
      skillCommandMap: new Map(),
      pluginCommandMap: new Map(),
        workflowsBrowserController: { show },
    } as unknown as SlashCommandHost;
    dispatchInput(host, '/workflows');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(show).toHaveBeenCalledTimes(1);

    dispatchInput(host, '/wf');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(show).toHaveBeenCalledTimes(2);
  });
});

  function longContentAgents(): WorkflowAgentNode[] {
  const longThought =
    'this is a very long chain-of-thought line that must be wrapped instead of overflowing the terminal width '.repeat(
      3,
    );
  const editTool = {
    id: 'tc-0',
    name: 'Edit',
    argsText: '{"file_path":"src/b.ts"}',
    status: 'done' as const,
    resultText: 'edit applied cleanly',
  };
  const bashTool = {
    id: 'tc-1b',
    name: 'Bash',
    argsText: '{"command":"npm run build"}',
    status: 'done' as const,
    resultText: 'build finished ok',
  };
  const readTool = {
    id: 'tc-1',
    name: 'Read',
    argsText: '{"file_path":"' + 'a/very/long/path/'.repeat(8) + 'file.ts"}',
    status: 'done' as const,
    resultText: 'long result body '.repeat(20),
  };
  return [
    node({ agentId: 'main', name: 'main', status: 'running', step: 1 }),
    node({
      agentId: 'a1',
      name: 'coder',
      parentAgentId: 'main',
      status: 'running',
      step: 2,
      thinkingText: `${longThought}\nsecond paragraph`,
      tools: [editTool, bashTool, readTool],
      toolCallCount: 3,
      activity: [
        { kind: 'thinking', text: `${longThought}\nsecond paragraph` },
        { kind: 'tool', tool: editTool },
        { kind: 'tool', tool: bashTool },
        { kind: 'tool', tool: readTool },
      ],
    }),
  ];
}

// ---------------------------------------------------------------------------
// WorkflowsBrowserApp — hover-to-scroll (mouse wheel routing)
// ---------------------------------------------------------------------------

describe('WorkflowsBrowserApp — hover-to-scroll', () => {
  function wheel(button: 64 | 65, col: number, row = 5): MouseEvent {
    return { type: 'wheel', button, col, row, slotRelative: false };
  }

  it('wheel over the detail view scrolls the chain anywhere', () => {
    const app = makeApp({ agents: longContentAgents(), selectedAgentId: 'a1' }, 12, 70);
    app.handleInput('\x1B[C'); // enter detail
    const opened = strip(app.render(70).join('\n'));
    expect(opened).toContain('long result body');

    for (let i = 0; i < 8; i++) app.handleMouse(wheel(64, 35)); // wheel up to the top
    const scrolled = strip(app.render(70).join('\n'));
    expect(scrolled).toContain('coder');
    for (let i = 0; i < 8; i++) app.handleMouse(wheel(65, 60)); // and back down
    expect(strip(app.render(70).join('\n'))).toContain('long result body');
  });

  it('wheel over the tree column moves the agent selection', () => {
    const onSelect = vi.fn();
    const app = makeApp({ agents: sampleAgents(), selectedAgentId: 'main', onSelect }, 30, 100);
    app.render(100); // populate lastTreeWidth (=36 at 100 cols)
    app.handleMouse(wheel(65, 10)); // +3 rows: main -> b1
    expect(onSelect).toHaveBeenCalledTimes(1);
    app.handleMouse(wheel(65, 10)); // clamps to the last row (w1), still emits
    expect(onSelect).toHaveBeenCalledTimes(2);
    app.handleMouse(wheel(65, 10)); // no movement at the bottom -> no new emit
    expect(onSelect).toHaveBeenCalledTimes(2);
    app.handleMouse(wheel(64, 10)); // back up by 3
    expect(onSelect).toHaveBeenCalledTimes(3);
    // Arrow keys still work alongside the wheel.
    app.handleInput('\x1B[A');
    expect(onSelect).toHaveBeenCalledTimes(4);
  });

  it('wheel over the chain pane scrolls the preview into history and back', () => {
    const app = makeApp({ agents: longContentAgents(), selectedAgentId: 'a1' }, 12, 70);
    const tail = strip(app.render(70).join('\n'));
    expect(tail).toContain('long result body');

    app.handleMouse(wheel(64, 60)); // wheel up over the preview pane
    const scrolled = strip(app.render(70).join('\n'));
    expect(scrolled).not.toContain('long result body');
    expect(scrolled).toContain('coder');

    app.handleMouse(wheel(65, 60)); // back to the tail
    expect(strip(app.render(70).join('\n'))).toContain('long result body');
  });

  it('ignores release mouse events', () => {
    const app = makeApp({ agents: sampleAgents(), selectedAgentId: 'a1' }, 30, 100);
    const before = strip(app.render(100).join('\n'));
    app.handleMouse({ type: 'release', button: 0, col: 10, row: 5, slotRelative: false });
    app.handleMouse({ type: 'release', button: 2, col: 60, row: 8, slotRelative: false });
    expect(strip(app.render(100).join('\n'))).toBe(before);
  });

  it('keyboard selection after wheel-scrolling the preview re-pins to the new agent tail', () => {
    const agents = longContentAgents();
    const app = makeApp({ agents, selectedAgentId: 'main' }, 12, 70);
    // Wheel the preview up into history first (main's chain, scrolled off-tail).
    app.handleMouse({ type: 'wheel', button: 64, col: 60, row: 5, slotRelative: false });
    app.render(70);
    // Keyboard ↓ to a1, then the controller pushes the new selection (as the
    // real app does): the preview must show a1's tail — not a stale offset
    // from the previous agent (M2 regression: reset lived only on the wheel path).
    app.handleInput('\x1B[B');
    app.setProps({ ...makeProps({}), agents, selectedAgentId: 'a1' });
    const out = strip(app.render(70).join('\n'));
    expect(out).toContain('long result body');
  });
});

describe('WorkflowsBrowserApp — detail mode navigation', () => {

  it('→ enters the full-width detail view and switches the footer hints', () => {
    const app = makeApp({ agents: sampleAgents(), selectedAgentId: 'a1' }, 30, 100);
    app.handleInput('\x1B[C'); // right arrow
    const out = strip(app.render(100).join('\n'));
    expect(out).toContain('back');
    expect(out).toContain('scroll');
    // Full-width frame: the tree pane is gone, no Agents title.
    expect(out).not.toContain('Agents');
    expect(out).toContain('Chain of Thought');
  });

  it('wraps long thinking and tool content instead of overflowing the width', () => {
    const columns = 70;
    const app = makeApp({ agents: longContentAgents(), selectedAgentId: 'a1' }, 24, columns);
    app.handleInput('\x1B[C');
    const rendered = app.render(columns);
    for (const line of rendered) {
      expect(strip(line).length).toBeLessThanOrEqual(columns);
    }
    // Bottom-follow: the most recent chain entries are visible first.
    const out = strip(rendered.join('\n'));
    expect(out).toContain('second paragraph');
    expect(out).toContain('long result body');
    // Nothing is truncated away: page up and the thought's start is there,
    // wrapped across lines rather than clipped.
    app.handleInput('\x1B[5~');
    const earlier = strip(app.render(columns).join('\n'));
    expect(earlier).toContain('this is a very long chain-of-thought line that must be wrapped');
  });

  it('opens at the latest entries and scrolls through the chain', () => {
    const app = makeApp({ agents: longContentAgents(), selectedAgentId: 'a1' }, 12, 70);
    app.handleInput('\x1B[C');
    // Opens at the bottom (most recent chain entries), not at the header.
    const opened = strip(app.render(70).join('\n'));
    expect(opened).toContain('long result body');
    expect(opened).not.toContain('Task:');

    // Page up three times: the agent header comes into view.
    app.handleInput('\x1B[5~');
    app.handleInput('\x1B[5~');
    app.handleInput('\x1B[5~');
    expect(strip(app.render(70).join('\n'))).toContain('coder');
    // Page down returns to the bottom.
    app.handleInput('\x1B[6~');
    app.handleInput('\x1B[6~');
    app.handleInput('\x1B[6~');
    expect(strip(app.render(70).join('\n'))).toContain('long result body');
    // Scrolling up past the top is a no-op (no crash).
    app.handleInput('\x1B[5~');
    app.handleInput('\x1B[5~');
    app.handleInput('\x1B[5~');
    app.handleInput('\x1B[A');
    expect(strip(app.render(70).join('\n'))).toContain('coder');
  });

  it('← / h / Esc returns to list mode; Esc closes only from list mode', () => {
    const onCancel = vi.fn();
    const app = makeApp({ agents: sampleAgents(), selectedAgentId: 'a1', onCancel }, 30, 100);
    app.handleInput('\x1B[C');
    expect(strip(app.render(100).join('\n'))).not.toContain('Agents');

    app.handleInput('\x1b'); // Esc in detail mode -> back, not close
    expect(onCancel).not.toHaveBeenCalled();
    expect(strip(app.render(100).join('\n'))).toContain('Agents');

    app.handleInput('\x1B[C');
    app.handleInput('h'); // h also goes back
    expect(strip(app.render(100).join('\n'))).toContain('Agents');

    app.handleInput('\x1b'); // Esc in list mode -> close
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('detail view follows new chain content at the bottom by default', () => {
    const agents = longContentAgents();
    const app = makeApp({ agents, selectedAgentId: 'a1' }, 10, 70);
    app.handleInput('\x1B[C');
    const before = strip(app.render(70).join('\n'));
    expect(before).toContain('long result body');
    // Stream a new tool entry in via setProps; the tail stays visible.
    const a1 = agents[1]!;
    const newTool = {
      id: 'tc-2',
      name: 'Edit',
      argsText: '{"file_path":"src/final.ts"}',
      status: 'done' as const,
      resultText: 'brand new final tool result',
    };
    const updated: WorkflowAgentNode = {
      ...a1,
      toolCallCount: 4,
      tools: [...a1.tools, newTool],
      activity: [...a1.activity, { kind: 'tool', tool: newTool }],
    };
    app.setProps({ ...makeProps({}), agents: [agents[0]!, updated], selectedAgentId: 'a1' });
    const after = strip(app.render(70).join('\n'));
    expect(after).toContain('brand new final tool result');
  });

  it('detail view keeps a scrolled-up position when new content streams in', () => {
    const agents = longContentAgents();
    const app = makeApp({ agents, selectedAgentId: 'a1' }, 10, 70);
    app.handleInput('\x1B[C');
    // Scroll all the way to the top (past maxScroll; clamps to 0).
    for (let i = 0; i < 5; i++) app.handleInput('\x1B[5~');
    const atTop = strip(app.render(70).join('\n'));
    expect(atTop).toContain('coder');
    expect(atTop).not.toContain('long result body');
    // New activity arrives while the user is reading history: the view must
    // not jump to the tail (live-update repaint preserves the position).
    const a1 = agents[1]!;
    const newTool = {
      id: 'tc-9',
      name: 'Bash',
      argsText: '{"command":"npm test"}',
      status: 'done' as const,
      resultText: 'late arriving result',
    };
    const updated: WorkflowAgentNode = {
      ...a1,
      toolCallCount: 4,
      tools: [...a1.tools, newTool],
      activity: [...a1.activity, { kind: 'tool', tool: newTool }],
    };
    app.setProps({ ...makeProps({}), agents: [agents[0]!, updated], selectedAgentId: 'a1' });
    const still = strip(app.render(70).join('\n'));
    expect(still).toContain('coder');
    expect(still).not.toContain('late arriving result');
    // Scrolling back to the bottom re-engages follow and shows the new tail.
    for (let i = 0; i < 5; i++) app.handleInput('\x1B[6~');
    expect(strip(app.render(70).join('\n'))).toContain('late arriving result');
  });

  it('Tab toggles between the list and the detail view', () => {
    const onCancel = vi.fn();
    const app = makeApp({ agents: sampleAgents(), selectedAgentId: 'a1', onCancel }, 30, 100);
    app.handleInput('\t');
    expect(strip(app.render(100).join('\n'))).not.toContain('Agents');
    app.handleInput('\t');
    expect(strip(app.render(100).join('\n'))).toContain('Agents');
    // Tab never closes the browser.
    expect(onCancel).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// WorkflowsBrowserApp — click-to-select (left-press row hits)
// ---------------------------------------------------------------------------

describe('WorkflowsBrowserApp — click-to-select', () => {
  const press = (row: number, col: number, button = 0): MouseEvent =>
    ({ type: 'press', button, col, row, slotRelative: false });

  function flatAgents(count: number): WorkflowAgentNode[] {
    return Array.from({ length: count }, (_, i) => node({ agentId: `n${i}`, name: `agent-${i}` }));
  }

  // Layout at rows=30, cols=100: header = row 0, tree frame top border =
  // row 1, first tree row = row 2; innerHeight = 26; treeWidth = 36.
  // sampleAgents() flattens to: main(0), a1(1), b1(2), w0(3), w1(4).

  it('left-press on a tree row selects that agent, like the arrow keys', () => {
    const onSelect = vi.fn();
    const app = makeApp({ agents: sampleAgents(), selectedAgentId: 'main', onSelect }, 30, 100);
    app.render(100); // populate lastTreeWidth (=36 at 100 cols)
    app.handleMouse(press(3, 10)); // second tree row
    expect(onSelect).toHaveBeenLastCalledWith('a1');
    app.handleMouse(press(6, 10)); // last tree row
    expect(onSelect).toHaveBeenLastCalledWith('w1');
    app.handleMouse(press(2, 36)); // first row, on the frame's right border col
    expect(onSelect).toHaveBeenLastCalledWith('main');
  });

  it('clicking the already-selected row is a no-op', () => {
    const onSelect = vi.fn();
    const app = makeApp({ agents: sampleAgents(), selectedAgentId: 'main', onSelect }, 30, 100);
    app.render(100);
    app.handleMouse(press(2, 10));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('accounts for listScroll when the window is scrolled', () => {
    const onSelect = vi.fn();
    // rows=10 → innerHeight 6; 10 root agents with the last one selected
    // scrolls the window to indices 4..9 on component rows 2..7.
    const app = makeApp({ agents: flatAgents(10), selectedAgentId: 'n9', onSelect }, 10, 100);
    app.render(100);
    app.handleMouse(press(2, 10));
    expect(onSelect).toHaveBeenLastCalledWith('n4');
    app.handleMouse(press(4, 10));
    expect(onSelect).toHaveBeenLastCalledWith('n6');
  });

  it('ignores presses on the header, borders, padding and footer rows', () => {
    const onSelect = vi.fn();
    const app = makeApp({ agents: sampleAgents(), selectedAgentId: 'main', onSelect }, 30, 100);
    app.render(100);
    app.handleMouse(press(-1, 10)); // above the component
    app.handleMouse(press(0, 10)); // header
    app.handleMouse(press(1, 10)); // frame top border
    app.handleMouse(press(9, 10)); // blank padding below 5 tree rows
    app.handleMouse(press(28, 10)); // frame bottom border
    app.handleMouse(press(29, 10)); // footer
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('ignores presses over the chain pane', () => {
    const onSelect = vi.fn();
    const app = makeApp({ agents: sampleAgents(), selectedAgentId: 'main', onSelect }, 30, 100);
    app.render(100);
    app.handleMouse(press(3, 37)); // just past treeWidth (36)
    app.handleMouse(press(3, 80));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('ignores non-left buttons and non-press events', () => {
    const onSelect = vi.fn();
    const app = makeApp({ agents: sampleAgents(), selectedAgentId: 'main', onSelect }, 30, 100);
    app.render(100);
    app.handleMouse(press(3, 10, 2)); // right button
    app.handleMouse({ type: 'release', button: 0, col: 10, row: 3, slotRelative: false });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('ignores presses in detail mode (no tree on screen)', () => {
    const onSelect = vi.fn();
    const app = makeApp({ agents: sampleAgents(), selectedAgentId: 'main', onSelect }, 30, 100);
    app.render(100);
    app.handleInput('\x1B[C'); // → enters the full-width detail view
    app.handleMouse(press(3, 10));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('ignores presses when the tree is empty', () => {
    const onSelect = vi.fn();
    const app = makeApp({ onSelect }, 30, 100);
    app.render(100);
    app.handleMouse(press(2, 10));
    expect(onSelect).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Render memoization (revision-keyed caches + controller tick skip)
// ---------------------------------------------------------------------------

describe('WorkflowTracker — revision counter', () => {
  it('bumps the node revision on every mutating event', () => {
    const tracker = new WorkflowTracker();
    tracker.handleEvent(ev({ type: 'turn.started', turnId: 1, origin: { kind: 'user' } }));
    const main = tracker.getAgent(MAIN_AGENT_ID);
    expect(main).toBeDefined();
    let last = main!.revision;
    expect(last).toBeGreaterThan(0);

    tracker.handleEvent(ev({ type: 'turn.step.started', turnId: 1, step: 1 }));
    expect(main!.revision).toBeGreaterThan(last);
    last = main!.revision;

    tracker.handleEvent(ev({ type: 'thinking.delta', agentId: 'main', turnId: 1, delta: 'hmm' }));
    expect(main!.revision).toBeGreaterThan(last);
    last = main!.revision;

    tracker.handleEvent(
      ev({ type: 'tool.call.started', agentId: 'main', turnId: 1, toolCallId: 'tc-1', name: 'Read', args: {} }),
    );
    expect(main!.revision).toBeGreaterThan(last);
    last = main!.revision;

    // A delta against an unknown tool call does not mutate → no bump.
    tracker.handleEvent(
      ev({ type: 'tool.call.delta', agentId: 'main', turnId: 1, toolCallId: 'nope', argumentsPart: '{}' }),
    );
    expect(main!.revision).toBe(last);
  });
});

describe('WorkflowsBrowserApp — render memoization', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('produces byte-identical frames to a fresh component across ticks', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const agents = sampleAgents();
    const props = makeProps({ agents, selectedAgentId: 'a1' });
    const app = new WorkflowsBrowserApp(props, fakeTerminal(30, 120));

    expect(app.render(120)).toEqual(makeApp({ agents, selectedAgentId: 'a1' }, 30, 120).render(120));

    // Simulate controller ticks: same nodes, only Date.now() advances.
    for (let step = 1; step <= 4; step += 1) {
      vi.setSystemTime(1_000_000 + step * 3000);
      app.setProps(props);
      expect(app.render(120)).toEqual(
        makeApp({ agents, selectedAgentId: 'a1' }, 30, 120).render(120),
      );
    }
  });

  it('reflects in-place node mutations after a revision bump', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const agents = sampleAgents();
    const props = makeProps({ agents, selectedAgentId: 'a1' });
    const app = new WorkflowsBrowserApp(props, fakeTerminal(30, 120));
    app.render(120);

    // Simulate a tracker write: in-place mutation plus revision bump.
    const coder = agents.find((a) => a.agentId === 'a1')!;
    coder.activity.push({
      kind: 'tool',
      tool: { id: 'tc-new', name: 'Glob', argsText: '{"pattern":"**/*.ts"}', status: 'running', resultText: undefined },
    });
    coder.revision += 1;
    app.setProps(props);

    const expected = makeApp({ agents, selectedAgentId: 'a1' }, 30, 120).render(120);
    expect(app.render(120)).toEqual(expected);
    expect(strip(app.render(120).join('\n'))).toContain('Glob');
  });

  it('rebuilds memoized lines after invalidate() (theme-change path)', () => {
    const agents = sampleAgents();
    const props = makeProps({ agents, selectedAgentId: 'a1' });
    const app = new WorkflowsBrowserApp(props, fakeTerminal(30, 120));
    app.render(120);

    const caches = app as unknown as { activityCache: object; treeRowCache: object };
    const activityCacheBefore = caches.activityCache;
    const treeRowCacheBefore = caches.treeRowCache;

    const previousPalette = currentTheme.palette;
    try {
      currentTheme.setPalette({ ...previousPalette, primary: '#ff0000' });
      app.invalidate();
      // The memo caches were dropped (they hold palette-baked strings)…
      expect(caches.activityCache).not.toBe(activityCacheBefore);
      expect(caches.treeRowCache).not.toBe(treeRowCacheBefore);
      // …and the re-render matches a fresh component on the new palette.
      expect(app.render(120)).toEqual(makeApp({ agents, selectedAgentId: 'a1' }, 30, 120).render(120));
    } finally {
      currentTheme.setPalette(previousPalette);
    }
  });

  it('skips the 1s repaint only when every agent is frozen', () => {
    vi.useFakeTimers();
    const tracker = new WorkflowTracker();
    const requestRender = vi.fn();
    const state: {
      workflowsBrowser: unknown;
      terminal: unknown;
      ui: unknown;
      editor: unknown;
      editorContainer: { children: unknown[] };
    } = {
      workflowsBrowser: undefined,
      terminal: fakeTerminal(30, 120),
      editorContainer: { children: [] },
      ui: {
        children: [] as unknown[],
        clear() {
          (this as { children: unknown[] }).children = [];
        },
        addChild(c: unknown) {
          (this as { children: unknown[] }).children.push(c);
        },
        setFocus: () => {},
        requestRender,
        requestCollapseRender: vi.fn(),
      },
      editor: {},
    };
    const host = {
      state,
      workflowTracker: tracker,
      hasBlockingEditorSlotPanel: () => false,
      setWorkflowsBrowser(value: unknown) {
        state.workflowsBrowser = value;
      },
    };
    const controller = new WorkflowsBrowserController(
      host as unknown as ConstructorParameters<typeof WorkflowsBrowserController>[0],
    );
    try {
      // A running agent has no endedAt → ticks keep repainting.
      tracker.handleEvent(ev({ type: 'turn.started', turnId: 1, origin: { kind: 'user' } }));
      controller.show();
      requestRender.mockClear();
      vi.advanceTimersByTime(2500);
      const ticksWhileRunning = requestRender.mock.calls.length;
      expect(ticksWhileRunning).toBeGreaterThan(0);

      // End the turn: the main agent gets an endedAt → frame is frozen.
      tracker.handleEvent(ev({ type: 'turn.ended', agentId: 'main', turnId: 1, reason: 'completed' }));
      requestRender.mockClear();
      vi.advanceTimersByTime(3000);
      expect(requestRender).not.toHaveBeenCalled();

      // A new event (real change) still flows through the subscription.
      tracker.handleEvent(ev({ type: 'turn.started', turnId: 2, origin: { kind: 'user' } }));
      expect(requestRender).toHaveBeenCalled();
    } finally {
      controller.close();
    }
  });
});

// ---------------------------------------------------------------------------
// WorkflowsBrowserApp — pane scrollbar (hover-revealed, right border)
// ---------------------------------------------------------------------------

describe('WorkflowsBrowserApp — scrollbar', () => {
  // The track is the scroll frame's inner rows (component rows 2..) on the
  // screen's last column (120). The list-mode preview caps its content
  // (flat variant: last 8 activity entries), so a 20-row terminal makes it
  // scroll; the full-width detail view renders all 40 tool entries.
  function longAgent(): WorkflowAgentNode {
    return node({
      agentId: 'a1',
      name: 'coder',
      parentAgentId: 'main',
      status: 'running',
      thinkingText: Array.from({ length: 40 }, (_, i) => `thought-${i}`).join('\n'),
      activity: Array.from({ length: 40 }, (_, i) => ({
        kind: 'tool' as const,
        tool: {
          id: `tc-${i}`,
          name: `Tool${String(i).padStart(2, '0')}`,
          argsText: '{}',
          status: 'done' as const,
          resultText: 'ok',
        },
      })),
    });
  }
  function makeScrollableApp(rows = 20) {
    const app = makeApp({ agents: [longAgent()], selectedAgentId: 'a1' }, rows, 120);
    app.render(120);
    return app;
  }
  const press = (col: number, row: number) =>
    ({ type: 'press' as const, button: 0, col, row, slotRelative: false });
  const release = (col: number, row: number) =>
    ({ type: 'release' as const, button: 0, col, row, slotRelative: false });

  it('list mode: zone declared while the preview scrolls; press jumps', () => {
    const app = makeScrollableApp(); // inner rows 16, preview content 19
    const zones = [...app.hitZones()];
    expect(zones.find((z) => z.id === 'scrollbar')).toMatchObject({ row: 2, col: 120, width: 1, height: 16 });

    // Tail-pinned by default: the preview tail (last tool) is visible.
    let out = strip(app.render(120).join('\n'));
    expect(out).toContain('Tool39');

    app.handleMouse(press(120, 2)); // track top → window top
    out = strip(app.render(120).join('\n'));
    expect(out).not.toContain('Tool39');
    app.handleMouse(release(120, 2));
  });

  it('list mode: reveal on hover; drag maps continuously until release', () => {
    const app = makeScrollableApp();
    expect(strip(app.render(120).join('\n'))).not.toContain('░');
    app.setHoveredZone('scrollbar');
    const shown = app.render(120).map(strip);
    expect(shown[17]!.endsWith('█')).toBe(true); // tail-pinned: thumb at the bottom
    expect(shown[2]!.endsWith('░')).toBe(true);
    app.setHoveredZone(null);
    expect(strip(app.render(120).join('\n'))).not.toContain('░');

    app.handleMouse(press(120, 17));
    app.handleMouse({ type: 'motion', button: 0, col: 120, row: 2, slotRelative: false });
    const out = strip(app.render(120).join('\n'));
    expect(out).not.toContain('Tool39');
    app.handleMouse(release(120, 2));
    // Plain motion afterwards does not scroll.
    app.handleMouse({ type: 'motion', button: 3, col: 120, row: 17, slotRelative: false });
    expect(strip(app.render(120).join('\n'))).not.toContain('Tool39');
  });

  it('detail mode: scrollbar drives the full-width chain', () => {
    const app = makeScrollableApp(30); // inner rows 26, detail content 123
    app.handleInput('\x1B[C'); // enter detail
    app.render(120);
    const zones = [...app.hitZones()];
    expect(zones.find((z) => z.id === 'scrollbar')).toMatchObject({ row: 2, col: 120, width: 1, height: 26 });

    let out = strip(app.render(120).join('\n'));
    expect(out).toContain('Tool39');
    expect(out).not.toContain('Tool00');

    app.handleMouse(press(120, 2)); // track top → chain top
    out = strip(app.render(120).join('\n'));
    expect(out).toContain('Tool00');
    expect(out).not.toContain('Tool39');
    app.handleMouse(release(120, 2));
  });

  it('no zone when the pane fits its window', () => {
    const app = makeApp({ agents: sampleAgents(), selectedAgentId: 'a1' }, 30, 120);
    app.render(120);
    expect([...app.hitZones()].some((z) => z.id === 'scrollbar')).toBe(false);
  });
});
