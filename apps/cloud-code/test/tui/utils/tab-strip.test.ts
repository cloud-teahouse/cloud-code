import { describe, expect, it } from 'vitest';
import chalk from 'chalk';
import { hitZoneAt } from '@cloud-code/pi-tui';

import { darkColors } from '#/tui/theme/colors';
import { renderTabStrip, tabStripHitZones, tabStripIndexAtCol } from '#/tui/utils/tab-strip';

const ANSI_SGR = /\u001b\[[0-9;]*m/g;

function strip(text: string): string {
  return text.replaceAll(ANSI_SGR, '');
}

function render(labels: readonly string[], width: number, activeIndex = 0): string {
  const previousChalkLevel = chalk.level;
  chalk.level = 3;
  try {
    return strip(renderTabStrip({ labels, activeIndex, width, colors: darkColors }));
  } finally {
    chalk.level = previousChalkLevel;
  }
}

describe('renderTabStrip', () => {
  const labels = ['Installed', 'Official', 'Third-party', 'Custom'];
  // Cell widths: ` ${label} ` → 11 / 10 / 13 / 8 = 42, plus 3 separators and a
  // leading space → 46 columns total.
  const FULL_WIDTH = 46;

  it('shows the full strip when it exactly fits', () => {
    const out = render(labels, FULL_WIDTH);
    expect(out).toContain('Installed');
    expect(out).toContain('Custom');
    expect(out).not.toContain('<');
    expect(out).not.toContain('>');
  });

  it('scrolls (shows markers) when one column narrower than full fit', () => {
    const out = render(labels, FULL_WIDTH - 1, 0);
    expect(out).toContain('>');
    expect(out).not.toContain('Custom');
  });

  it('does not truncate the last tab when separators just barely fit', () => {
    // Regression: the old fit check summed only cell widths and ignored the
    // three inter-tab spaces, so at 43–45 columns it declared a fit while the
    // joined line was wider and the trailing tab got truncated.
    const out = render(labels, FULL_WIDTH);
    expect(out.endsWith(' Custom ')).toBe(true);
  });
});

describe('tabStripIndexAtCol', () => {
  const labels = ['Installed', 'Official', 'Third-party', 'Custom'];
  // Cell widths: 11 / 10 / 13 / 8; full strip = 46 columns.
  const FULL_WIDTH = 46;

  const hit = (col: number, width = FULL_WIDTH, activeIndex = 0): number | null =>
    tabStripIndexAtCol({ labels, activeIndex, width, col });

  it('maps each tab cell to its index in the full layout', () => {
    // Layout: col 1 leading space, cells at 2-12, 14-23, 25-37, 39-46.
    expect(hit(1)).toBeNull(); // leading space
    expect(hit(2)).toBe(0);
    expect(hit(12)).toBe(0);
    expect(hit(13)).toBeNull(); // separator
    expect(hit(14)).toBe(1);
    expect(hit(25)).toBe(2);
    expect(hit(37)).toBe(2);
    expect(hit(39)).toBe(3);
    expect(hit(46)).toBe(3);
    expect(hit(47)).toBeNull(); // past the strip
  });

  it('tracks the scrolled window and skips the < > markers', () => {
    // One column narrower than full fit with tab 0 active: scrolled right,
    // "Custom" is hidden behind the ` >` marker.
    expect(hit(45, FULL_WIDTH - 1, 0)).not.toBe(3);
    // With the last tab active the window scrolls left: ` <` frames the left.
    const activeLast = (col: number): number | null => hit(col, FULL_WIDTH - 1, 3);
    expect(activeLast(1)).toBeNull();
    expect(activeLast(2)).toBeNull(); // `< ` marker cells
    expect(activeLast(3)).not.toBeNull();
  });
});

describe('renderTabStrip hoverIndex', () => {
  it('underlines only the hovered tab cell', () => {
    const previousChalkLevel = chalk.level;
    chalk.level = 1;
    try {
      const out = renderTabStrip({
        labels: ['One', 'Two', 'Three'],
        activeIndex: 0,
        width: 40,
        colors: darkColors,
        hoverIndex: 1,
      });
      // The hovered cell is wrapped in SGR underline…
      expect(out).toContain('\x1b[4m');
      // …exactly once (one cell opens + closes the underline).
      expect(out.match(/\x1b\[4m/g)).toHaveLength(1);
      // Without a hover nothing is underlined (keyboard-only rendering).
      const plain = renderTabStrip({
        labels: ['One', 'Two', 'Three'],
        activeIndex: 0,
        width: 40,
        colors: darkColors,
      });
      expect(plain).not.toContain('\x1b[4m');
    } finally {
      chalk.level = previousChalkLevel;
    }
  });
});


describe('tabStripHitZones', () => {
  const labels = ['Installed', 'Official', 'Third-party', 'Custom'];
  // Cell widths: 11 / 10 / 13 / 8; full strip = 46 columns.
  const FULL_WIDTH = 46;

  it('declares one zone per visible tab, in strip coordinates', () => {
    const zones = tabStripHitZones({ labels, activeIndex: 0, width: FULL_WIDTH, row: 0 });
    expect(zones.map((zone) => zone.id)).toEqual([0, 1, 2, 3]);
    expect(zones.every((zone) => zone.row === 0 && zone.height === 1)).toBe(true);
    // Layout: cells at 1-based cols 2-12, 14-23, 25-37, 39-46.
    expect(zones[0]).toMatchObject({ col: 2, width: 11 });
    expect(zones[3]).toMatchObject({ col: 39, width: 8 });
  });

  it('places zones on the given row', () => {
    const zones = tabStripHitZones({ labels, activeIndex: 0, width: FULL_WIDTH, row: 4 });
    expect(zones.every((zone) => zone.row === 4)).toBe(true);
    expect(hitZoneAt(zones, 0, 2, 'action')).toBeNull();
    expect(hitZoneAt(zones, 4, 2, 'action')?.id).toBe(0);
  });

  it('hits exactly what tabStripIndexAtCol hits, across widths and active tabs', () => {
    // Parity sweep: the zone lookup must agree with the legacy column math on
    // every cell of every layout (full fit and every scrolled window).
    for (let width = FULL_WIDTH + 2; width >= 12; width--) {
      for (let activeIndex = 0; activeIndex < labels.length; activeIndex++) {
        const zones = tabStripHitZones({ labels, activeIndex, width, row: 0 });
        for (let col = 1; col <= FULL_WIDTH + 2; col++) {
          const zoned = hitZoneAt(zones, 0, col, 'action')?.id ?? null;
          const legacy = tabStripIndexAtCol({ labels, activeIndex, width, col });
          expect(zoned, `width=${width} active=${activeIndex} col=${col}`).toBe(legacy);
        }
      }
    }
  });

  it('excludes tabs scrolled out of the window', () => {
    // One column narrower than full fit with tab 0 active: "Custom" hides
    // behind the ` >` marker and gets no zone.
    const zones = tabStripHitZones({ labels, activeIndex: 0, width: FULL_WIDTH - 1, row: 0 });
    expect(zones.map((zone) => zone.id)).not.toContain(3);
  });
});
