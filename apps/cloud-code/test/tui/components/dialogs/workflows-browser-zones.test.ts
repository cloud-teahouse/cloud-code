/**
 * Hit-zone tests for WorkflowsBrowserApp: tree-row and collapse-toggle zones
 * align with the rendered rows, zone presses select / collapse / drill into
 * the detail view (which declares no zones), hover underlines and clears, and
 * the two full-height pane zones route the wheel (tree = selection, detail =
 * preview scroll). Dispatch helpers mirror what the TUI does with the
 * declared zones (see choice-picker-zones.test.ts).
 */

import type { Terminal } from '@cloud-code/pi-tui';
import chalk from 'chalk';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { hitZoneAt, type MouseEvent } from '@cloud-code/pi-tui';

import { WorkflowsBrowserApp, type WorkflowsBrowserProps } from '#/tui/components/dialogs/workflows-browser';
import type { WorkflowAgentNode } from '#/tui/controllers/workflows-tracker';
import { setLocalePreference } from '#/tui/i18n';

const strip = (s: string): string => s.replaceAll(/\[[0-9;]*m/g, '');
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
    status: 'done',
    statusDetail: undefined,
    model: 'kimi-k2',
    step: 3,
    startedAt: FIXED_NOW - 120_000,
    endedAt: FIXED_NOW - 60_000,
    usage: undefined,
    contextTokens: undefined,
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
        workflowNode('agent-worker', { parentAgentId: 'main' }),
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

function pressEvent(row: number, col = 1): MouseEvent {
  return { type: 'press', button: 0, col, row, slotRelative: false };
}

/** The dispatch the TUI performs for a left-press at a component-relative cell. */
function dispatchPress(browser: WorkflowsBrowserApp, row: number, col = 1): void | boolean {
  const zone = hitZoneAt(browser.hitZones(), row, col, 'action');
  if (zone === null) return false;
  return browser.onHitZone(zone.id, pressEvent(row, col));
}

/** The hover update the TUI performs for pointer motion at a component-relative cell. */
function dispatchHover(browser: WorkflowsBrowserApp, row: number, col = 1): void | boolean {
  const zone = row < 0 ? null : hitZoneAt(browser.hitZones(), row, col, 'hover');
  return browser.setHoveredZone(zone?.id ?? null);
}

/** Takeover wheel events carry a 1-based screen row (the zone lookup subtracts one). */
function wheel(browser: WorkflowsBrowserApp, button: 64 | 65, row: number, col: number): void | boolean {
  return browser.handleMouse({ type: 'wheel', button, col, row, slotRelative: false });
}

describe('WorkflowsBrowserApp hit zones', () => {
  const prevLevel = chalk.level;
  beforeAll(() => {
    chalk.level = 1;
    setLocalePreference('en');
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
  });
  afterAll(() => {
    chalk.level = prevLevel;
    setLocalePreference('auto');
    vi.useRealTimers();
  });

  // Layout (width 80, 24 rows): 0 header, 1 tree-frame top border, 2 main
  // row (with the collapse glyph), 3 agent-worker row, 23 footer; the chain
  // pane starts at column 29.
  it('declares row and toggle zones per tree row plus the two wheel-routing panes', () => {
    const { browser } = makeBrowser();
    const lines = browser.render(80).map(strip);
    const zones = [...browser.hitZones()];
    expect(zones.map((zone) => zone.id)).toEqual(['toggle:0', 0, 1, 'pane:tree', 'pane:detail']);
    expect(zones[0]).toMatchObject({ row: 2, col: 4, width: 2, height: 1 });
    expect(zones[1]).toMatchObject({ row: 2, col: 1, width: 28, height: 1 });
    expect(zones[2]).toMatchObject({ row: 3, col: 1, width: 28, height: 1 });
    expect(lines[2]).toContain('▾');
    expect(lines[2]).toContain('main');
    expect(lines[3]).toContain('agent-worker');
    expect(zones[3]).toMatchObject({ row: 0, col: 1, width: 28, height: 24 });
    expect(zones[4]).toMatchObject({ row: 0, col: 29, width: 52, height: 24 });
  });

  it('collapses and re-expands a subtree via the toggle zone', () => {
    const { browser, onSelect } = makeBrowser();
    const text = (): string => strip(browser.render(80).join('\n'));

    expect(dispatchPress(browser, 2, 4)).not.toBe(false); // the ▾ glyph cell
    expect(onSelect).not.toHaveBeenCalled(); // toggling never selects
    expect(text()).not.toContain('agent-worker');

    expect(dispatchPress(browser, 2, 4)).not.toBe(false); // the ▸ glyph cell
    expect(text()).toContain('agent-worker');
  });

  it('dispatches a row press: select, then re-click drills into the detail view', () => {
    const { browser, onSelect } = makeBrowser();
    const text = (): string => strip(browser.render(80).join('\n'));

    expect(dispatchPress(browser, 3)).not.toBe(false); // agent-worker row
    expect(onSelect).toHaveBeenCalledWith('agent-worker');

    expect(dispatchPress(browser, 3)).not.toBe(false); // re-click drills in
    browser.render(80); // the post-input render refreshes the zone cache
    expect([...browser.hitZones()]).toHaveLength(0); // detail mode declares none
    expect(dispatchPress(browser, 3)).toBe(false); // presses no-op there
    expect(wheel(browser, 64, 5, 5)).not.toBe(false); // its wheel scrolls anywhere

    browser.handleInput(`${ESC}[D`); // ← returns to the list
    browser.render(80);
    expect([...browser.hitZones()].length).toBeGreaterThan(0);
    expect(text()).toContain('agent-worker');
  });

  it('underlines the hovered tree row and clears on leave', () => {
    const { browser } = makeBrowser();
    const baseline = browser.render(80).join('\n');

    expect(dispatchHover(browser, 3)).not.toBe(false); // agent-worker row
    expect(browser.render(80).join('\n')).toContain('[4m');
    expect(dispatchHover(browser, 3)).toBe(false); // unchanged → frame skipped

    dispatchHover(browser, -1);
    expect(browser.render(80).join('\n')).toBe(baseline);
  });

  it('routes the wheel by pane: tree scrolls the selection, detail scrolls the preview', () => {
    const activity = Array.from({ length: 30 }, (_, i) => ({
      kind: 'thinking' as const,
      text: `thought ${String(i + 1)}`,
    }));
    // A 12-row terminal: the flat preview caps at 8 entries (see
    // workflows-agent-content), so only a short pane makes it scrollable.
    const { browser, onSelect } = makeBrowser(
      {
        agents: [
          workflowNode('main', { status: 'running', endedAt: undefined, activity }),
          workflowNode('agent-worker', { parentAgentId: 'main' }),
        ],
      },
      12,
    );
    const text = (): string => strip(browser.render(80).join('\n'));

    // Wheel down over the tree pane moves the selection.
    expect(wheel(browser, 65, 3, 2)).not.toBe(false);
    expect(onSelect).toHaveBeenCalledWith('agent-worker');
    expect(wheel(browser, 64, 3, 2)).not.toBe(false);
    expect(onSelect).toHaveBeenLastCalledWith('main');

    // The preview is tail-pinned; wheeling up over the chain pane scrolls it,
    // and wheeling back down re-engages the tail follow byte-for-byte.
    const baseline = text();
    expect(wheel(browser, 64, 10, 40)).not.toBe(false);
    expect(onSelect).toHaveBeenCalledTimes(2);
    expect(text()).not.toBe(baseline);
    expect(wheel(browser, 65, 10, 40)).not.toBe(false);
    expect(text()).toBe(baseline);
  });

  it('declares no zones when the terminal is too small', () => {
    const { browser } = makeBrowser();
    const lines = browser.render(40); // below the 48-column minimum
    expect(strip(lines.join('\n'))).toContain('Terminal too small');
    expect([...browser.hitZones()]).toHaveLength(0);
  });
});
