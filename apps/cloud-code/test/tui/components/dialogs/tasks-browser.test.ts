/**
 * Keyboard tests for TasksBrowserApp: PgUp/PgDn page the output preview
 * (tail-follow re-engages at the bottom) and Home/End jump the task
 * selection to the first/last row.
 */

import type { BackgroundTaskInfo, BackgroundTaskStatus } from '@cloud-code/sdk';
import type { Terminal } from '@cloud-code/pi-tui';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { TasksBrowserApp, type TasksBrowserProps } from '#/tui/components/dialogs/tasks-browser';
import { setLocalePreference } from '#/tui/i18n';

const strip = (s: string): string => s.replaceAll(/\[[0-9;]*m/g, '');
const ESC = String.fromCodePoint(27);
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
      tasks: [
        processTask('tsk_alpha', 'running'),
        processTask('tsk_beta', 'completed'),
        processTask('tsk_gamma', 'completed'),
      ],
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

describe('TasksBrowserApp keyboard', () => {
  beforeAll(() => {
    setLocalePreference('en');
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
  });
  afterAll(() => {
    setLocalePreference('auto');
    vi.useRealTimers();
  });

  it('Home/End jump the selection to the first/last task', () => {
    const { browser, onSelect } = makeBrowser();
    onSelect.mockClear();

    browser.handleInput(`${ESC}[F`); // End → last task
    expect(onSelect).toHaveBeenCalledWith('tsk_gamma');

    browser.handleInput(`${ESC}[H`); // Home → first task
    expect(onSelect).toHaveBeenCalledWith('tsk_alpha');
  });

  it('PgUp/PgDn page the output preview and re-engage tail-follow at the bottom', () => {
    const tailOutput = Array.from({ length: 40 }, (_, i) => `output line ${String(i)}`).join('\n');
    const { browser } = makeBrowser({ tailOutput });

    // Tail-pinned by default: the last line is on screen, the first is not.
    let out = strip(browser.render(80).join('\n'));
    expect(out).toContain('output line 39');
    expect(out).not.toContain('output line 0');

    // Page up to the top (24 rows → 12 visible preview rows, 11-row pages).
    browser.handleInput(`${ESC}[5~`);
    browser.handleInput(`${ESC}[5~`);
    browser.handleInput(`${ESC}[5~`);
    out = strip(browser.render(80).join('\n'));
    expect(out).toContain('output line 0');
    expect(out).not.toContain('output line 39');

    // Page back down: parking at the bottom re-engages the tail follow.
    browser.handleInput(`${ESC}[6~`);
    browser.handleInput(`${ESC}[6~`);
    browser.handleInput(`${ESC}[6~`);
    out = strip(browser.render(80).join('\n'));
    expect(out).toContain('output line 39');
  });
});
