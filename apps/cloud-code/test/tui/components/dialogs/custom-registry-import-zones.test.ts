/**
 * Hit-zone tests for CustomRegistryImportDialogComponent: one action-only
 * zone per field input row (click focuses the field — the mouse counterpart
 * of Tab / ↑ / ↓), no hover affordance, and no dispatch once the dialog is
 * done. Dispatch helpers mirror what the TUI does with the declared zones
 * (see choice-picker-zones.test.ts).
 */

import chalk from 'chalk';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { hitZoneAt, type MouseEvent } from '@cloud-code/pi-tui';

import {
  CustomRegistryImportDialogComponent,
  type CustomRegistryImportResult,
} from '#/tui/components/dialogs/custom-registry-import';
import { setLocalePreference } from '#/tui/i18n';

const strip = (s: string): string => s.replaceAll(/\u001B\[[0-9;]*m/g, '');

function makeDialog() {
  const onDone = vi.fn();
  const dialog = new CustomRegistryImportDialogComponent(
    onDone as unknown as (r: CustomRegistryImportResult) => void,
    'https://example.com/api.json',
  );
  dialog.focused = true;
  dialog.render(80);
  return { dialog, onDone };
}

function pressEvent(row: number, col = 1): MouseEvent {
  return { type: 'press', button: 0, col, row, slotRelative: false };
}

/** The dispatch the TUI performs for a left-press at a component-relative cell. */
function dispatchPress(
  dialog: CustomRegistryImportDialogComponent,
  row: number,
  col = 1,
): void | boolean {
  const zone = hitZoneAt(dialog.hitZones(), row, col, 'action');
  if (zone === null) return false;
  return dialog.onHitZone(zone.id, pressEvent(row, col));
}

describe('CustomRegistryImportDialogComponent hit zones', () => {
  const prevLevel = chalk.level;
  beforeAll(() => {
    chalk.level = 1;
    setLocalePreference('en');
  });
  afterAll(() => {
    chalk.level = prevLevel;
    setLocalePreference('auto');
  });

  // Layout (width 80): 0 blank, 1 top border, 2 padding, 3 title, 4 blank,
  // 5 subtitle, 6 blank, 7 url label, 8 url input, 9 blank, 10 token label,
  // 11 token input, 12 blank, 13 footer, 14 padding, 15 bottom border, 16 blank.
  it('declares one action-only zone per field input row', () => {
    const { dialog } = makeDialog();
    const lines = dialog.render(80).map(strip);
    const zones = [...dialog.hitZones()];
    expect(zones.map((zone) => zone.id)).toEqual(['url', 'token']);
    expect(zones[0]).toMatchObject({ row: 8, col: 1, width: 80, height: 1 });
    expect(zones[1]).toMatchObject({ row: 11, col: 1, width: 80, height: 1 });
    expect(lines[8]).toContain('example.com');
    // No hover affordance — the zones are transparent to motion.
    for (const zone of zones) {
      expect(hitZoneAt([zone], zone.row, zone.col, 'hover')).toBeNull();
    }
  });

  it('focuses the pressed field like Tab / ↑ / ↓', () => {
    const { dialog } = makeDialog();
    const text = (): string => strip(dialog.render(80).join('\n'));
    expect(text()).toContain('next field'); // url field active

    expect(dispatchPress(dialog, 11)).not.toBe(false); // token input row
    expect(text()).toContain('Enter to submit'); // token field active

    expect(dispatchPress(dialog, 8)).not.toBe(false); // url input row
    expect(text()).toContain('next field');
  });

  it('misses zones for presses on the border, labels, and footer', () => {
    const { dialog } = makeDialog();
    for (const row of [0, 1, 2, 3, 7, 10, 13, 15, 16]) {
      expect(dispatchPress(dialog, row)).toBe(false);
    }
    expect(strip(dialog.render(80).join('\n'))).toContain('next field'); // url still active
  });

  it('stops dispatching once the dialog is done', () => {
    const { dialog, onDone } = makeDialog();
    dialog.handleInput('\r'); // url -> token
    for (const ch of 'sk-tok') dialog.handleInput(ch);
    dialog.handleInput('\r'); // submit
    expect(onDone).toHaveBeenCalledTimes(1);

    dialog.render(80);
    expect(dispatchPress(dialog, 8)).toBe(false);
  });
});
