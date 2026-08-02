/**
 * Hit-zone tests for ChoicePickerComponent: zone alignment with the rendered
 * option rows (descriptions included), zone dispatch (select / re-click
 * confirm, search-box focus), and hover underline. Dispatch helpers mirror
 * what the TUI does with the declared zones (see approval-panel-zones.test.ts).
 */

import chalk from 'chalk';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { hitZoneAt, type MouseEvent } from '@cloud-code/pi-tui';

import { ChoicePickerComponent, type ChoicePickerOptions } from '#/tui/components/dialogs/choice-picker';
import { DIALOG_SEARCH_ZONE } from '#/tui/components/dialogs/frame/dialog-frame';
import { setLocalePreference } from '#/tui/i18n';

const strip = (s: string): string => s.replaceAll(/\[[0-9;]*m/g, '');

function makePicker(over: Partial<ChoicePickerOptions> = {}) {
  const onSelect = vi.fn();
  const picker = new ChoicePickerComponent({
    title: 'Pick one',
    options: [
      { value: 'a', label: 'Alpha' },
      { value: 'b', label: 'Beta' },
      { value: 'c', label: 'Gamma' },
    ],
    onSelect,
    onCancel: vi.fn(),
    ...over,
  });
  picker.render(80);
  return { picker, onSelect };
}

function pressEvent(row: number, col = 1): MouseEvent {
  return { type: 'press', button: 0, col, row, slotRelative: false };
}

/** The dispatch the TUI performs for a left-press at a component-relative cell. */
function dispatchPress(picker: ChoicePickerComponent, row: number, col = 1): void | boolean {
  const zone = hitZoneAt(picker.hitZones(), row, col, 'action');
  if (zone === null) return false;
  return picker.onHitZone(zone.id, pressEvent(row, col));
}

/** The hover update the TUI performs for pointer motion at a component-relative cell. */
function dispatchHover(picker: ChoicePickerComponent, row: number, col = 1): void | boolean {
  const zone = row < 0 ? null : hitZoneAt(picker.hitZones(), row, col, 'hover');
  return picker.setHoveredZone(zone?.id ?? null);
}

describe('ChoicePickerComponent hit zones', () => {
  const prevLevel = chalk.level;
  beforeAll(() => {
    chalk.level = 1;
    setLocalePreference('en');
  });
  afterAll(() => {
    chalk.level = prevLevel;
    setLocalePreference('auto');
  });

  // Layout (no search, width 80): 0 divider, 1 title, 2 hint, 3 blank,
  // 4-6 option rows, 7 blank, 8 divider.
  it('declares one full-width zone per option row', () => {
    const { picker } = makePicker();
    const lines = picker.render(80).map(strip);
    const zones = [...picker.hitZones()];
    expect(zones.map((zone) => zone.id)).toEqual([0, 1, 2]);
    for (const [i, zone] of zones.entries()) {
      expect(zone).toMatchObject({ row: 4 + i, col: 1, width: 80, height: 1 });
      expect(lines[zone.row]).toContain(['Alpha', 'Beta', 'Gamma'][i]!);
    }
  });

  it('grows the zone with the option description lines', () => {
    const { picker } = makePicker({
      options: [
        {
          value: 'a',
          label: 'Alpha',
          description:
            'Ask before commands, edits, and other risky actions, including destructive ones that cannot be undone.',
        },
        { value: 'b', label: 'Beta' },
      ],
    });
    const lines = picker.render(80).map(strip);
    const [withDesc, withoutDesc] = [...picker.hitZones()];
    expect(withDesc!.height).toBeGreaterThan(1); // label + wrapped description rows
    expect(withoutDesc!.height).toBe(1);
    // A press on a description row hits the same option as the label row.
    expect(lines[withDesc!.row + 1]).toContain('Ask before commands');
    expect(hitZoneAt([withDesc!], withDesc!.row + 1, 1, 'action')?.id).toBe(0);
  });

  it('dispatches an option press: highlight, then re-click confirms like Enter', () => {
    const { picker, onSelect } = makePicker();
    const text = (): string => strip(picker.render(80).join('\n'));

    expect(dispatchPress(picker, 5)).not.toBe(false); // Beta row
    expect(text()).toContain('❯ Beta');
    expect(onSelect).not.toHaveBeenCalled();

    dispatchPress(picker, 5); // re-click confirms
    expect(onSelect).toHaveBeenCalledWith('b');
  });

  it('misses zones for presses on the header, blank, and divider rows', () => {
    const { picker, onSelect } = makePicker();
    for (const row of [0, 1, 2, 3, 7, 8]) {
      expect(dispatchPress(picker, row)).toBe(false);
    }
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('focuses the search box via its zone', () => {
    const { picker } = makePicker({ searchable: true });
    picker.render(80);
    const searchZone = [...picker.hitZones()].find((zone) => zone.id === DIALOG_SEARCH_ZONE);
    expect(searchZone).toMatchObject({ row: 4, col: 1, width: 80, height: 3 });

    const focused = (): boolean =>
      picker.render(80).map(strip).some((l) => l.includes('Esc back to list'));
    expect(focused()).toBe(false);
    dispatchPress(picker, 5);
    expect(focused()).toBe(true);
  });

  it('underlines the hovered option and clears on leave', () => {
    const { picker } = makePicker();
    const baseline = picker.render(80).join('\n');

    expect(dispatchHover(picker, 6)).not.toBe(false); // Gamma row
    expect(picker.render(80).join('\n')).toContain('[4m');
    expect(dispatchHover(picker, 6)).toBe(false); // unchanged → frame skipped

    dispatchHover(picker, -1);
    expect(picker.render(80).join('\n')).toBe(baseline);
  });

  it('keeps the wheel behavior on handleMouse', () => {
    const { picker } = makePicker();
    const text = (): string => strip(picker.render(80).join('\n'));
    picker.handleMouse({ type: 'wheel', button: 65, col: 1, row: 1, slotRelative: false });
    expect(text()).toContain('❯ Beta');
    picker.handleMouse({ type: 'wheel', button: 64, col: 1, row: 1, slotRelative: false });
    expect(text()).toContain('❯ Alpha');
  });
});
