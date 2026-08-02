import { describe, expect, it, vi } from 'vitest';

import { RewindModeSelectorComponent } from '#/tui/components/dialogs/rewind-mode-selector';

const ANSI = /\[[0-9;]*m/g;
const strip = (s: string): string => s.replaceAll(ANSI, '');

function text(component: RewindModeSelectorComponent, width = 120): string {
  return component.render(width).map(strip).join('\n');
}

describe('RewindModeSelectorComponent', () => {
  // Row layout: 0 divider, 1 title, 2 hint, 3 blank, then every choice on its
  // own row (never paged): 4 both, 5 conversation, 6 code, 7 blank, 8 divider.
  function makePicker() {
    const onSelect = vi.fn();
    const picker = new RewindModeSelectorComponent({
      onSelect,
      onCancel: vi.fn(),
    });
    picker.render(120); // primes the render width used by the hit test
    const press = (row: number, button = 0): void => {
      picker.handleMouse({ type: 'press', button, col: 1, row, slotRelative: false });
    };
    return { picker, onSelect, press };
  }

  it('selects the choice row hit by a left press without confirming', () => {
    const { picker, onSelect, press } = makePicker();

    expect(text(picker)).toContain('❯ Restore code and conversation');

    press(5);
    expect(text(picker)).toContain('❯ Restore conversation');

    press(6);
    expect(text(picker)).toContain('❯ Restore code');

    press(4);
    expect(text(picker)).toContain('❯ Restore code and conversation');

    // Click only moves the cursor; it never confirms.
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('ignores presses outside the choice rows and non-left presses', () => {
    const { picker, press } = makePicker();

    press(5); // move off the first row first
    expect(text(picker)).toContain('❯ Restore conversation');

    for (const row of [-1, 0, 1, 2, 3, 7, 8, 20]) {
      press(row);
      expect(text(picker), `row ${String(row)}`).toContain('❯ Restore conversation');
    }
    press(4, 2); // right button
    expect(text(picker)).toContain('❯ Restore conversation');
  });
});
