import { type Component } from '@cloud-code/pi-tui';
import { describe, expect, it } from 'vitest';

import { BottomAnchorContainer } from '#/tui/components/chrome/bottom-anchor-container';

// Inline-mode (fullscreen = false) filler math. Fullscreen mode never calls
// this container's render() — see fullscreen-layout.test.ts and pi-tui's
// tui-fullscreen tests for the split-region frame composition.

class FixedLinesComponent implements Component {
  constructor(
    private readonly lineCount: number,
    private readonly tag: string,
  ) {}

  invalidate(): void {}

  render(_width: number): string[] {
    return Array.from({ length: this.lineCount }, (_, i) => `${this.tag}-${i}`);
  }
}

function makeLayout(opts: { rows: () => number; transcriptLines: number; chromeLines: number }) {
  const transcript = new FixedLinesComponent(opts.transcriptLines, 't');
  const chrome = new FixedLinesComponent(opts.chromeLines, 'c');
  const root = new BottomAnchorContainer(opts.rows, transcript);
  root.addChild(transcript);
  root.addChild(chrome);
  return { root, transcript, chrome };
}

describe('BottomAnchorContainer filler (inline mode)', () => {
  it('empty session pads to exactly one screen of blank lines', () => {
    const { root } = makeLayout({ rows: () => 10, transcriptLines: 0, chromeLines: 0 });
    const lines = root.render(80);
    expect(lines).toHaveLength(10);
    expect(lines.every((line) => line === '')).toBe(true);
    expect(root.contentLines).toBe(0);
  });

  it('half-screen content pins the chrome to the last rows', () => {
    const { root } = makeLayout({ rows: () => 20, transcriptLines: 3, chromeLines: 4 });
    const lines = root.render(80);
    expect(lines).toHaveLength(20);
    expect(root.contentLines).toBe(7);
    // Transcript keeps its place at the top.
    expect(lines.slice(0, 3)).toEqual(['t-0', 't-1', 't-2']);
    // The filler gap sits between transcript and chrome.
    expect(lines.slice(3, 16).every((line) => line === '')).toBe(true);
    // Chrome lands on the very last rows.
    expect(lines.slice(16)).toEqual(['c-0', 'c-1', 'c-2', 'c-3']);
  });

  it('exactly-full screen degenerates to zero filler', () => {
    const { root } = makeLayout({ rows: () => 7, transcriptLines: 3, chromeLines: 4 });
    const lines = root.render(80);
    expect(lines).toHaveLength(7);
    expect(lines).toEqual(['t-0', 't-1', 't-2', 'c-0', 'c-1', 'c-2', 'c-3']);
  });

  it('overflowing content emits no filler and stays untouched', () => {
    const { root } = makeLayout({ rows: () => 5, transcriptLines: 6, chromeLines: 4 });
    const lines = root.render(80);
    expect(lines).toHaveLength(10);
    expect(root.contentLines).toBe(10);
    expect(lines[3]).toBe('t-3');
    expect(lines[9]).toBe('c-3');
  });

  it('recomputes the filler on resize', () => {
    let rows = 20;
    const { root } = makeLayout({ rows: () => rows, transcriptLines: 3, chromeLines: 4 });
    expect(root.render(80)).toHaveLength(20);

    rows = 30;
    expect(root.render(80)).toHaveLength(30);

    // Shrinking below the content height drops the filler entirely.
    rows = 5;
    expect(root.render(80)).toHaveLength(7);

    rows = 12;
    const lines = root.render(80);
    expect(lines).toHaveLength(12);
    expect(lines.slice(11)).toEqual(['c-3']);
  });

  it('inserts no gap when the anchor child is not mounted', () => {
    const anchor = new FixedLinesComponent(2, 'a');
    const root = new BottomAnchorContainer(() => 10, anchor);
    root.addChild(new FixedLinesComponent(3, 'x'));
    expect(root.render(80)).toHaveLength(3);
    expect(root.contentLines).toBe(3);
  });
});
