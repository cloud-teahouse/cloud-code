/**
 * Hit-zone tests for GoalQueueManagerComponent: goal-row zones align with the
 * rendered rows, zone presses move the cursor without firing queue actions
 * (a re-click on the selected row is a no-op), hover underlines and clears,
 * the wheel is suppressed in reorder mode and presses are suppressed while a
 * queue action is in flight. Dispatch helpers mirror what the TUI does with
 * the declared zones (see choice-picker-zones.test.ts).
 */

import chalk from 'chalk';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { hitZoneAt, type MouseEvent } from '@cloud-code/pi-tui';

import {
  GoalQueueManagerComponent,
  type GoalQueueManagerOptions,
} from '#/tui/components/dialogs/goal-queue-manager';
import type { GoalQueueSnapshot, UpcomingGoal } from '#/tui/goal-queue-store';
import { setLocalePreference } from '#/tui/i18n';

const strip = (s: string): string => s.replaceAll(/\[[0-9;]*m/g, '');

function goal(id: string): UpcomingGoal {
  return {
    id,
    objective: `objective ${id}: keep the build green`,
    createdAt: '2026-06-03T00:00:00.000Z',
    updatedAt: '2026-06-03T00:00:00.000Z',
  };
}

function makeManager(over: Partial<GoalQueueManagerOptions> = {}) {
  const onAction = vi.fn();
  const manager = new GoalQueueManagerComponent({
    goals: [goal('g1'), goal('g2'), goal('g3')],
    onAction,
    onCancel: vi.fn(),
    ...over,
  });
  manager.render(80);
  return { manager, onAction };
}

function pressEvent(row: number, col = 1): MouseEvent {
  return { type: 'press', button: 0, col, row, slotRelative: false };
}

/** The dispatch the TUI performs for a left-press at a component-relative cell. */
function dispatchPress(manager: GoalQueueManagerComponent, row: number, col = 1): void | boolean {
  const zone = hitZoneAt(manager.hitZones(), row, col, 'action');
  if (zone === null) return false;
  return manager.onHitZone(zone.id, pressEvent(row, col));
}

/** The hover update the TUI performs for pointer motion at a component-relative cell. */
function dispatchHover(manager: GoalQueueManagerComponent, row: number, col = 1): void | boolean {
  const zone = row < 0 ? null : hitZoneAt(manager.hitZones(), row, col, 'hover');
  return manager.setHoveredZone(zone?.id ?? null);
}

describe('GoalQueueManagerComponent hit zones', () => {
  const prevLevel = chalk.level;
  beforeAll(() => {
    chalk.level = 1;
    setLocalePreference('en');
  });
  afterAll(() => {
    chalk.level = prevLevel;
    setLocalePreference('auto');
  });

  // Layout (width 80): 0 divider, 1 title, 2 hint, 3 blank, 4-6 goal rows,
  // 7 blank, 8 divider.
  it('declares one full-width zone per goal row', () => {
    const { manager } = makeManager();
    const lines = manager.render(80).map(strip);
    const zones = [...manager.hitZones()];
    expect(zones.map((zone) => zone.id)).toEqual([0, 1, 2]);
    for (const [i, zone] of zones.entries()) {
      expect(zone).toMatchObject({ row: 4 + i, col: 1, width: 80, height: 1 });
      expect(lines[zone.row]).toContain(`objective g${String(i + 1)}`);
    }
  });

  it('dispatches a row press: move the cursor, never a queue action', () => {
    const { manager, onAction } = makeManager();
    const text = (): string => strip(manager.render(80).join('\n'));

    expect(dispatchPress(manager, 5)).not.toBe(false); // g2 row
    expect(text()).toContain('❯ 2. objective g2');
    expect(onAction).not.toHaveBeenCalled();

    expect(dispatchPress(manager, 5)).toBe(false); // already selected → no-op
  });

  it('misses zones for presses on the header, blank, and divider rows', () => {
    const { manager, onAction } = makeManager();
    for (const row of [0, 1, 2, 3, 7, 8]) {
      expect(dispatchPress(manager, row)).toBe(false);
    }
    expect(onAction).not.toHaveBeenCalled();
  });

  it('underlines the hovered goal row and clears on leave', () => {
    const { manager } = makeManager();
    const baseline = manager.render(80).join('\n');

    expect(dispatchHover(manager, 6)).not.toBe(false); // g3 row
    expect(manager.render(80).join('\n')).toContain('[4m');
    expect(dispatchHover(manager, 6)).toBe(false); // unchanged → frame skipped

    dispatchHover(manager, -1);
    expect(manager.render(80).join('\n')).toBe(baseline);
  });

  it('suppresses the wheel in reorder mode but still allows presses', () => {
    const { manager, onAction } = makeManager();
    const text = (): string => strip(manager.render(80).join('\n'));
    manager.handleInput(' '); // arms reorder mode on g1
    expect(text()).toContain('↑↓ reorder');

    expect(
      manager.handleMouse({ type: 'wheel', button: 65, col: 1, row: 1, slotRelative: false }),
    ).toBe(false);
    expect(text()).toContain('❯ 1. objective g1'); // the cursor did not move

    // A press only moves the cursor — reorder mode stays free of mutations.
    expect(dispatchPress(manager, 6)).not.toBe(false); // g3 row
    expect(text()).toContain('❯ 3. objective g3');
    expect(onAction).not.toHaveBeenCalled();
  });

  it('suppresses zone presses and the wheel while a queue action is in flight', async () => {
    let resolveAction: ((snapshot: GoalQueueSnapshot) => void) | undefined;
    const onAction = vi.fn(
      () => new Promise<GoalQueueSnapshot>((resolve) => (resolveAction = resolve)),
    );
    const { manager } = makeManager({ onAction });
    manager.handleInput('d'); // delete g1 — busy until the snapshot lands

    expect(dispatchPress(manager, 5)).toBe(false);
    expect(
      manager.handleMouse({ type: 'wheel', button: 65, col: 1, row: 1, slotRelative: false }),
    ).toBe(false);

    resolveAction?.({ goals: [goal('g2'), goal('g3')] });
    await vi.waitFor(() => {
      expect(strip(manager.render(80).join('\n'))).not.toContain('objective g1');
    });
    manager.render(80); // refresh the zone cache with the new rows
    expect(dispatchPress(manager, 5)).not.toBe(false); // g3 row
    expect(strip(manager.render(80).join('\n'))).toContain('❯ 2. objective g3');
  });

  it('keeps the wheel behavior on handleMouse outside reorder mode', () => {
    const { manager } = makeManager();
    const text = (): string => strip(manager.render(80).join('\n'));
    manager.handleMouse({ type: 'wheel', button: 65, col: 1, row: 1, slotRelative: false });
    expect(text()).toContain('❯ 2. objective g2');
    manager.handleMouse({ type: 'wheel', button: 64, col: 1, row: 1, slotRelative: false });
    expect(text()).toContain('❯ 1. objective g1');
  });
});
