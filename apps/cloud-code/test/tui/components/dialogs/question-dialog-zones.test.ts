import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import chalk from 'chalk';
import { hitZoneAt, type MouseEvent } from '@cloud-code/pi-tui';

import { QuestionDialogComponent } from '#/tui/components/dialogs/question-dialog';
import type { PendingQuestion } from '#/tui/reverse-rpc/types';

function strip(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

function makePending(questions: PendingQuestion['data']['questions']): PendingQuestion {
  return { data: { id: 'q_zones', tool_call_id: 'tc_zones', questions } };
}

function makeDialog(pending: PendingQuestion): {
  dialog: QuestionDialogComponent;
  collected: string[][];
} {
  const collected: string[][] = [];
  const dialog = new QuestionDialogComponent(pending, (response) => {
    collected.push(response.answers);
  });
  return { dialog, collected };
}

function pressEvent(row: number, col = 1): MouseEvent {
  return { type: 'press', button: 0, col, row, slotRelative: false };
}

/** The dispatch the TUI performs for a left-press at a component-relative cell. */
function dispatchPress(dialog: QuestionDialogComponent, row: number, col = 1): void | boolean {
  const zone = hitZoneAt(dialog.hitZones(), row, col, 'action');
  if (zone === null) return false;
  return dialog.onHitZone(zone.id, pressEvent(row, col));
}

/** The hover update the TUI performs for pointer motion at a component-relative cell. */
function dispatchHover(dialog: QuestionDialogComponent, row: number, col = 1): void | boolean {
  const zone = row < 0 ? null : hitZoneAt(dialog.hitZones(), row, col, 'hover');
  return dialog.setHoveredZone(zone?.id ?? null);
}

/** Component-relative row of the rendered line containing `marker`. */
function rowOf(dialog: QuestionDialogComponent, marker: string): number {
  const lines = dialog.render(80).map(strip);
  const idx = lines.findIndex((line) => line.includes(marker));
  if (idx < 0) throw new Error(`marker not rendered: ${marker}`);
  return idx;
}

describe('QuestionDialogComponent hit zones', () => {
  // chalk auto-disables without a TTY; force colors on so the hover
  // assertions observe real SGR sequences.
  const prevLevel = chalk.level;
  beforeAll(() => {
    chalk.level = 1;
  });
  afterAll(() => {
    chalk.level = prevLevel;
  });

  it('declares one zone per tab cell on the strip row, in column order', () => {
    const { dialog } = makeDialog(
      makePending([
        { question: 'Q1?', multi_select: false, options: [{ label: 'A1' }] },
        { question: 'Q2?', multi_select: false, options: [{ label: 'A2' }] },
      ]),
    );
    dialog.render(80);
    const tabZones = [...dialog.hitZones()].filter(
      (zone) => typeof zone.id === 'string' && zone.id.startsWith('tab:'),
    );
    expect(tabZones.map((zone) => zone.id)).toEqual(['tab:0', 'tab:1', 'tab:2']);
    for (const zone of tabZones) {
      expect(zone.row).toBe(3); // divider, title, blank, then the strip
      expect(zone.height).toBe(1);
    }
    // Strictly ordered, non-overlapping column ranges.
    for (let i = 1; i < tabZones.length; i++) {
      expect(tabZones[i]!.col).toBeGreaterThanOrEqual(tabZones[i - 1]!.col + tabZones[i - 1]!.width);
    }
  });

  it('switches tabs via a tab zone press', () => {
    const { dialog } = makeDialog(
      makePending([
        { question: 'Q1?', multi_select: false, options: [{ label: 'A1' }] },
        { question: 'Q2?', multi_select: false, options: [{ label: 'A2' }] },
      ]),
    );
    dialog.render(80);
    const zones = [...dialog.hitZones()];
    const q2 = zones.find((zone) => zone.id === 'tab:1')!;
    expect(dispatchPress(dialog, q2.row, q2.col)).not.toBe(false);
    expect(strip(dialog.render(80).join('\n'))).toContain('? Q2?');
    // A press between cells (the two-space gap) hits no zone.
    const q2After = [...dialog.hitZones()].find((zone) => zone.id === 'tab:1')!;
    expect(hitZoneAt(dialog.hitZones(), q2After.row, q2After.col - 1, 'action')).toBeNull();
  });

  it('declares one full-width zone per visible option, spanning label and description', () => {
    const { dialog } = makeDialog(
      makePending([
        {
          question: 'Q1?',
          multi_select: false,
          options: [
            { label: 'A1', description: 'The first choice.' },
            { label: 'B1' },
          ],
        },
      ]),
    );
    const lines = dialog.render(80).map(strip);
    const optionZones = [...dialog.hitZones()].filter(
      (zone) => typeof zone.id === 'string' && zone.id.startsWith('option:'),
    );
    // Two presets plus the synthetic Other row.
    expect(optionZones.map((zone) => zone.id)).toEqual(['option:0', 'option:1', 'option:2']);
    expect(optionZones[0]!.height).toBe(1 + 1); // label + description
    expect(optionZones[1]!.height).toBe(1);
    for (const zone of optionZones) {
      expect(zone.col).toBe(1);
      expect(zone.width).toBe(80);
    }
    expect(strip(lines[optionZones[0]!.row] ?? '')).toContain('[1] A1');
    // The description row hits the same option.
    expect(hitZoneAt(dialog.hitZones(), optionZones[0]!.row + 1, 1, 'action')?.id).toBe('option:0');
  });

  it('answers a single-select option on a zone press and auto-advances', () => {
    const { dialog, collected } = makeDialog(
      makePending([
        { question: 'Q1?', multi_select: false, options: [{ label: 'A1' }, { label: 'B1' }] },
        { question: 'Q2?', multi_select: false, options: [{ label: 'A2' }, { label: 'B2' }] },
      ]),
    );
    dialog.render(80);
    const zone = [...dialog.hitZones()].find((z) => z.id === 'option:1')!;
    expect(dispatchPress(dialog, zone.row)).not.toBe(false);
    expect(collected).toEqual([]);
    expect(strip(dialog.render(80).join('\n'))).toContain('? Q2?');
  });

  it('highlights a submit action on press and executes it on re-press', () => {
    const { dialog, collected } = makeDialog(
      makePending([{ question: 'Q1?', multi_select: false, options: [{ label: 'A1' }] }]),
    );
    dialog.handleInput('1'); // answer → submit tab
    dialog.render(80);
    const cancel = [...dialog.hitZones()].find((zone) => zone.id === 'submit:1')!;
    expect(strip(dialog.render(80).map(strip)[cancel.row] ?? '')).toContain('[2]');

    expect(dispatchPress(dialog, cancel.row)).not.toBe(false); // highlights Cancel
    expect(collected).toEqual([]);
    dispatchPress(dialog, cancel.row); // re-press executes: empty answers
    expect(collected).toEqual([[]]);
  });

  it('suppresses option hover zones and the editing row while the Other input is armed', () => {
    const { dialog } = makeDialog(
      makePending([
        { question: 'Q1?', multi_select: true, options: [{ label: 'A1' }, { label: 'B1' }] },
      ]),
    );
    dialog.handleInput('3'); // number-key the synthetic Other option → armed
    const lines = dialog.render(80).map(strip);
    const editingRow = lines.findIndex((line) => line.includes('❯') || line.includes('Other'));
    const zones = [...dialog.hitZones()];

    // No option zone participates in hover while editing.
    const optionZones = zones.filter(
      (zone) => typeof zone.id === 'string' && zone.id.startsWith('option:'),
    );
    expect(optionZones.length).toBe(2); // the armed Other row declares none
    for (const zone of optionZones) {
      expect(hitZoneAt([zone], zone.row, 1, 'hover')).toBeNull();
    }
    // A press where the input row renders hits no zone (the input owns it).
    expect(hitZoneAt(zones, editingRow, 1, 'action')).toBeNull();
    // A press on another option still retargets, like the arrow keys.
    const target = optionZones[0]!;
    expect(dispatchPress(dialog, target.row)).not.toBe(false);
    expect(strip(dialog.render(80).join('\n'))).toContain('[✓] A1');
  });

  it('keeps tab zones live while the Other input is armed', () => {
    const { dialog } = makeDialog(
      makePending([
        { question: 'Q1?', multi_select: false, options: [{ label: 'A1' }] },
        { question: 'Q2?', multi_select: false, options: [{ label: 'A2' }] },
      ]),
    );
    dialog.handleInput(`${String.fromCodePoint(27)}[B`); // cursor onto Other
    dialog.handleInput('\r'); // arm the input
    dialog.render(80);
    const q2 = [...dialog.hitZones()].find((zone) => zone.id === 'tab:1')!;
    expect(dispatchPress(dialog, q2.row, q2.col)).not.toBe(false);
    expect(strip(dialog.render(80).join('\n'))).toContain('? Q2?');
  });

  it('underlines the hovered option rows and clears on leave', () => {
    const { dialog } = makeDialog(
      makePending([
        {
          question: 'Q1?',
          multi_select: false,
          options: [{ label: 'A1', description: 'The first choice.' }, { label: 'B1' }],
        },
      ]),
    );
    dialog.render(80);
    const zone = [...dialog.hitZones()].find((z) => z.id === 'option:0')!;
    const baseline = dialog.render(80).join('\n');

    expect(dispatchHover(dialog, zone.row)).not.toBe(false);
    const hovered = dialog.render(80).join('\n');
    expect(hovered).toContain('[4m');
    expect(hovered).not.toBe(baseline);

    expect(dispatchHover(dialog, zone.row)).toBe(false); // unchanged → frame skipped

    dispatchHover(dialog, -1); // pointer left the component
    expect(dialog.render(80).join('\n')).toBe(baseline);
  });

  it('underlines the hovered tab cell', () => {
    const { dialog } = makeDialog(
      makePending([
        { question: 'Q1?', multi_select: false, options: [{ label: 'A1' }] },
        { question: 'Q2?', multi_select: false, options: [{ label: 'A2' }] },
      ]),
    );
    dialog.render(80);
    const submitTab = [...dialog.hitZones()].find((zone) => zone.id === 'tab:2')!;
    expect(dispatchHover(dialog, submitTab.row, submitTab.col)).not.toBe(false);
    expect(dialog.render(80).join('\n')).toContain('[4m');
  });

  it('misses zones for presses on the chrome rows', () => {
    const { dialog, collected } = makeDialog(
      makePending([{ question: 'Q1?', multi_select: false, options: [{ label: 'A1' }] }]),
    );
    dialog.render(80);
    expect(dispatchPress(dialog, 0)).toBe(false); // top border
    expect(dispatchPress(dialog, 1)).toBe(false); // title
    expect(dispatchPress(dialog, 2)).toBe(false); // blank
    expect(collected).toEqual([]);
  });

  it('keeps the wheel behavior on handleMouse', () => {
    const { dialog } = makeDialog(
      makePending([
        { question: 'Q1?', multi_select: false, options: [{ label: 'A1' }, { label: 'B1' }] },
      ]),
    );
    dialog.render(80);
    dialog.handleMouse({ type: 'wheel', button: 65, col: 1, row: 5, slotRelative: false });
    expect(strip(dialog.render(80).join('\n'))).toContain('→ [2] B1');
    dialog.handleMouse({ type: 'wheel', button: 64, col: 1, row: 5, slotRelative: false });
    expect(strip(dialog.render(80).join('\n'))).toContain('→ [1] A1');
  });
});
