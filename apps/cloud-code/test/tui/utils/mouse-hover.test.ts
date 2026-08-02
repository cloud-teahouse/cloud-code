import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { visibleWidth, type MouseEvent } from '@cloud-code/pi-tui';
import chalk from 'chalk';

import {
  columnHitIndex,
  highlightBgIf,
  HoverState,
  rowHitIndex,
  trackHover,
  underlineText,
} from '#/tui/utils/mouse-hover';

const motion = (row: number, col = 1): MouseEvent => ({
  type: 'motion',
  button: 3,
  col,
  row,
  slotRelative: false,
});

describe('HoverState', () => {
  it('starts empty and reports changes only on actual transitions', () => {
    const hover = new HoverState();
    expect(hover.index).toBeNull();

    // null → index: changed
    expect(hover.update(2)).toBe(true);
    expect(hover.index).toBe(2);
    expect(hover.isHovered(2)).toBe(true);
    expect(hover.isHovered(1)).toBe(false);

    // same index again: unchanged (no re-render needed)
    expect(hover.update(2)).toBe(false);

    // index → different index: changed
    expect(hover.update(3)).toBe(true);

    // index → null (leave): changed, then stable
    expect(hover.update(null)).toBe(true);
    expect(hover.index).toBeNull();
    expect(hover.update(null)).toBe(false);
  });

  it('supports namespaced string keys for multi-region components', () => {
    const hover = new HoverState<string>();
    expect(hover.update('tab:1')).toBe(true);
    expect(hover.isHovered('tab:1')).toBe(true);
    expect(hover.isHovered('tab:0')).toBe(false);
    expect(hover.isHovered('row:1')).toBe(false);
    expect(hover.update('row:0')).toBe(true);
    expect(hover.update('row:0')).toBe(false);
  });
});

describe('trackHover', () => {
  it('maps motion rows through the hit test and reports changes', () => {
    const hover = new HoverState();
    const hitAt = (row: number): number | null => (row >= 2 && row <= 4 ? row - 2 : null);

    expect(trackHover(motion(0), hover, hitAt)).toBe(false); // header → null
    expect(hover.index).toBeNull();

    expect(trackHover(motion(3), hover, hitAt)).toBe(true); // row 3 → index 1
    expect(hover.index).toBe(1);

    expect(trackHover(motion(3), hover, hitAt)).toBe(false); // same cell → unchanged
    expect(trackHover(motion(99), hover, hitAt)).toBe(true); // off-list → cleared
    expect(hover.index).toBeNull();
  });

  it('treats row -1 (pointer left the component) as hover-clear', () => {
    const hover = new HoverState();
    const hitAt = (): number => 0;
    trackHover(motion(2), hover, hitAt);
    expect(hover.index).toBe(0);

    expect(trackHover(motion(-1), hover, hitAt)).toBe(true);
    expect(hover.index).toBeNull();
    // The hit test is not consulted for the leave signal.
    expect(trackHover(motion(-1), hover, () => {
      throw new Error('must not be called');
    })).toBe(false);
  });
});

describe('rowHitIndex', () => {
  it('walks per-item heights and returns the containing item', () => {
    const heights = [2, 1, 3]; // rows 0-1, 2, 3-5
    expect(rowHitIndex(heights, 0)).toBe(0);
    expect(rowHitIndex(heights, 1)).toBe(0);
    expect(rowHitIndex(heights, 2)).toBe(1);
    expect(rowHitIndex(heights, 3)).toBe(2);
    expect(rowHitIndex(heights, 5)).toBe(2);
  });

  it('returns null outside all items', () => {
    expect(rowHitIndex([1, 1], -1)).toBeNull();
    expect(rowHitIndex([1, 1], 2)).toBeNull();
    expect(rowHitIndex([], 0)).toBeNull();
  });
});

describe('columnHitIndex', () => {
  it('maps columns onto segmented cells with gaps', () => {
    // Cells of width 4 at columns 3-6, 9-12, 15-18 (gap 2).
    const widths = [4, 4, 4];
    expect(columnHitIndex(widths, 3, 2, 1)).toBeNull(); // leading padding
    expect(columnHitIndex(widths, 3, 2, 3)).toBe(0);
    expect(columnHitIndex(widths, 3, 2, 6)).toBe(0);
    expect(columnHitIndex(widths, 3, 2, 7)).toBeNull(); // gap
    expect(columnHitIndex(widths, 3, 2, 9)).toBe(1);
    expect(columnHitIndex(widths, 3, 2, 15)).toBe(2);
    expect(columnHitIndex(widths, 3, 2, 19)).toBeNull(); // past the last cell
  });
});

describe('underlineText', () => {
  // chalk auto-disables without a TTY; force colors on so the assertions
  // observe real SGR sequences.
  const prevLevel = chalk.level;
  beforeAll(() => {
    chalk.level = 1;
  });
  afterAll(() => {
    chalk.level = prevLevel;
  });

  // The default underline color is the theme's `text` token (#E0E0E0 in the
  // dark palette), set once as SGR 58 for the whole underlined run.
  const OPEN = '\x1b[58;2;224;224;224m\x1b[4m';
  const CLOSE = '\x1b[24m\x1b[59m';
  const stripSgr = (s: string): string => s.replaceAll(/\x1b\[[0-9;]*m/g, '');
  /** Visible text of the underlined run (between SGR 4 and SGR 24). */
  const run = (s: string): string =>
    stripSgr(/\x1b\[4m([\s\S]*?)\x1b\[24m/.exec(s)?.[1] ?? '');

  it('returns the input unchanged when not hovered, when colors are off, or without visible text', () => {
    expect(underlineText('row', false)).toBe('row');
    // All-padding lines have no text segment — returned unchanged.
    expect(underlineText('   ', true)).toBe('   ');
    const prev = chalk.level;
    chalk.level = 0;
    try {
      expect(underlineText('row', true)).toBe('row');
    } finally {
      chalk.level = prev;
    }
  });

  it('underlines exactly the visible text, leaving bare indentation and padding plain', () => {
    expect(underlineText('row', true)).toBe(`${OPEN}row${CLOSE}`);
    expect(underlineText('  padded   ', true)).toBe(`  ${OPEN}padded${CLOSE}   `);
  });

  it('measures the extent through styling: padding inside styled segments stays plain', () => {
    // Leading padding inside a dim segment, a red word, bare trailing padding.
    const styled = '\x1b[2m  \x1b[22m\x1b[31mred\x1b[39m   ';
    expect(underlineText(styled, true)).toBe(
      `\x1b[2m  \x1b[22m\x1b[31m${OPEN}red${CLOSE}\x1b[39m   `,
    );
  });

  it('keeps the interior spacing of a row under the same single run', () => {
    expect(underlineText('a  b', true)).toBe(`${OPEN}a  b${CLOSE}`);
  });

  it('covers glyph and wide-char rows exactly, without splitting astral characters', () => {
    // Pointer-prefixed selector row: the left margin stays plain, the run
    // starts at the pointer glyph.
    expect(underlineText('  ❯ Kimi K2  kimi', true)).toBe(`  ${OPEN}❯ Kimi K2  kimi${CLOSE}`);
    // CJK wide chars (the zh-CN thinking-control labels).
    expect(underlineText('  开  ', true)).toBe(`  ${OPEN}开${CLOSE}  `);
    // Astral-plane characters stay whole (no split surrogate pair).
    expect(underlineText(' 🚀 ok ', true)).toBe(` ${OPEN}🚀 ok${CLOSE} `);
  });

  it('matches the visible width of the text for padded, glyph, and wide-char lines', () => {
    expect(visibleWidth(run(underlineText('  padded   ', true)))).toBe(visibleWidth('padded'));
    expect(visibleWidth(run(underlineText('  ❯ K2.7  kimi', true)))).toBe(
      visibleWidth('❯ K2.7  kimi'),
    );
    expect(visibleWidth(run(underlineText('  开  ', true)))).toBe(2); // wide char: two cells
  });

  it('underlines a multi-segment row in one color and preserves the segment styling', () => {
    // A model-selector-shaped row: dim pointer segment, bright name, muted
    // provider — three foregrounds that used to tint their underline slice.
    const row =
      '\x1b[38;2;136;136;136m  ❯ \x1b[39m' +
      '\x1b[38;2;224;224;224mK2.7\x1b[39m' +
      '  ' +
      '\x1b[38;2;107;107;107mkimi\x1b[39m';
    const out = underlineText(row, true);
    // Exactly one underline run and one underline-color set/reset pair, no
    // matter how many styled segments the row mixes.
    expect(out.match(/\x1b\[4m/g)).toHaveLength(1);
    expect(out.match(/\x1b\[24m/g)).toHaveLength(1);
    expect(out.match(/\x1b\[58;2;224;224;224m/g)).toHaveLength(1);
    expect(out.match(/\x1b\[59m/g)).toHaveLength(1);
    // The run spans the row's whole text (pointer through provider), the
    // two-space margin stays plain, and the segment styling survives —
    // interior segments verbatim, the last segment's reset just past the
    // underline close.
    expect(run(out)).toBe('❯ K2.7  kimi');
    expect(stripSgr(out.slice(0, out.indexOf('\x1b[58;')))).toBe('  ');
    expect(out).toContain('\x1b[38;2;224;224;224mK2.7\x1b[39m');
    expect(out).toContain(`\x1b[38;2;107;107;107mkimi${CLOSE}\x1b[39m`);
  });

  it('defaults to the theme text token and accepts a hex override', () => {
    expect(underlineText('row', true)).toContain('\x1b[58;2;224;224;224m');
    expect(underlineText('row', true, '#ff0000')).toContain('\x1b[58;2;255;0;0m');
    expect(underlineText('row', true, '#0f0')).toContain('\x1b[58;2;0;255;0m');
    // An unparseable color degrades to a plain SGR 4 underline.
    expect(underlineText('row', true, 'not-a-color')).toBe('\x1b[4mrow\x1b[24m');
  });
});

describe('highlightBgIf', () => {
  const prevLevel = chalk.level;
  beforeAll(() => {
    chalk.level = 1;
  });
  afterAll(() => {
    chalk.level = prevLevel;
  });

  // The default background is the theme's `hoverBackground` token (#1F3A5F
  // in the dark palette).
  const OPEN = '\x1b[48;2;31;58;95m';
  const CLOSE = '\x1b[49m';

  it('returns the input unchanged when not hovered, when colors are off, or without visible text', () => {
    expect(highlightBgIf('word', false)).toBe('word');
    expect(highlightBgIf('   ', true)).toBe('   ');
    const prev = chalk.level;
    chalk.level = 0;
    try {
      expect(highlightBgIf('word', true)).toBe('word');
    } finally {
      chalk.level = prev;
    }
  });

  it('backgrounds exactly the visible text, leaving indentation and padding plain', () => {
    expect(highlightBgIf('word', true)).toBe(`${OPEN}word${CLOSE}`);
    expect(highlightBgIf('   daily   ', true)).toBe(`   ${OPEN}daily${CLOSE}   `);
  });

  it('measures the extent through styling: a styled word keeps its foreground', () => {
    // The Stats selector shape: a dim-styled word segment. SGR 39 closes the
    // foreground without touching the background, so the bg run wraps the
    // whole word while the segment styling survives.
    const styled = '\x1b[38;2;136;136;136mweekly\x1b[39m';
    expect(highlightBgIf(styled, true)).toBe(
      `\x1b[38;2;136;136;136m${OPEN}weekly${CLOSE}\x1b[39m`,
    );
  });

  it('defaults to the theme hoverBackground token and accepts a hex override', () => {
    expect(highlightBgIf('word', true)).toContain('\x1b[48;2;31;58;95m');
    expect(highlightBgIf('word', true, '#ff0000')).toContain('\x1b[48;2;255;0;0m');
    // An unparseable override degrades to the theme token.
    expect(highlightBgIf('word', true, 'not-a-color')).toContain('\x1b[48;2;31;58;95m');
  });
});
