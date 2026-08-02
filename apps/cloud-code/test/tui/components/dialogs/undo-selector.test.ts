import { describe, expect, it, vi } from 'vitest';

import { UndoSelectorComponent, type UndoChoice } from '#/tui/components/dialogs/undo-selector';

const ANSI = /\[[0-9;]*m/g;
const strip = (s: string): string => s.replaceAll(ANSI, '');

function text(component: UndoSelectorComponent, width = 120): string {
  return component.render(width).map(strip).join('\n');
}

function choice(id: string, label: string): UndoChoice {
  return { id, count: 1, input: label, label };
}

describe('UndoSelectorComponent', () => {
  it('moves the selection with the mouse wheel, clamped at both ends', () => {
    const picker = new UndoSelectorComponent({
      choices: [
        choice('u1', 'first prompt'),
        choice('u2', 'second prompt'),
        choice('u3', 'third prompt'),
      ],
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });
    const wheel = (button: number): void => {
      picker.handleMouse({ type: 'wheel', button, col: 1, row: 1, slotRelative: false });
    };

    // The cursor starts on the newest (last) entry; wheel down clamps there
    // instead of wrapping back to the oldest.
    expect(text(picker)).toContain('❯ third prompt');
    wheel(65);
    expect(text(picker)).toContain('❯ third prompt');

    // Wheel up walks towards older entries.
    wheel(64);
    expect(text(picker)).toContain('❯ second prompt');

    // The oldest entry clamps too.
    wheel(64);
    wheel(64);
    const out = text(picker);
    expect(out).toContain('❯ first prompt');
    expect(out).not.toContain('❯ second prompt');
  });

  it('selects the choice row hit by a left press, using the render window', () => {
    const onSelect = vi.fn();
    const picker = new UndoSelectorComponent({
      choices: [
        choice('u1', 'first prompt'),
        choice('u2', 'second prompt'),
        choice('u3', 'third prompt'),
        choice('u4', 'fourth prompt'),
        choice('u5', 'fifth prompt'),
        choice('u6', 'sixth prompt'),
      ],
      onSelect,
      onCancel: vi.fn(),
    });
    picker.render(120); // primes the render width used by the hit test
    const press = (row: number, button = 0): void => {
      picker.handleMouse({ type: 'press', button, col: 1, row, slotRelative: false });
    };

    // The cursor starts on the newest entry (index 5), so the 5-row window
    // covers indices 1-5 on rows 4-8 (header: divider, title, hint, blank).
    expect(text(picker)).toContain('❯ sixth prompt');
    press(6); // window row 2 → index 3
    expect(text(picker)).toContain('❯ fourth prompt');

    // Click only moves the cursor; it never confirms.
    expect(onSelect).not.toHaveBeenCalled();

    // Index 3 keeps the window at 1-5 (the cursor stays 2 rows from the top);
    // index 2 finally scrolls it to 0-4.
    press(5); // window row 1 → index 2
    expect(text(picker)).toContain('❯ third prompt');
    press(4); // window row 0 → index 0
    expect(text(picker)).toContain('❯ first prompt');
  });

  it('ignores presses outside the choice rows and non-left presses', () => {
    const picker = new UndoSelectorComponent({
      choices: [choice('u1', 'first prompt'), choice('u2', 'second prompt')],
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });
    picker.render(120);
    const press = (row: number, button = 0): void => {
      picker.handleMouse({ type: 'press', button, col: 1, row, slotRelative: false });
    };

    // Two choices: rows 4-5; the cursor starts on the last one.
    expect(text(picker)).toContain('❯ second prompt');
    for (const row of [-1, 0, 1, 2, 3, 6, 7, 20]) {
      press(row);
      expect(text(picker), `row ${String(row)}`).toContain('❯ second prompt');
    }
    press(4, 2); // right button
    expect(text(picker)).toContain('❯ second prompt');
  });
});
