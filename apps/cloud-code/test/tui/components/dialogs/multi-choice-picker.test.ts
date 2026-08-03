import { describe, expect, it, vi } from 'vitest';
import chalk from 'chalk';

import { MultiChoicePickerComponent } from '#/tui/components/dialogs/multi-choice-picker';
import { setLocalePreference } from '#/tui/i18n';

const ANSI = /\[[0-9;]*m/g;
const strip = (s: string): string => s.replaceAll(ANSI, '');

const ESC = String.fromCodePoint(27);
const KEY_ENTER = '\r';
const KEY_DOWN = `${ESC}[B`;
const KEY_UP = `${ESC}[A`;
const KEY_SPACE = ' ';

const OPTIONS = [
  { value: 'none', label: 'none' },
  { value: 'low', label: 'low' },
  { value: 'high', label: 'high' },
] as const;

function makePicker(overrides: Record<string, unknown> = {}) {
  const onSubmit = vi.fn();
  const onCancel = vi.fn();
  const picker = new MultiChoicePickerComponent({
    title: 'Pick',
    options: OPTIONS,
    onSubmit,
    onCancel,
    ...overrides,
  });
  picker.focused = true;
  return { picker, onSubmit, onCancel, text: () => strip(picker.render(80).join('\n')) };
}

describe('MultiChoicePickerComponent', () => {
  setLocalePreference('en');

  it('renders initial selections checked and ignores unknown values', () => {
    const { text } = makePicker({ initialSelected: ['low', 'bogus'] });
    const out = text();
    expect(out).toContain('[ ] none');
    expect(out).toContain('[✓] low');
    expect(out).toContain('[ ] high');
  });

  it('space toggles the highlighted option, enter submits in option order', () => {
    const { picker, onSubmit } = makePicker({ initialSelected: ['high'] });

    // Toggle "high" off and "none"/"low" on — submitted in option order.
    picker.handleInput(KEY_DOWN);
    picker.handleInput(KEY_DOWN);
    picker.handleInput(KEY_SPACE); // high off
    picker.handleInput(KEY_UP);
    picker.handleInput(KEY_SPACE); // low on
    picker.handleInput(KEY_UP);
    picker.handleInput(KEY_SPACE); // none on
    picker.handleInput(KEY_ENTER);

    expect(onSubmit).toHaveBeenCalledWith(['none', 'low']);
  });

  it('submits an empty selection (meaningful for "no efforts supported")', () => {
    const { picker, onSubmit } = makePicker();
    picker.handleInput(KEY_ENTER);
    expect(onSubmit).toHaveBeenCalledWith([]);
  });

  it('esc cancels without submitting', () => {
    const { picker, onSubmit, onCancel } = makePicker({ initialSelected: ['low'] });
    picker.handleInput(ESC);
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('clamps navigation at both ends', () => {
    const { picker, onSubmit } = makePicker();
    picker.handleInput(KEY_UP); // stays on row 0
    picker.handleInput(KEY_SPACE);
    picker.handleInput(KEY_DOWN);
    picker.handleInput(KEY_DOWN);
    picker.handleInput(KEY_DOWN); // clamps at last row
    picker.handleInput(KEY_SPACE);
    picker.handleInput(KEY_ENTER);
    expect(onSubmit).toHaveBeenCalledWith(['none', 'high']);
  });
});

describe('MultiChoicePickerComponent mouse support', () => {
  // Layout at width 80: 0 divider, 1 title, 2 hint, 3 blank, 4 none, 5 low,
  // 6 high, 7 blank, 8 divider.
  it('toggles the clicked checkbox row and moves the highlight onto it', () => {
    const { picker, onSubmit, text } = makePicker({ initialSelected: ['high'] });

    picker.handleMouse({ type: 'press', button: 0, col: 1, row: 4, slotRelative: false });
    expect(text()).toContain('[✓] none');
    expect(text()).toContain('❯ [✓] none');

    picker.handleMouse({ type: 'press', button: 0, col: 1, row: 6, slotRelative: false });
    expect(text()).toContain('[ ] high');

    // Toggling never submits.
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('fires the trailing custom action row on click', () => {
    const onTrigger = vi.fn();
    const { picker, text } = makePicker({
      initialSelected: ['low'],
      customAction: { label: 'Custom value…', onTrigger },
    });
    // Options at rows 4-6, the custom action row at 7.
    picker.handleMouse({ type: 'press', button: 0, col: 1, row: 7, slotRelative: false });
    expect(onTrigger).toHaveBeenCalledWith(['low']);
    expect(text()).toContain('Custom value…');
  });

  it('underlines the hovered row and clears on leave', () => {
    const prevLevel = chalk.level;
    chalk.level = 1;
    try {
      const { picker } = makePicker();
      picker.render(80);
      const baseline = picker.render(80).join('\n');

      const motion = (row: number): void | boolean =>
        picker.handleMouse({ type: 'motion', button: 3, col: 1, row, slotRelative: false });
      expect(motion(5)).not.toBe(false);
      expect(picker.render(80).join('\n')).toContain('[4m');
      expect(motion(5)).toBe(false); // unchanged → frame skipped
      motion(0);
      expect(picker.render(80).join('\n')).toBe(baseline);
    } finally {
      chalk.level = prevLevel;
    }
  });
});
