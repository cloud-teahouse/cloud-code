import chalk from 'chalk';
import { afterEach, describe, expect, it } from 'vitest';

import type { MouseEvent } from '@cloud-code/pi-tui';

import { CompactionComponent } from '#/tui/components/dialogs/compaction';
import { currentTheme, darkColors, lightColors } from '#/tui/theme';

afterEach(() => {
  currentTheme.setPalette(darkColors);
});

function strip(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

describe('CompactionComponent', () => {
  it('renders the custom instruction below the compacting label', () => {
    const component = new CompactionComponent(undefined, 'keep the recent files only');

    try {
      const lines = component.render(120).map(strip);
      const text = lines.join('\n');

      expect(text).toContain('Compacting context...');
      expect(text).toContain('  keep the recent files only');
    } finally {
      component.dispose();
    }
  });

  it('renders a tip suffix while compacting', () => {
    const component = new CompactionComponent(undefined, undefined, 'ctrl+s: steer mid-turn');

    try {
      const lines = component.render(120).map(strip);
      const text = lines.join('\n');

      expect(text).toContain('Compacting context... · Tip: ctrl+s: steer mid-turn');
    } finally {
      component.dispose();
    }
  });

  it('does not render a tip after compaction completes', () => {
    const component = new CompactionComponent(undefined, undefined, 'ctrl+s: steer mid-turn');

    try {
      component.markDone(1000, 500);
      const lines = component.render(120).map(strip);
      const text = lines.join('\n');

      expect(text).toContain('Compaction complete');
      expect(text).not.toContain('Tip:');
      expect(text).not.toContain('Ctrl-O');
    } finally {
      component.dispose();
    }
  });

  it('renders a cancelled terminal state', () => {
    const component = new CompactionComponent();

    try {
      component.markCanceled();
      const lines = component.render(120).map(strip);
      const text = lines.join('\n');

      expect(text).toContain('Compaction cancelled');
      expect(text).not.toContain('Compacting context...');
    } finally {
      component.dispose();
    }
  });

  it('keeps the completed compaction summary hidden until expanded', () => {
    const component = new CompactionComponent();

    try {
      component.markDone(120, 24, 'Keep the src/tui compaction notes.');
      const collapsed = component.render(120).map(strip).join('\n');

      expect(collapsed).toContain('Compaction complete');
      expect(collapsed).toContain('120 → 24 tokens');
      expect(collapsed).toContain('Ctrl-O to show compaction summary');
      expect(collapsed).not.toContain('Keep the src/tui compaction notes.');

      component.setExpanded(true);
      const expanded = component.render(120).map(strip).join('\n');

      expect(expanded).toContain('Compaction complete');
      expect(expanded).toContain('Ctrl-O to hide compaction summary');
      expect(expanded).toContain('Keep the src/tui compaction notes.');
    } finally {
      component.dispose();
    }
  });

  it('hides the compaction summary again when collapsed', () => {
    const component = new CompactionComponent();

    try {
      component.markDone(120, 24, 'Keep the src/tui compaction notes.');
      component.setExpanded(true);
      component.setExpanded(false);
      const text = component.render(120).map(strip).join('\n');

      expect(text).toContain('Compaction complete');
      expect(text).toContain('Ctrl-O to show compaction summary');
      expect(text).not.toContain('Ctrl-O to hide compaction summary');
      expect(text).not.toContain('Keep the src/tui compaction notes.');
    } finally {
      component.dispose();
    }
  });

  it('preserves the expanded summary when invalidating with an instruction', () => {
    const component = new CompactionComponent(undefined, 'keep the recent files only');

    try {
      component.markDone(120, 24, 'Keep the src/tui compaction notes.');
      component.setExpanded(true);
      component.invalidate();
      const text = component.render(120).map(strip).join('\n');

      expect(text).toContain('keep the recent files only');
      expect(text).toContain('Keep the src/tui compaction notes.');
      expect(text.match(/keep the recent files only/g)).toHaveLength(1);
    } finally {
      component.dispose();
    }
  });

  it('keeps expanded summary child order on invalidate', () => {
    const component = new CompactionComponent(undefined, 'keep the recent files only');

    try {
      component.markDone(120, 24, 'Keep the src/tui compaction notes.');
      component.setExpanded(true);
      currentTheme.setPalette(lightColors);
      component.invalidate();
      const text = component.render(120).map(strip).join('\n');

      expect(text).toContain('Keep the src/tui compaction notes.');
      expect(text.indexOf('keep the recent files only')).toBeLessThan(
        text.indexOf('Keep the src/tui compaction notes.'),
      );
    } finally {
      component.dispose();
    }
  });

  it('repaints the header with the active palette on invalidate', () => {
    // Force truecolor so palette differences surface as ANSI codes even when
    // the test runner has no TTY.
    const previousLevel = chalk.level;
    chalk.level = 3;
    const component = new CompactionComponent();

    try {
      const headerOf = (): string => {
        const line = component.render(120).find((l) => strip(l).includes('Compacting context...'));
        if (line === undefined) throw new Error('header line not found');
        return line;
      };
      const before = headerOf();

      currentTheme.setPalette(lightColors);
      component.invalidate();
      const after = headerOf();

      // Same visible text, different ANSI colour codes.
      expect(strip(after)).toBe(strip(before));
      expect(after).not.toBe(before);
    } finally {
      chalk.level = previousLevel;
      component.dispose();
    }
  });
});

describe('CompactionComponent — progress bar', () => {
  it('shimmers the label and progress-line tail while in flight, freezing on completion', () => {
    // Force truecolor so the per-character wave shows up as rgb SGR runs.
    const previousLevel = chalk.level;
    chalk.level = 3;
    let now = 1_000_000;
    const component = new CompactionComponent(undefined, undefined, undefined, 100_000, () => now);
    const rgbRuns = (s: string): number => (s.match(/38;2;/g) ?? []).length;

    try {
      const header = component.render(120).find((l) => strip(l).includes('Compacting context...'));
      expect(header).toBeDefined();
      // The wave styles each label character individually.
      expect(rgbRuns(header!)).toBeGreaterThan(5);

      const progress = component.render(120).find((l) => strip(l).includes('%'));
      expect(progress).toBeDefined();
      // Bar (2 runs) + the shimmered percent/phase/elapsed tail (many runs).
      expect(rgbRuns(progress!)).toBeGreaterThan(5);
      // The bar glyphs themselves are not shimmered: the line still carries
      // exactly one success-run and one primary-run for the cells.
      expect(strip(progress!)).toContain('━'.repeat(12));

      component.markDone(100_000, 12_000);
      const doneHeader = component
        .render(120)
        .find((l) => strip(l).includes('Compaction complete'));
      expect(doneHeader).toBeDefined();
      // Finished: bullet + label + token detail only — no per-character wave.
      expect(rgbRuns(doneHeader!)).toBeLessThanOrEqual(3);
    } finally {
      chalk.level = previousLevel;
      component.dispose();
    }
  });

  it('renders an estimated progress line that advances with the clock', () => {
    let now = 1_000_000;
    const component = new CompactionComponent(
      undefined,
      undefined,
      undefined,
      100_000, // tokensBefore → estimate = 5s + 30s = 35s
      () => now,
    );

    try {
      const start = strip(component.render(120).join('\n'));
      expect(start).toContain('0%');
      expect(start).toContain('preparing');

      now += 17_500; // 50% of the estimate
      const mid = strip(component.render(120).join('\n'));
      expect(mid).toContain('50%');
      expect(mid).toContain('summarizing');
      expect(mid).toContain('17s');

      now += 100_000; // way past the estimate → capped at 95%
      const capped = strip(component.render(120).join('\n'));
      expect(capped).toContain('95%');
      expect(capped).toContain('finishing');
    } finally {
      component.dispose();
    }
  });

  it('drops the progress line on completion and on cancellation', () => {
    let now = 1_000_000;
    const component = new CompactionComponent(undefined, undefined, undefined, 100_000, () => now);
    try {
      expect(strip(component.render(120).join('\n'))).toContain('%');
      component.markDone(100_000, 12_000);
      const done = strip(component.render(120).join('\n'));
      expect(done).not.toContain('━');
      expect(done).toContain('Compaction complete');

      const cancelled = new CompactionComponent(undefined, undefined, undefined, 100_000, () => now);
      try {
        cancelled.markCanceled();
        expect(strip(cancelled.render(120).join('\n'))).not.toContain('━');
      } finally {
        cancelled.dispose();
      }
    } finally {
      component.dispose();
    }
  });
});

describe('CompactionComponent — click/hover affordance', () => {
  const mouse = undefined as unknown as MouseEvent;

  it('declares a hit zone only once a completed compaction has a summary', () => {
    const now = 1_000_000;
    const running = new CompactionComponent(undefined, undefined, undefined, 100_000, () => now);
    try {
      running.render(120);
      expect([...running.hitZones()]).toEqual([]);

      // Done without a summary: nothing to reveal — no zone.
      running.markDone(100_000, 12_000);
      running.render(120);
      expect([...running.hitZones()]).toEqual([]);
    } finally {
      running.dispose();
    }

    const cancelled = new CompactionComponent(undefined, undefined, undefined, 100_000, () => now);
    try {
      cancelled.markCanceled();
      cancelled.render(120);
      expect([...cancelled.hitZones()]).toEqual([]);
    } finally {
      cancelled.dispose();
    }

    const done = new CompactionComponent(undefined, undefined, undefined, 100_000, () => now);
    try {
      done.markDone(100_000, 12_000, 'Keep the compaction notes.');
      done.render(120);
      expect([...done.hitZones()]).toHaveLength(1);
    } finally {
      done.dispose();
    }
  });

  it('toggles the summary via clicks on the zone', () => {
    const component = new CompactionComponent();
    try {
      component.markDone(120, 24, 'Keep the src/tui compaction notes.');
      component.render(120);
      const zone = [...component.hitZones()][0]!;
      expect(strip(component.render(120).join('\n'))).not.toContain(
        'Keep the src/tui compaction notes.',
      );

      component.onHitZone(zone.id, mouse);
      expect(strip(component.render(120).join('\n'))).toContain(
        'Keep the src/tui compaction notes.',
      );

      // The zone stays while expanded so a click can fold the summary back.
      expect([...component.hitZones()]).toHaveLength(1);
      component.onHitZone(zone.id, mouse);
      expect(strip(component.render(120).join('\n'))).not.toContain(
        'Keep the src/tui compaction notes.',
      );
    } finally {
      component.dispose();
    }
  });

  it('whitens the block on hover and restores on leave', () => {
    // Force truecolor so the hover whiten shows up as changed ANSI codes.
    const previousLevel = chalk.level;
    chalk.level = 3;
    const component = new CompactionComponent();
    try {
      component.markDone(120, 24, 'Keep the src/tui compaction notes.');
      const normal = component.render(120);
      const zone = [...component.hitZones()][0]!;
      expect(component.setHoveredZone(zone.id)).not.toBe(false);
      const hovered = component.render(120);
      expect(hovered[1]).not.toBe(normal[1]);
      expect(component.setHoveredZone(null)).not.toBe(false);
      expect(component.render(120)[1]).toBe(normal[1]);
    } finally {
      chalk.level = previousLevel;
      component.dispose();
    }
  });
});
