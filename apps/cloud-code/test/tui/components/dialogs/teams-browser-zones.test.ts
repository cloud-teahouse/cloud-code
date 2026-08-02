/**
 * Hit-zone tests for TeamsBrowserApp: team-row zones align with the rendered
 * rows, zone presses select (a re-click on the selected row is a no-op),
 * hover underlines and clears, and the two full-height pane zones route the
 * wheel (list = selection, detail = content scroll). Dispatch helpers mirror
 * what the TUI does with the declared zones (see choice-picker-zones.test.ts).
 */

import type { TeamWire } from '@cloud-code/sdk';
import type { Terminal } from '@cloud-code/pi-tui';
import chalk from 'chalk';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { hitZoneAt, type MouseEvent } from '@cloud-code/pi-tui';

import { TeamsBrowserApp, type TeamsBrowserProps } from '#/tui/components/dialogs/teams-browser';
import { setLocalePreference } from '#/tui/i18n';

const strip = (s: string): string => s.replaceAll(/\u001B\[[0-9;]*m/g, '');

const stubTerminal = (rows = 24): Terminal => ({ rows }) as unknown as Terminal;

function team(name: string, taskCount: number): TeamWire {
  return {
    name,
    createdBy: 'main',
    members: [
      { name: 'lead', agentId: `${name}-lead` },
      { name: 'worker', agentId: `${name}-worker` },
    ],
    tasks: Array.from({ length: taskCount }, (_, i) => ({
      id: i + 1,
      subject: `task ${String(i + 1)} of ${name}`,
      status: i % 2 === 0 ? 'completed' : 'in_progress',
      owner: 'lead',
    })),
  } as unknown as TeamWire;
}

function makeBrowser(over: Partial<TeamsBrowserProps> = {}) {
  const onSelect = vi.fn();
  const browser = new TeamsBrowserApp(
    {
      teams: [team('core', 2), team('infra', 1)],
      activity: [],
      memberLiveness: new Map([['core-worker', 'running']]),
      selectedTeamName: 'core',
      onSelect,
      onCancel: vi.fn(),
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
function dispatchPress(browser: TeamsBrowserApp, row: number, col = 1): void | boolean {
  const zone = hitZoneAt(browser.hitZones(), row, col, 'action');
  if (zone === null) return false;
  return browser.onHitZone(zone.id, pressEvent(row, col));
}

/** The hover update the TUI performs for pointer motion at a component-relative cell. */
function dispatchHover(browser: TeamsBrowserApp, row: number, col = 1): void | boolean {
  const zone = row < 0 ? null : hitZoneAt(browser.hitZones(), row, col, 'hover');
  return browser.setHoveredZone(zone?.id ?? null);
}

/** Takeover wheel events carry a 1-based screen row (the zone lookup subtracts one). */
function wheel(browser: TeamsBrowserApp, button: 64 | 65, row: number, col: number): void | boolean {
  return browser.handleMouse({ type: 'wheel', button, col, row, slotRelative: false });
}

describe('TeamsBrowserApp hit zones', () => {
  const prevLevel = chalk.level;
  beforeAll(() => {
    chalk.level = 1;
    setLocalePreference('en');
  });
  afterAll(() => {
    chalk.level = prevLevel;
    setLocalePreference('auto');
  });

  // Layout (width 80, 24 rows): 0 header, 1 list-frame top border, 2-3 team
  // rows, 23 footer; the detail pane starts at column 26.
  it('declares one zone per visible team row plus the two wheel-routing panes', () => {
    const { browser } = makeBrowser();
    const lines = browser.render(80).map(strip);
    const zones = [...browser.hitZones()];
    expect(zones.map((zone) => zone.id)).toEqual([0, 1, 'pane:list', 'pane:detail']);
    expect(zones[0]).toMatchObject({ row: 2, col: 1, width: 25, height: 1 });
    expect(zones[1]).toMatchObject({ row: 3, col: 1, width: 25, height: 1 });
    expect(lines[2]).toContain('core');
    expect(lines[3]).toContain('infra');
    expect(zones[2]).toMatchObject({ row: 0, col: 1, width: 25, height: 24 });
    expect(zones[3]).toMatchObject({ row: 0, col: 26, width: 55, height: 24 });
  });

  it('dispatches a row press: select; a re-click on the selected row is a no-op', () => {
    const { browser, onSelect } = makeBrowser();
    const text = (): string => strip(browser.render(80).join('\n'));

    expect(dispatchPress(browser, 3)).not.toBe(false); // infra row
    expect(onSelect).toHaveBeenCalledWith('infra');
    expect(text()).toContain('❯ ○ infra');

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

  it('underlines the hovered team row and clears on leave', () => {
    const { browser } = makeBrowser();
    const baseline = browser.render(80).join('\n');

    expect(dispatchHover(browser, 3)).not.toBe(false); // infra row
    expect(browser.render(80).join('\n')).toContain('[4m');
    expect(dispatchHover(browser, 3)).toBe(false); // unchanged → frame skipped

    dispatchHover(browser, -1);
    expect(browser.render(80).join('\n')).toBe(baseline);
  });

  it('routes the wheel by pane: list scrolls the selection, detail scrolls the content', () => {
    const { browser, onSelect } = makeBrowser({ teams: [team('core', 30), team('infra', 1)] });
    const text = (): string => strip(browser.render(80).join('\n'));

    // Wheel down over the list pane moves the selection.
    expect(wheel(browser, 65, 3, 2)).not.toBe(false);
    expect(onSelect).toHaveBeenCalledWith('infra');

    // Back to the tall team; the tail-pinned detail shows the scroll range.
    // (The shared-task table adds a header + rule row, so 30 tasks make 40
    // content lines.)
    expect(wheel(browser, 64, 3, 2)).not.toBe(false);
    expect(onSelect).toHaveBeenLastCalledWith('core');
    const baseline = text();
    expect(baseline).toContain('21-40 of 40');

    // Wheel up over the detail pane scrolls the content, not the selection;
    // wheeling back down re-engages the tail follow byte-for-byte.
    expect(wheel(browser, 64, 10, 40)).not.toBe(false);
    expect(onSelect).toHaveBeenCalledTimes(2);
    expect(text()).toContain('18-37 of 40');
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
