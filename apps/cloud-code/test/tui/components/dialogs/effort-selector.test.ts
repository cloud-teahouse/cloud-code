import { setKittyProtocolActive } from '@cloud-code/pi-tui';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import chalk from 'chalk';

import { EffortSelectorComponent } from '#/tui/components/dialogs/effort-selector';

const ANSI = /\[[0-9;]*m/g;
const strip = (s: string): string => s.replaceAll(ANSI, '');
const ESC = String.fromCodePoint(27);
const LEFT = `${ESC}[D`;
const RIGHT = `${ESC}[C`;

function text(component: EffortSelectorComponent, width = 120): string {
  return component.render(width).map(strip).join('\n');
}

describe('EffortSelectorComponent', () => {
  it('renders efforts as horizontal segments with the active one bracketed', () => {
    const picker = new EffortSelectorComponent({
      efforts: ['off', 'low', 'high', 'max'],
      currentValue: 'high',
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });
    const out = text(picker);
    // All efforts are rendered on a single row.
    expect(out).toContain('Off');
    expect(out).toContain('Low');
    expect(out).toContain('High');
    expect(out).toContain('Max');
    // The active level is wrapped in brackets; the rest are not.
    expect(out).toContain('[ High ]');
    expect(out).not.toContain('[ Off ]');
    expect(out).not.toContain('[ Max ]');
  });

  it('invokes onSelect with the chosen effort on Enter', () => {
    const onSelect = vi.fn();
    const picker = new EffortSelectorComponent({
      efforts: ['off', 'low', 'high', 'max'],
      currentValue: 'high',
      onSelect,
      onCancel: vi.fn(),
    });
    picker.handleInput('\r');
    expect(onSelect).toHaveBeenCalledWith('high');
  });

  it('moves the active segment with Left/Right and stops at the edges', () => {
    const onSelect = vi.fn();
    const picker = new EffortSelectorComponent({
      efforts: ['off', 'low', 'high', 'max'],
      currentValue: 'high',
      onSelect,
      onCancel: vi.fn(),
    });

    // index 2 (high) -> 3 (max).
    picker.handleInput(RIGHT);
    picker.handleInput('\r');
    expect(onSelect).toHaveBeenLastCalledWith('max');

    // Already at the right edge — another Right stays put.
    picker.handleInput(RIGHT);
    picker.handleInput('\r');
    expect(onSelect).toHaveBeenLastCalledWith('max');

    // Walk back to the left edge (max -> high -> low -> off).
    picker.handleInput(LEFT);
    picker.handleInput(LEFT);
    picker.handleInput(LEFT);
    picker.handleInput('\r');
    expect(onSelect).toHaveBeenLastCalledWith('off');

    // Already at the left edge — another Left stays put.
    picker.handleInput(LEFT);
    picker.handleInput('\r');
    expect(onSelect).toHaveBeenLastCalledWith('off');
  });

  it('invokes onSessionOnlySelect on Alt+S instead of onSelect', () => {
    const onSelect = vi.fn();
    const onSessionOnlySelect = vi.fn();
    const picker = new EffortSelectorComponent({
      efforts: ['off', 'low', 'high', 'max'],
      currentValue: 'high',
      onSelect,
      onSessionOnlySelect,
      onCancel: vi.fn(),
    });
    picker.handleInput(`${ESC}s`);
    expect(onSessionOnlySelect).toHaveBeenCalledWith('high');
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('cancels on Escape', () => {
    const onCancel = vi.fn();
    const picker = new EffortSelectorComponent({
      efforts: ['off', 'low', 'high', 'max'],
      currentValue: 'high',
      onSelect: vi.fn(),
      onCancel,
    });
    picker.handleInput(ESC);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('renders the warning line directly below the key-hint line when provided', () => {
    const picker = new EffortSelectorComponent({
      efforts: ['off', 'low', 'high', 'max'],
      currentValue: 'high',
      warning: 'Switching may increase token usage.',
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });
    const lines = picker.render(120).map(strip);
    const hintIdx = lines.findIndex((l) => l.includes('←→ switch'));
    expect(hintIdx).toBeGreaterThanOrEqual(0);
    expect(lines[hintIdx + 1]).toContain('Switching may increase token usage.');
  });

  it('renders no warning line without the warning option', () => {
    const picker = new EffortSelectorComponent({
      efforts: ['off', 'low', 'high', 'max'],
      currentValue: 'high',
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });
    const lines = picker.render(120).map(strip);
    const hintIdx = lines.findIndex((l) => l.includes('←→ switch'));
    expect(hintIdx).toBeGreaterThanOrEqual(0);
    expect(lines[hintIdx + 1]).toBe('');
  });

  it('wraps a warning longer than the width instead of truncating it', () => {
    const warning =
      'Note: Switching effort invalidates the existing prompt cache. Use /new to avoid extra token costs.';
    const picker = new EffortSelectorComponent({
      efforts: ['off', 'low', 'high', 'max'],
      currentValue: 'high',
      warning,
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });
    const lines = picker.render(40).map(strip);
    const hintIdx = lines.findIndex((l) => l.includes('←→ switch'));
    expect(lines[hintIdx + 1]).not.toBe('');
    expect(lines[hintIdx + 2]).not.toBe('');
    // Word-wrapped: nothing dropped — the full warning survives across lines.
    const squashed = lines.join('').replaceAll(/\s+/g, '');
    expect(squashed).toContain(warning.replaceAll(/\s+/g, ''));
  });
});

describe('EffortSelectorComponent mouse support', () => {
  // chalk auto-disables without a TTY; force colors on so the hover
  // assertions observe real SGR sequences.
  const prevLevel = chalk.level;
  beforeAll(() => {
    chalk.level = 1;
  });
  afterAll(() => {
    chalk.level = prevLevel;
  });
  const EFFORTS = ['off', 'low', 'high', 'max'] as const;

  function make() {
    const onSelect = vi.fn();
    const picker = new EffortSelectorComponent({
      efforts: [...EFFORTS],
      currentValue: 'high',
      onSelect,
      onCancel: vi.fn(),
    });
    picker.render(120); // primes lastRenderWidth
    const press = (row: number, col: number): void => {
      picker.handleMouse({ type: 'press', button: 0, col, row, slotRelative: false });
    };
    const motion = (row: number, col: number): void | boolean =>
      picker.handleMouse({ type: 'motion', button: 3, col, row, slotRelative: false });
    const wheel = (button: 64 | 65): void => {
      picker.handleMouse({ type: 'wheel', button, col: 1, row: 4, slotRelative: false });
    };
    /** 1-based column at which `marker` starts in the rendered output. */
    const colOf = (marker: string): number => {
      // NOTE: the file-level ANSI regex omits the ESC byte; with chalk forced
      // on (see beforeAll) the leftover bytes would shift the columns.
      const stripSgr = (s: string): string => s.replaceAll(/\u001b\[[0-9;]*m/g, '');
      const lines = picker.render(120).map(stripSgr);
      for (const line of lines) {
        const idx = line.indexOf(marker);
        if (idx >= 0) return idx + 1;
      }
      throw new Error(`marker not rendered: ${marker}`);
    };
    return { picker, onSelect, press, motion, wheel, colOf };
  }

  // Layout: 0 divider, 1 title, 2 hint, 3 blank, 4 segments row.
  it('activates a segment on click and commits it on re-click', () => {
    const { picker, onSelect, press, colOf } = make();

    press(4, colOf('Low'));
    expect(text(picker)).toContain('[ Low ]');
    expect(onSelect).not.toHaveBeenCalled();

    press(4, colOf('Low')); // re-click on the active segment commits
    expect(onSelect).toHaveBeenCalledWith('low');
  });

  it('steps the active segment on wheel ticks, clamped at the ends', () => {
    const { picker, wheel } = make(); // starts on High
    wheel(65);
    expect(text(picker)).toContain('[ Max ]');
    wheel(65);
    expect(text(picker)).toContain('[ Max ]'); // clamped
    wheel(64);
    expect(text(picker)).toContain('[ High ]');
  });

  it('underlines the hovered segment and clears on leave', () => {
    const { picker, motion, colOf } = make();
    const baseline = picker.render(120).join('\n');

    expect(motion(4, colOf('Max'))).not.toBe(false);
    expect(picker.render(120).join('\n')).toContain('[4m');
    expect(motion(4, colOf('Max'))).toBe(false); // unchanged → frame skipped

    motion(4, 1); // leading padding: no segment → cleared
    expect(picker.render(120).join('\n')).toBe(baseline);

    motion(-1, 1); // pointer left the component → cleared (already clear: skipped)
    expect(motion(-1, 1)).toBe(false);
  });

  /** Visible text of the underlined run (between SGR 4 and SGR 24). */
  const underlinedRun = (rendered: string): string =>
    /\x1b\[4m([^\x1b]*?)\x1b\[24m/.exec(rendered)?.[1] ?? '';

  it('underlines only the plain label of an unselected hovered segment, in one color', () => {
    const { picker, motion, colOf } = make();
    motion(4, colOf('Max')); // unselected: rendered as `  Max  `
    const out = picker.render(120).join('\n');
    // The underline covers the on-screen text — not the cell's padding
    // spaces (`  Max  `), and not the selected variant's width (`[ Max ]`).
    expect(underlinedRun(out)).toBe('Max');
    // One underline run, one underline color for the whole run.
    expect(out.match(/\x1b\[4m/g)).toHaveLength(1);
    expect(out.match(/\x1b\[58;2;/g)).toHaveLength(1);
  });

  it('underlines the full bracketed text of the selected hovered segment', () => {
    const { picker, motion, colOf } = make(); // starts on High → `[ High ]`
    motion(4, colOf('High'));
    const out = picker.render(120).join('\n');
    // The brackets are on-screen text, so the run covers them.
    expect(underlinedRun(out)).toBe('[ High ]');
    expect(out.match(/\x1b\[58;2;/g)).toHaveLength(1);
  });

  it('ignores presses off the segments row', () => {
    const { picker, onSelect, press } = make();
    press(0, 5);
    press(3, 5);
    expect(onSelect).not.toHaveBeenCalled();
    expect(text(picker)).toContain('[ High ]');
  });
});

describe('EffortSelectorComponent Alt+S encoding (kitty-active legacy bytes)', () => {
  afterEach(() => {
    setKittyProtocolActive(false);
  });

  function makeSessionOnly() {
    const onSelect = vi.fn();
    const onSessionOnlySelect = vi.fn();
    const onCancel = vi.fn();
    const picker = new EffortSelectorComponent({
      efforts: ['off', 'low', 'high', 'max'],
      currentValue: 'high',
      onSelect,
      onSessionOnlySelect,
      onCancel,
    });
    return { picker, onSelect, onSessionOnlySelect, onCancel };
  }

  // Regression: terminals that answer the Kitty keyboard query yet deliver
  // Alt+letter as legacy ESC-prefixed bytes silently killed Alt+S (pi-tui's
  // matchesKey gates the legacy form on the protocol being off).
  it('Alt+S works when Kitty is active but bytes are legacy', () => {
    setKittyProtocolActive(true);
    const { picker, onSelect, onSessionOnlySelect } = makeSessionOnly();
    picker.handleInput(`${ESC}s`);
    expect(onSessionOnlySelect).toHaveBeenCalledWith('high');
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('CSI-u Alt+S works with Kitty active', () => {
    setKittyProtocolActive(true);
    const { picker, onSessionOnlySelect } = makeSessionOnly();
    picker.handleInput(`${ESC}[115;3u`); // alt+s
    expect(onSessionOnlySelect).toHaveBeenCalledWith('high');
  });

  it('leaves plain Escape untouched when Kitty is active', () => {
    setKittyProtocolActive(true);
    const { picker, onCancel } = makeSessionOnly();
    picker.handleInput(ESC);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
