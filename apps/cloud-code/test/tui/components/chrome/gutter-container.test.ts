import type { Component } from '@cloud-code/pi-tui';
import { describe, expect, it, vi } from 'vitest';

import { EditorSlotContainer, GutterContainer } from '#/tui/components/chrome/gutter-container';

class FakeChild implements Component {
  constructor(
    private readonly lines: (innerWidth: number) => string[],
  ) {}
  invalidate(): void {}
  render(width: number): string[] {
    return this.lines(width);
  }
}

function stripAnsi(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

describe('GutterContainer', () => {
  it('prefixes every child line with `left` spaces', () => {
    const c = new GutterContainer(2, 2);
    c.addChild(new FakeChild(() => ['hello', 'world']));
    expect(c.render(20)).toEqual(['  hello', '  world']);
  });

  it('shrinks the width passed to children by left + right', () => {
    const seenWidth = vi.fn<(w: number) => string[]>(() => ['x']);
    const c = new GutterContainer(2, 3);
    c.addChild(new FakeChild(seenWidth));
    c.render(20);
    expect(seenWidth).toHaveBeenCalledWith(15);
  });

  it('clamps inner width to at least 1 when gutters would otherwise consume it', () => {
    const seenWidth = vi.fn<(w: number) => string[]>(() => ['x']);
    const c = new GutterContainer(5, 5);
    c.addChild(new FakeChild(seenWidth));
    c.render(2);
    expect(seenWidth).toHaveBeenCalledWith(1);
  });

  it('stacks lines from multiple children in order', () => {
    const c = new GutterContainer(1, 0);
    c.addChild(new FakeChild(() => ['a1', 'a2']));
    c.addChild(new FakeChild(() => ['b1']));
    expect(c.render(10)).toEqual([' a1', ' a2', ' b1']);
  });

  it('returns an empty array when there are no children', () => {
    const c = new GutterContainer(2, 2);
    expect(c.render(20)).toEqual([]);
  });

  it('preserves ANSI sequences within child lines (only the leading pad is plain)', () => {
    const colored = '[31mred[0m';
    const c = new GutterContainer(2, 2);
    c.addChild(new FakeChild(() => [colored]));
    expect(c.render(20)).toEqual([`  ${colored}`]);
  });
});

describe('EditorSlotContainer', () => {
  it('prepends a ▔ separator row across the inner width when topSeparator is on', () => {
    const c = new EditorSlotContainer(2, 2);
    c.topSeparator = true;
    c.addChild(new FakeChild(() => ['panel']));

    const out = c.render(20);

    expect(out).toHaveLength(2);
    // inner width = 20 - 2 - 2 = 16 dashes, offset by the 2-column gutter
    expect(stripAnsi(out[0]!)).toBe(`  ${'▔'.repeat(16)}`);
    expect(out[1]).toBe('  panel');
  });

  it('renders no separator when topSeparator is off', () => {
    const c = new EditorSlotContainer(2, 2);
    c.addChild(new FakeChild(() => ['panel']));
    expect(c.render(20)).toEqual(['  panel']);
  });

  it('keeps the separator out of the child list', () => {
    const c = new EditorSlotContainer(2, 2);
    c.topSeparator = true;
    const panel = new FakeChild(() => ['panel']);
    c.addChild(panel);
    expect(c.children).toEqual([panel]);
  });
});
