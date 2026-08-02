import { visibleWidth, type MouseEvent, type SelectItem, type SelectListTheme } from '@cloud-code/pi-tui';
import { describe, expect, it } from 'vitest';

import { WrappingSelectList } from '#/tui/components/editor/wrapping-select-list';

/** Marker theme so assertions can see which style hook painted each part. */
const MARKER_THEME: SelectListTheme = {
  selectedPrefix: (s) => s,
  selectedText: (s) => `[S]${s}`,
  description: (s) => `[D]${s}`,
  scrollInfo: (s) => `[I]${s}`,
  noMatch: (s) => `[N]${s}`,
};

const IDENTITY_THEME: SelectListTheme = {
  selectedPrefix: (s) => s,
  selectedText: (s) => s,
  description: (s) => s,
  scrollInfo: (s) => s,
  noMatch: (s) => s,
};

/** Mirrors pi-tui's slash command layout (editor.js). */
const SLASH_LAYOUT = { minPrimaryColumnWidth: 12, maxPrimaryColumnWidth: 32 };

// With two 4-char labels and SLASH_LAYOUT at width 80, the primary column is
// 12 wide: prefix(2) + label(4) + spacing(8) puts descriptions at column 14
// with 64 columns of room (80 - 14 - 2 safety).
const DESCRIPTION_INDENT = ' '.repeat(14);

function makeList(items: SelectItem[], maxVisible = 5): WrappingSelectList {
  return new WrappingSelectList(items, maxVisible, MARKER_THEME, SLASH_LAYOUT);
}

describe('WrappingSelectList', () => {
  it('renders short descriptions on a single line', () => {
    const lines = makeList([
      { value: 'goal', label: 'goal', description: 'First command' },
      { value: 'init', label: 'init', description: 'Second command' },
    ]).render(80);

    expect(lines).toEqual([
      '[S]→ goal        First command',
      '  init[D]        Second command',
    ]);
  });

  it('wraps a long description onto a second indented line without an ellipsis', () => {
    const lines = makeList([
      { value: 'goal', label: 'goal', description: 'First command' },
      {
        value: 'init',
        label: 'init',
        description:
          'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt',
      },
    ]).render(80);

    expect(lines).toEqual([
      '[S]→ goal        First command',
      '  init[D]        lorem ipsum dolor sit amet consectetur adipiscing elit sed do',
      `[D]${DESCRIPTION_INDENT}eiusmod tempor incididunt`,
    ]);
  });

  it('caps descriptions at two lines and ellipsizes the overflow', () => {
    const description = 'lorem ipsum dolor sit amet consectetur adipiscing elit '.repeat(4).trim();
    const lines = makeList([
      { value: 'goal', label: 'goal', description: 'First command' },
      { value: 'init', label: 'init', description },
    ]).render(80);

    expect(lines).toHaveLength(3);
    expect(lines[1]).toMatch(/^ {2}init\[D\] {8}lorem ipsum/);
    expect(lines[2]).toMatch(new RegExp(`^\\[D\\]${DESCRIPTION_INDENT}`));
    expect(lines[2]!.endsWith('…')).toBe(true);
  });

  it('paints every line of the selected item with the selected style', () => {
    const description = 'lorem ipsum dolor sit amet consectetur adipiscing elit '.repeat(4).trim();
    const lines = makeList([
      { value: 'goal', label: 'goal', description },
      { value: 'init', label: 'init', description: 'Second command' },
    ]).render(80);

    expect(lines[0]).toMatch(/^\[S\]→ goal {8}lorem ipsum/);
    expect(lines[1]).toMatch(new RegExp(`^\\[S\\]${DESCRIPTION_INDENT}`));
    expect(lines[2]).toBe('  init[D]        Second command');
  });

  it('falls back to primary-only single lines on narrow widths', () => {
    const lines = makeList([
      { value: 'goal', label: 'goal', description: 'First command' },
      { value: 'init', label: 'init', description: 'Second command' },
    ]).render(40);

    expect(lines).toEqual(['[S]→ goal', '  init']);
  });

  it('keeps the scroll indicator when items overflow maxVisible', () => {
    const items = Array.from({ length: 7 }, (_, i) => ({
      value: `cmd${i}`,
      label: `cmd${i}`,
      description: 'Short',
    }));
    const lines = makeList(items, 5).render(80);

    expect(lines).toHaveLength(6);
    expect(lines[5]).toBe('[I]  (1/7)');
  });

  it('does not leak ANSI resets into themed lines when the primary name is truncated', () => {
    const description = 'Use when about to claim work is complete fixed or passing before committing';
    const lines = makeList([
      { value: 'verify', label: 'skill:verification-before-completion', description },
      { value: 'init', label: 'skill:another-very-long-command-name', description },
    ]).render(80);

    // truncateToWidth appends [0m when it truncates; embedded inside the
    // selected/description colouring it would reset the rest of the line.
    for (const line of lines) {
      expect(line).not.toContain('\u001B');
    }
  });

  it('never emits a line wider than the requested width, including CJK text', () => {
    const list = new WrappingSelectList(
      [
        { value: 'lark', label: 'skill:lark-calendar', description: '管理飞书日历的技能描述'.repeat(8) },
        { value: 'init', label: 'init', description: 'word '.repeat(60).trim() },
      ],
      5,
      IDENTITY_THEME,
      SLASH_LAYOUT,
    );

    for (const line of list.render(80)) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(80);
    }
  });
});

describe('WrappingSelectList mouse hit-testing', () => {
  // At width 80 with SLASH_LAYOUT the first item's long description wraps to
  // two rows, so painted rows are: wrap=0-1, second=2, third=3, fourth=4.
  const LONG =
    'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt';
  const press = (row: number): MouseEvent => ({ type: 'press', button: 0, col: 5, row, slotRelative: false });
  const mixedItems: SelectItem[] = [
    { value: 'wrap', label: 'wrap', description: LONG },
    { value: 'second', label: 'second', description: 'Second command' },
    { value: 'third', label: 'third', description: 'Third command' },
    { value: 'fourth', label: 'fourth', description: 'Fourth command' },
  ];

  it('selects the item whose painted row was clicked, including wrapped second rows', () => {
    const list = makeList(mixedItems);

    // Wrapped description row of 'wrap': one-row-per-item math reads 'second'.
    list.handleMouse(press(1));
    expect(list.getSelectedItem()?.value).toBe('wrap');
    list.handleMouse(press(2)); // 'second' — row 2, not item index 2
    expect(list.getSelectedItem()?.value).toBe('second');
    list.handleMouse(press(3)); // 'third'
    expect(list.getSelectedItem()?.value).toBe('third');
    list.handleMouse(press(4)); // 'fourth' — the last item
    expect(list.getSelectedItem()?.value).toBe('fourth');
  });

  it('confirms the selected item when its wrapped second row is re-clicked', () => {
    const list = makeList(mixedItems);
    const selected: string[] = [];
    list.onSelect = (item) => selected.push(item.value);

    list.handleMouse(press(1)); // selects 'wrap' (already selected: confirms)
    expect(selected).toEqual(['wrap']);
  });

  it('maps rows through a scrolled window with wrapped heights', () => {
    const items: SelectItem[] = [
      { value: 'cmd0', label: 'cmd0', description: 'Short' },
      { value: 'cmd1', label: 'cmd1', description: 'Short' },
      { value: 'cmd2', label: 'cmd2', description: LONG },
      { value: 'cmd3', label: 'cmd3', description: 'Short' },
      { value: 'cmd4', label: 'cmd4', description: 'Short' },
      { value: 'cmd5', label: 'cmd5', description: 'Short' },
      { value: 'cmd6', label: 'cmd6', description: 'Short' },
    ];
    const list = makeList(items, 5);
    list.setSelectedIndex(6);
    // Window: startIndex = min(6 - 2, 7 - 5) = 2 → cmd2..cmd6, and cmd2 wraps:
    // rows cmd2=0-1, cmd3=2, cmd4=3, cmd5=4, cmd6=5, scroll-info=6.
    const changes: string[] = [];
    list.onSelectionChange = (item) => changes.push(item.value);

    list.handleMouse(press(1)); // wrapped row of cmd2
    expect(changes).toEqual(['cmd2']);

    // The click re-centered the window on cmd2 (cmd0..cmd4, scroll-info at
    // row 6): rows past the painted items are not hits.
    list.handleMouse(press(6));
    list.handleMouse(press(9));
    expect(changes).toEqual(['cmd2']);

    // Back at the end of the list (window cmd2..cmd6), a click on the
    // already-selected last item's row confirms it.
    list.setSelectedIndex(6);
    const selected: string[] = [];
    list.onSelect = (item) => selected.push(item.value);
    list.handleMouse(press(5)); // cmd6 — the last item
    expect(selected).toEqual(['cmd6']);
  });
});

describe('WrappingSelectList hover highlight', () => {
  const HOVER_THEME: SelectListTheme = {
    ...MARKER_THEME,
    hoverText: (s) => `[H]${s}`,
  };
  const motion = (row: number): MouseEvent => ({ type: 'motion', button: 3, col: 5, row, slotRelative: false });

  const items: SelectItem[] = [
    { value: 'wrap', label: 'wrap', description: 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt' },
    { value: 'second', label: 'second', description: 'Second command' },
  ];

  it('paints the hovered item with the theme hoverText, wrapped rows included', () => {
    const list = new WrappingSelectList(items, 5, HOVER_THEME, SLASH_LAYOUT);
    const baseline = list.render(80);
    expect(baseline.join('\n')).not.toContain('[H]');

    // Painted rows: wrap=0-1 (wrapped description), second=2.
    expect(list.handleMouse(motion(2))).not.toBe(false);
    const hovered = list.render(80);
    expect(hovered[2]).toBe('[H]  second[D]      Second command');
    expect(hovered[0]).not.toContain('[H]');
    expect(hovered[1]).not.toContain('[H]');
    expect(list.handleMouse(motion(2))).toBe(false); // unchanged → frame skipped

    // Hovering the wrapped item backgrounds both of its painted rows.
    expect(list.handleMouse(motion(1))).not.toBe(false);
    const wrappedHover = list.render(80);
    expect(wrappedHover[0]).toContain('[H][S]→ wrap');
    expect(wrappedHover[1]).toContain('[H]');
    expect(wrappedHover[2]).not.toContain('[H]');

    // Pointer left → cleared, byte-identical to the no-mouse baseline.
    list.handleMouse(motion(-1));
    expect(list.render(80)).toEqual(baseline);
  });

  it('leaves rows unstyled when the theme has no hoverText', () => {
    const list = makeList(items);
    const baseline = list.render(80);
    list.handleMouse(motion(2));
    expect(list.render(80)).toEqual(baseline);
  });
});
