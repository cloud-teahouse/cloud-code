/**
 * Hit-zone tests for ExperimentsSelectorComponent: zone alignment with the
 * rendered feature rows (detail + description rows included), zone dispatch
 * (draft toggle, Apply button, search-box focus), and hover underline.
 * Dispatch helpers mirror what the TUI does with the declared zones (see
 * choice-picker-zones.test.ts).
 */

import type { ExperimentalFeatureState } from '@cloud-code/sdk';
import chalk from 'chalk';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { hitZoneAt, type HitZone, type MouseEvent } from '@cloud-code/pi-tui';

import {
  ExperimentsSelectorComponent,
  type ExperimentsSelectorOptions,
} from '#/tui/components/dialogs/experiments-selector';
import { DIALOG_SEARCH_ZONE } from '#/tui/components/dialogs/frame/dialog-frame';
import { setLocalePreference } from '#/tui/i18n';

const strip = (s: string): string => s.replaceAll(/\u001B\[[0-9;]*m/g, '');

function feature(overrides: Partial<ExperimentalFeatureState> = {}): ExperimentalFeatureState {
  return {
    id: 'micro_compaction',
    title: 'Micro compaction',
    description: 'Trim older tool results.',
    surface: 'core',
    env: 'CLOUD_CODE_EXPERIMENTAL_MICRO_COMPACTION',
    defaultEnabled: true,
    enabled: true,
    source: 'default',
    ...overrides,
  };
}

function makePicker(over: Partial<ExperimentsSelectorOptions> = {}) {
  const onApply = vi.fn();
  const picker = new ExperimentsSelectorComponent({
    features: [
      feature({ id: 'first_feature', title: 'First feature', description: 'First detail.' }),
      feature({ id: 'second_feature', title: 'Second feature', description: 'Second detail.' }),
      feature({ id: 'third_feature', title: 'Third feature', description: 'Third detail.' }),
    ],
    onApply,
    onCancel: vi.fn(),
    ...over,
  });
  picker.render(120);
  return { picker, onApply };
}

function pressEvent(row: number, col = 1): MouseEvent {
  return { type: 'press', button: 0, col, row, slotRelative: false };
}

/** The dispatch the TUI performs for a left-press at a component-relative cell. */
function dispatchPress(picker: ExperimentsSelectorComponent, row: number, col = 1): void | boolean {
  const zone = hitZoneAt(picker.hitZones(), row, col, 'action');
  if (zone === null) return false;
  return picker.onHitZone(zone.id, pressEvent(row, col));
}

/** The hover update the TUI performs for pointer motion at a component-relative cell. */
function dispatchHover(picker: ExperimentsSelectorComponent, row: number, col = 1): void | boolean {
  const zone = row < 0 ? null : hitZoneAt(picker.hitZones(), row, col, 'hover');
  return picker.setHoveredZone(zone?.id ?? null);
}

describe('ExperimentsSelectorComponent hit zones', () => {
  const prevLevel = chalk.level;
  beforeAll(() => {
    chalk.level = 1;
    setLocalePreference('en');
  });
  afterAll(() => {
    chalk.level = prevLevel;
    setLocalePreference('auto');
  });

  // Layout (width 120): 0 divider, 1 title, 2 hint, 3 blank, 4-6 search box,
  // then each feature occupying label + detail + description rows:
  //   7-9 first   10-12 second   13-15 third   16 blank   17 Apply   18 divider.
  it('declares the search zone plus one zone per feature spanning its rows', () => {
    const { picker } = makePicker();
    const lines = picker.render(120).map(strip);
    const zones = [...picker.hitZones()];
    expect(zones.map((zone) => zone.id)).toEqual([DIALOG_SEARCH_ZONE, 0, 1, 2]);
    expect(zones[0]).toMatchObject({ row: 4, col: 1, width: 120, height: 3 });
    for (const [i, zone] of zones.slice(1).entries()) {
      expect(zone).toMatchObject({ row: 7 + i * 3, col: 1, width: 120, height: 3 });
      expect(lines[zone.row]).toContain(['First feature', 'Second feature', 'Third feature'][i]!);
      // A press on the detail/description row hits the same feature.
      expect(hitZoneAt([zone], zone.row + 2, 1, 'action')?.id).toBe(i);
    }
  });

  it('declares the Apply zone only while changes are pending', () => {
    const { picker } = makePicker();
    const applyZone = (): HitZone | undefined =>
      [...picker.hitZones()].find((zone) => zone.id === 'apply');
    expect(applyZone()).toBeUndefined(); // no changes → a disabled button has no zone

    picker.handleInput(' '); // draft a toggle on the first feature
    picker.render(120);
    expect(applyZone()).toMatchObject({ row: 17, col: 1, width: 120, height: 1 });

    picker.handleInput(' '); // toggle back → no pending changes
    picker.render(120);
    expect(applyZone()).toBeUndefined();
  });

  it('dispatches a feature press: move the cursor and toggle the draft, never apply', () => {
    const { picker, onApply } = makePicker();
    const text = (): string => strip(picker.render(120).join('\n'));

    expect(dispatchPress(picker, 10)).not.toBe(false); // Second feature label row
    expect(text()).toContain('❯ Second feature  disabled');

    expect(dispatchPress(picker, 14)).not.toBe(false); // Third feature description row
    expect(text()).toContain('❯ Third feature  disabled');

    dispatchPress(picker, 14); // a second press toggles back
    expect(text()).toContain('❯ Third feature  enabled');
    expect(onApply).not.toHaveBeenCalled();
  });

  it('applies the pending changes when the Apply zone is pressed', () => {
    const { picker, onApply } = makePicker();
    dispatchPress(picker, 10); // draft a toggle on Second feature
    picker.render(120);
    expect(dispatchPress(picker, 17)).not.toBe(false);
    expect(onApply).toHaveBeenCalledWith([{ id: 'second_feature', enabled: false }]);
  });

  it('focuses the search box via its zone', () => {
    const { picker } = makePicker();
    const focused = (): boolean =>
      picker.render(120).map(strip).some((l) => l.includes('Esc back to list'));
    expect(focused()).toBe(false);
    dispatchPress(picker, 5);
    expect(focused()).toBe(true);
  });

  it('misses zones for presses on the header, blank, and divider rows', () => {
    const { picker, onApply } = makePicker();
    for (const row of [0, 1, 2, 3, 16, 18]) {
      expect(dispatchPress(picker, row)).toBe(false);
    }
    expect(onApply).not.toHaveBeenCalled();
    expect(strip(picker.render(120).join('\n'))).toContain('❯ First feature');
  });

  it('underlines the hovered feature and the pending Apply button, clears on leave', () => {
    const { picker } = makePicker();
    picker.handleInput(' '); // pending change so the Apply button is hoverable
    const baseline = picker.render(120).join('\n');

    expect(dispatchHover(picker, 10)).not.toBe(false); // Second feature row
    expect(picker.render(120).join('\n')).toContain('[4m');
    expect(dispatchHover(picker, 10)).toBe(false); // unchanged → frame skipped

    expect(dispatchHover(picker, 17)).not.toBe(false); // Apply button row
    expect(picker.render(120).join('\n')).toContain('[4m');

    dispatchHover(picker, -1);
    expect(picker.render(120).join('\n')).toBe(baseline);
  });

  it('keeps the wheel behavior on handleMouse', () => {
    const { picker } = makePicker();
    const text = (): string => strip(picker.render(120).join('\n'));
    picker.handleMouse({ type: 'wheel', button: 65, col: 1, row: 1, slotRelative: false });
    expect(text()).toContain('❯ Second feature');
    picker.handleMouse({ type: 'wheel', button: 64, col: 1, row: 1, slotRelative: false });
    expect(text()).toContain('❯ First feature');
  });
});
