/**
 * Keyboard tests for WorkflowsBrowserApp: Home/End jump the tree selection
 * in list mode, and Home/End (or g/G) scroll the full-width detail view to
 * the top/bottom — the scroll-viewer idiom.
 */

import type { Terminal } from '@cloud-code/pi-tui';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { WorkflowsBrowserApp, type WorkflowsBrowserProps } from '#/tui/components/dialogs/workflows-browser';
import type { WorkflowAgentNode } from '#/tui/controllers/workflows-tracker';
import { setLocalePreference } from '#/tui/i18n';

const strip = (s: string): string => s.replaceAll(/\[[0-9;]*m/g, '');
const ESC = String.fromCodePoint(27);
/** Fixed clock so the running agent's elapsed time renders deterministically. */
const FIXED_NOW = new Date('2026-06-15T12:00:00Z').getTime();

const stubTerminal = (rows = 24): Terminal => ({ rows }) as unknown as Terminal;

function workflowNode(agentId: string, overrides: Partial<WorkflowAgentNode> = {}): WorkflowAgentNode {
  return {
    agentId,
    name: agentId,
    parentAgentId: undefined,
    parentToolCallId: undefined,
    swarmIndex: undefined,
    runInBackground: false,
    description: undefined,
    status: 'running',
    statusDetail: undefined,
    lastEventAt: undefined,
    currentActivity: undefined,
    model: 'kimi-k2',
    step: 3,
    startedAt: FIXED_NOW - 120_000,
    endedAt: undefined,
    usage: undefined,
    contextTokens: undefined,
    lastOutput: undefined,
    progress: undefined,
    taskId: undefined,
    teamName: undefined,
    taskSubject: undefined,
    thinkingText: '',
    thinkingTruncated: false,
    tools: [],
    toolCallCount: 0,
    activity: [{ kind: 'thinking', text: 'weighing the options' }],
    activityTruncated: false,
    resultSummary: undefined,
    revision: 1,
    ...overrides,
  };
}

function makeBrowser(over: Partial<WorkflowsBrowserProps> = {}, rows = 24) {
  const onSelect = vi.fn();
  const browser = new WorkflowsBrowserApp(
    {
      agents: [
        workflowNode('main', { status: 'running', endedAt: undefined }),
        workflowNode('agent-a', { parentAgentId: 'main' }),
        workflowNode('agent-b', { parentAgentId: 'main' }),
      ],
      selectedAgentId: 'main',
      onSelect,
      onCancel: vi.fn(),
      ...over,
    },
    stubTerminal(rows),
  );
  browser.render(80);
  return { browser, onSelect };
}

describe('WorkflowsBrowserApp keyboard', () => {
  beforeAll(() => {
    setLocalePreference('en');
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
  });
  afterAll(() => {
    setLocalePreference('auto');
    vi.useRealTimers();
  });

  it('Home/End jump the tree selection in list mode', () => {
    const { browser, onSelect } = makeBrowser();
    onSelect.mockClear();

    browser.handleInput(`${ESC}[F`); // End → last tree row
    expect(onSelect).toHaveBeenCalledWith('agent-b');

    browser.handleInput(`${ESC}[H`); // Home → first tree row
    expect(onSelect).toHaveBeenCalledWith('main');
  });

  it('Home/End (g/G) scroll the detail view to the top/bottom', () => {
    const activity = Array.from({ length: 40 }, (_, i) => ({
      kind: 'thinking' as const,
      text: `entry ${String(i)}`,
    }));
    const { browser } = makeBrowser({
      agents: [workflowNode('main', { status: 'running', endedAt: undefined, activity })],
    });

    browser.handleInput(`${ESC}[C`); // → drills into the detail view
    browser.handleInput('t'); // expand the preserved chain view
    // Tail-pinned on entry.
    let out = strip(browser.render(80).join('\n'));
    expect(out).toContain('entry 39');
    expect(out).not.toContain('entry 0');

    browser.handleInput('g'); // top of the detail view
    out = strip(browser.render(80).join('\n'));
    expect(out).toContain('ACTIVITY');
    expect(out).not.toContain('entry 39');

    browser.handleInput(`${ESC}[F`); // End → back to the tail
    out = strip(browser.render(80).join('\n'));
    expect(out).toContain('entry 39');
  });
});
