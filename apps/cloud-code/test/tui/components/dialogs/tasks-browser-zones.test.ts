/**
 * Hit-zone tests for TasksBrowserApp: task-row zones align with the rendered
 * rows, zone presses select (a re-click on the selected row is a no-op),
 * hover underlines and clears, the armed stop-confirmation suppresses the row
 * zones, and the two full-height pane zones route the wheel (list =
 * selection, detail = preview scroll). Dispatch helpers mirror what the TUI
 * does with the declared zones (see choice-picker-zones.test.ts).
 */

import type { BackgroundTaskInfo, BackgroundTaskStatus } from '@cloud-code/sdk';
import type { Terminal } from '@cloud-code/pi-tui';
import chalk from 'chalk';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { hitZoneAt, type MouseEvent } from '@cloud-code/pi-tui';

import { TasksBrowserApp, type TasksBrowserProps } from '#/tui/components/dialogs/tasks-browser';
import { setLocalePreference } from '#/tui/i18n';

const strip = (s: string): string => s.replaceAll(/\u001B\[[0-9;]*m/g, '');
/** Fixed clock so the relative-time cells render deterministically. */
const FIXED_NOW = new Date('2026-06-15T12:00:00Z').getTime();

const stubTerminal = (rows = 24): Terminal => ({ rows }) as unknown as Terminal;

function processTask(taskId: string, status: BackgroundTaskStatus): BackgroundTaskInfo {
  return {
    taskId,
    kind: 'process',
    description: `index the ${taskId} workspace`,
    command: `indexer --root ${taskId}`,
    status,
    detached: true,
    startedAt: FIXED_NOW - 3_600_000,
    endedAt: status === 'running' ? null : FIXED_NOW - 60_000,
    pid: 4242,
    exitCode: status === 'completed' ? 0 : null,
  } as unknown as BackgroundTaskInfo;
}

function makeBrowser(over: Partial<TasksBrowserProps> = {}) {
  const onSelect = vi.fn();
  const browser = new TasksBrowserApp(
    {
      tasks: [processTask('tsk_alpha', 'running'), processTask('tsk_beta', 'completed')],
      filter: 'all',
      selectedTaskId: 'tsk_alpha',
      tailOutput: undefined,
      tailLoading: false,
      flashMessage: undefined,
      onSelect,
      onToggleFilter: vi.fn(),
      onRefresh: vi.fn(),
      onCancel: vi.fn(),
      onStopConfirmed: vi.fn(),
      onOpenOutput: vi.fn(),
      ...over,
    },
    stubTerminal(),
  );
  browser.render(80);
  return { browser, onSelect };
}

function pressEvent(row: number, col = 1): MouseEvent {
  return { type: 'press', button: 0, col, row, slotRelative: false };
}

/** The dispatch the TUI performs for a left-press at a component-relative cell. */
function dispatchPress(browser: TasksBrowserApp, row: number, col = 1): void | boolean {
  const zone = hitZoneAt(browser.hitZones(), row, col, 'action');
  if (zone === null) return false;
  return browser.onHitZone(zone.id, pressEvent(row, col));
}

/** The hover update the TUI performs for pointer motion at a component-relative cell. */
function dispatchHover(browser: TasksBrowserApp, row: number, col = 1): void | boolean {
  const zone = row < 0 ? null : hitZoneAt(browser.hitZones(), row, col, 'hover');
  return browser.setHoveredZone(zone?.id ?? null);
}

/** Takeover wheel events carry a 1-based screen row (the zone lookup subtracts one). */
function wheel(browser: TasksBrowserApp, button: 64 | 65, row: number, col: number): void | boolean {
  return browser.handleMouse({ type: 'wheel', button, col, row, slotRelative: false });
}

describe('TasksBrowserApp hit zones', () => {
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

  // Layout (width 80, 24 rows): 0 header, 1 list-frame top border, 2-3 task
  // rows, 23 footer; the right stack starts at column 29.
  it('declares one zone per visible task row plus the two wheel-routing panes', () => {
    const { browser } = makeBrowser();
    const lines = browser.render(80).map(strip);
    const zones = [...browser.hitZones()];
    expect(zones.map((zone) => zone.id)).toEqual([0, 1, 'pane:list', 'pane:detail']);
    expect(zones[0]).toMatchObject({ row: 2, col: 1, width: 28, height: 1 });
    expect(zones[1]).toMatchObject({ row: 3, col: 1, width: 28, height: 1 });
    expect(lines[2]).toContain('tsk_alpha');
    expect(lines[3]).toContain('tsk_beta');
    expect(zones[2]).toMatchObject({ row: 0, col: 1, width: 28, height: 24 });
    expect(zones[3]).toMatchObject({ row: 0, col: 29, width: 52, height: 24 });
  });

  it('dispatches a row press: select; a re-click on the selected row is a no-op', () => {
    const { browser, onSelect } = makeBrowser();
    const text = (): string => strip(browser.render(80).join('\n'));

    expect(dispatchPress(browser, 3)).not.toBe(false); // tsk_beta row
    expect(onSelect).toHaveBeenCalledWith('tsk_beta');
    expect(text()).toContain('❯ tsk_beta');

    expect(dispatchPress(browser, 3)).toBe(false); // already selected → no-op
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('misses row targets for presses on the header, borders, and pane chrome', () => {
    const { browser, onSelect } = makeBrowser();
    for (const row of [0, 1, 10, 23]) {
      expect(dispatchPress(browser, row)).toBe(false);
    }
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('underlines the hovered task row and clears on leave', () => {
    const { browser } = makeBrowser();
    const baseline = browser.render(80).join('\n');

    expect(dispatchHover(browser, 3)).not.toBe(false); // tsk_beta row
    expect(browser.render(80).join('\n')).toContain('[4m');
    expect(dispatchHover(browser, 3)).toBe(false); // unchanged → frame skipped

    dispatchHover(browser, -1);
    expect(browser.render(80).join('\n')).toBe(baseline);
  });

  it('suppresses the row zones while the stop confirmation is armed', () => {
    const onStopConfirmed = vi.fn();
    const { browser, onSelect } = makeBrowser({ onStopConfirmed });
    browser.handleInput('s'); // arms the inline stop confirm on tsk_alpha
    browser.render(80);
    expect([...browser.hitZones()].filter((zone) => typeof zone.id === 'number')).toHaveLength(0);
    expect(dispatchPress(browser, 2)).toBe(false);
    expect(wheel(browser, 65, 3, 2)).toBe(false);
    expect(onSelect).not.toHaveBeenCalled();

    browser.handleInput('y'); // confirms; the row zones come back with the state
    expect(onStopConfirmed).toHaveBeenCalledWith('tsk_alpha');
    browser.render(80);
    expect([...browser.hitZones()].filter((zone) => typeof zone.id === 'number')).toHaveLength(2);
  });

  it('routes the wheel by pane: list scrolls the selection, detail scrolls the preview', () => {
    const tailOutput = Array.from({ length: 20 }, (_, i) => `tail-${String(i + 1).padStart(2, '0')}`).join('\n');
    const { browser, onSelect } = makeBrowser({ tailOutput });
    const text = (): string => strip(browser.render(80).join('\n'));

    // Wheel down over the list pane moves the selection.
    expect(wheel(browser, 65, 3, 2)).not.toBe(false);
    expect(onSelect).toHaveBeenCalledWith('tsk_beta');
    expect(text()).toContain('❯ tsk_beta');

    // The preview is tail-pinned: the oldest lines are out of the window.
    expect(text()).toContain('tail-20');
    expect(text()).not.toContain('tail-06');
    // Wheel up over the detail pane scrolls the preview, not the selection.
    expect(wheel(browser, 64, 10, 40)).not.toBe(false);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(text()).toContain('tail-06');
    expect(text()).not.toContain('tail-20');
  });

  it('declares no zones when the terminal is too small', () => {
    const { browser } = makeBrowser();
    const lines = browser.render(40); // below the 48-column minimum
    expect(strip(lines.join('\n'))).toContain('Terminal too small');
    expect([...browser.hitZones()]).toHaveLength(0);
  });
});
