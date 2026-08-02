import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import chalk from 'chalk';
import { hitZoneAt, type MouseEvent } from '@cloud-code/pi-tui';

import {
  StartPermissionPromptComponent,
  type StartPermissionChoice,
} from '#/tui/components/dialogs/start-permission-prompt';

function strip(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

function makeDialog(): {
  dialog: StartPermissionPromptComponent<'auto' | 'yolo' | 'manual'>;
  chosen: StartPermissionChoice[];
  cancelled: number;
} {
  const chosen: StartPermissionChoice[] = [];
  let cancelled = 0;
  const dialog = new StartPermissionPromptComponent({
    title: 'Pick a permission mode',
    noticeLines: [
      'Manual mode asks you before Cloud Code CLI runs commands, edits files, or takes other risky actions.',
      'Auto mode approves tool actions automatically.',
    ],
    options: [
      { value: 'auto', label: 'Switch to Auto and start', description: 'Approves everything from now on.' },
      { value: 'yolo', label: 'Switch to YOLO and start', description: 'Skips questions too.' },
      { value: 'manual', label: 'Start in Manual', description: 'Ask before every risky action.' },
    ],
    onSelect: (choice) => chosen.push(choice),
    onCancel: () => {
      cancelled += 1;
    },
  });
  return { dialog, chosen, cancelled };
}

function pressEvent(row: number, col = 1): MouseEvent {
  return { type: 'press', button: 0, col, row, slotRelative: false };
}

/** The dispatch the TUI performs for a left-press at a component-relative cell. */
function dispatchPress(dialog: StartPermissionPromptComponent<'auto' | 'yolo' | 'manual'>, row: number, col = 1): void | boolean {
  const zone = hitZoneAt(dialog.hitZones(), row, col, 'action');
  if (zone === null) return false;
  return dialog.onHitZone(zone.id, pressEvent(row, col));
}

/** The hover update the TUI performs for pointer motion at a component-relative cell. */
function dispatchHover(dialog: StartPermissionPromptComponent<'auto' | 'yolo' | 'manual'>, row: number, col = 1): void | boolean {
  const zone = row < 0 ? null : hitZoneAt(dialog.hitZones(), row, col, 'hover');
  return dialog.setHoveredZone(zone?.id ?? null);
}

describe('StartPermissionPromptComponent hit zones', () => {
  // chalk auto-disables without a TTY; force colors on so the hover
  // assertions observe real SGR sequences.
  const prevLevel = chalk.level;
  beforeAll(() => {
    chalk.level = 1;
  });
  afterAll(() => {
    chalk.level = prevLevel;
  });

  it('declares one full-width zone per option, aligned with the rendered rows', () => {
    const { dialog } = makeDialog();
    const lines = dialog.render(80).map(strip);
    const zones = [...dialog.hitZones()];
    expect(zones).toHaveLength(3);
    for (const [idx, zone] of zones.entries()) {
      expect(zone.id).toBe(idx);
      expect(zone.col).toBe(1);
      expect(zone.width).toBe(80);
      // The zone starts at the option's label line (below the notice block).
      expect(strip(lines[zone.row] ?? '')).toContain(
        ['Switch to Auto and start', 'Switch to YOLO and start', 'Start in Manual'][idx]!,
      );
      // And spans the label, the description, and the trailing blank.
      expect(zone.height).toBe(1 + 1 + 1);
    }
    // No overlap: zones partition the option area in order.
    for (let i = 1; i < zones.length; i++) {
      expect(zones[i]!.row).toBeGreaterThanOrEqual(zones[i - 1]!.row + zones[i - 1]!.height);
    }
  });

  it('dispatches a zone press to the option: highlight, then re-click confirms', () => {
    const { dialog, chosen } = makeDialog();
    dialog.render(80);
    const zones = [...dialog.hitZones()];

    expect(dispatchPress(dialog, zones[1]!.row)).not.toBe(false);
    expect(chosen).toEqual([]);
    expect(strip(dialog.render(80).join('\n'))).toContain('❯ Switch to YOLO and start');

    dispatchPress(dialog, zones[1]!.row); // re-click confirms, like Enter
    expect(chosen).toEqual(['yolo']);
  });

  it('hits the same option from its description and trailing blank rows', () => {
    const { dialog, chosen } = makeDialog();
    dialog.render(80);
    const zones = [...dialog.hitZones()];
    const zone = zones[0]!;
    // Description row and trailing blank row land in the same zone.
    expect(hitZoneAt(dialog.hitZones(), zone.row + 1, 1, 'action')?.id).toBe(0);
    expect(hitZoneAt(dialog.hitZones(), zone.row + 2, 1, 'action')?.id).toBe(0);
    dispatchPress(dialog, zone.row + 2); // already highlighted → confirms directly
    expect(chosen).toEqual(['auto']);
  });

  it('misses zones for presses on the chrome rows', () => {
    const { dialog, chosen } = makeDialog();
    dialog.render(80);
    expect(dispatchPress(dialog, 0)).toBe(false); // top border
    expect(dispatchPress(dialog, 1)).toBe(false); // title
    expect(dispatchPress(dialog, 2)).toBe(false); // hint
    expect(chosen).toEqual([]);
  });

  it('underlines the hovered option label and clears on leave', () => {
    const { dialog } = makeDialog();
    dialog.render(80);
    const zones = [...dialog.hitZones()];
    const baseline = dialog.render(80).join('\n');

    expect(dispatchHover(dialog, zones[2]!.row)).not.toBe(false);
    const hovered = dialog.render(80).join('\n');
    expect(hovered).toContain('[4m');
    expect(hovered).not.toBe(baseline);

    expect(dispatchHover(dialog, zones[2]!.row)).toBe(false); // unchanged → frame skipped

    dispatchHover(dialog, -1); // pointer left the component
    expect(dialog.render(80).join('\n')).toBe(baseline);
  });

  it('keeps the wheel behavior on handleMouse', () => {
    const { dialog } = makeDialog();
    dialog.render(80);
    dialog.handleMouse({ type: 'wheel', button: 65, col: 1, row: 2, slotRelative: false });
    expect(strip(dialog.render(80).join('\n'))).toContain('❯ Switch to YOLO and start');
    dialog.handleMouse({ type: 'wheel', button: 64, col: 1, row: 2, slotRelative: false });
    expect(strip(dialog.render(80).join('\n'))).toContain('❯ Switch to Auto and start');
  });
});
