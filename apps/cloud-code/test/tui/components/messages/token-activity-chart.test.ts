import { visibleWidth } from '@cloud-code/pi-tui';
import chalk from 'chalk';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  buildTokenActivityChartLines,
  formatTokensCompact,
  gradeActivityLevels,
  shownActivityColumns,
  TokenActivityChartComponent,
  type TokenActivityBucket,
} from '#/tui/components/messages/token-activity-chart';
import { setLocalePreference } from '#/tui/i18n';
import { currentTheme, darkColors, lightColors } from '#/tui/theme';

const previousChalkLevel = chalk.level;
beforeAll(() => {
  chalk.level = 3;
});
afterAll(() => {
  chalk.level = previousChalkLevel;
});
afterEach(() => {
  currentTheme.setPalette(darkColors);
  setLocalePreference('en');
});

const ANSI_SGR = /\u001B\[[0-9;]*m/g;
function stripLines(lines: string[]): string[] {
  return lines.map((line) => line.replaceAll(ANSI_SGR, ''));
}

/** Wednesday 2025-01-15 (local time). Chart window starts Sun 2024-01-21. */
const TODAY = new Date(2025, 0, 15, 12, 0, 0);

function chart(buckets: readonly TokenActivityBucket[], width: number): string[] {
  return stripLines(buildTokenActivityChartLines({ buckets, width, today: TODAY }));
}

describe('buildTokenActivityChartLines', () => {
  it('renders the full 52-column grid at wide widths', () => {
    const lines = chart([{ date: '2025-01-14', tokens: 1000 }], 200);

    expect(lines).toHaveLength(12); // summary + blank + months + 7 rows + blank + legend
    expect(lines[0]).toBe(' Lifetime 1K · Peak 1K · Streak 1d');
    expect(lines[1]).toBe('');
    // Month row: week starting 2024-02-04 labels Feb, week of 2025-01-05 labels Jan.
    expect(lines[2]).toContain('Feb');
    expect(lines[2]).toContain('Jan');
    const gutters = [' Su ', ' Mo ', ' Tu ', ' We ', ' Th ', ' Fr ', ' Sa '];
    for (let row = 0; row < 7; row += 1) {
      const line = lines[3 + row] ?? '';
      expect(line.startsWith(gutters[row] ?? '')).toBe(true);
      expect(visibleWidth(line)).toBe(4 + 52 * 2 - 1);
    }
    expect(lines[10]).toBe('');
    expect(lines[11]).toContain('Less');
    expect(lines[11]).toContain('More');
  });

  it('shrinks the grid to fit narrow widths', () => {
    const lines = chart([{ date: '2025-01-14', tokens: 1000 }], 24);
    expect(shownActivityColumns(24)).toBe(10);
    for (let row = 0; row < 7; row += 1) {
      expect(visibleWidth(lines[3 + row] ?? '')).toBe(4 + 10 * 2 - 1);
    }
  });

  it('caps the grid at 52 columns', () => {
    expect(shownActivityColumns(200)).toBe(52);
    expect(shownActivityColumns(107)).toBe(52);
    expect(shownActivityColumns(106)).toBe(51);
  });

  it('shows the widen hint when no column fits', () => {
    const lines = chart([{ date: '2025-01-14', tokens: 1000 }], 4);
    expect(lines).toEqual([
      ' Lifetime 1K · Peak 1K · Streak 1d',
      '',
      '   Widen terminal to show activity graph',
    ]);
  });

  it('shows the empty state without data', () => {
    expect(chart([], 200)).toEqual(['   No token activity in the last 12 months']);
    // Zero-token buckets are not activity either.
    expect(chart([{ date: '2025-01-14', tokens: 0 }], 200)).toEqual([
      '   No token activity in the last 12 months',
    ]);
  });

  it('drops future-dated buckets from the summary and keeps their cells blank', () => {
    const lines = chart(
      [
        { date: '2025-01-14', tokens: 500 },
        { date: '2025-01-16', tokens: 5000 }, // Thursday of the same week: in-window future
      ],
      200,
    );
    expect(lines[0]).toContain('Lifetime 500');
    expect(lines[0]).not.toContain('5.5K');
    // Today is Wednesday, so Thu/Fri/Sa of the current (last) week are future
    // cells: spacer + blank at the row tail.
    expect(lines[3 + 4]?.endsWith('  ')).toBe(true); // Th
    expect(lines[3 + 5]?.endsWith('  ')).toBe(true); // Fr
    expect(lines[3 + 6]?.endsWith('  ')).toBe(true); // Sa
    // Today itself is not future — an empty □ cell, not a blank.
    expect(lines[3 + 3]?.endsWith('□')).toBe(true); // We
  });

  it('treats future-only data as no activity', () => {
    expect(chart([{ date: '2025-01-16', tokens: 5000 }], 200)).toEqual([
      '   No token activity in the last 12 months',
    ]);
  });

  it('merges duplicate dates and ignores invalid or negative buckets', () => {
    const lines = chart(
      [
        { date: '2025-01-14', tokens: 700 },
        { date: '2025-01-14', tokens: 800 },
        { date: '2025-01-13', tokens: -50 },
        { date: 'not-a-date', tokens: 9000 },
        { date: '2025-02-30', tokens: 9000 },
      ],
      200,
    );
    expect(lines[0]).toContain('Lifetime 1.5K');
    expect(lines[0]).toContain('Peak 1.5K');
  });

  it('computes the current streak with a yesterday grace day', () => {
    const streak = (dates: string[]): string => {
      const tokens = 100;
      const lines = chart(dates.map((date) => ({ date, tokens })), 200);
      return lines[0] ?? '';
    };
    expect(streak(['2025-01-13', '2025-01-14', '2025-01-15'])).toContain('Streak 3d');
    // Today still empty: streak counts back from yesterday.
    expect(streak(['2025-01-13', '2025-01-14'])).toContain('Streak 2d');
    // A gap breaks the run.
    expect(streak(['2025-01-10', '2025-01-14', '2025-01-15'])).toContain('Streak 2d');
    // Last activity before yesterday: no live streak.
    expect(streak(['2025-01-12', '2025-01-13'])).toContain('Streak 0d');
  });

  it('colours the 5 intensity levels as a smooth blue→gray gradient', () => {
    // Deliberate visual change (codex palette.rs parity): the harsh
    // textMuted→textDim→text→primary token jump became an interpolated
    // gradient — `primary` blended over the theme gray at codex's alpha
    // curve (0.22/0.42/0.68/1.00), so low-activity cells fade smoothly into
    // gray instead of flipping to white/blank.
    // Max 100 on day -1; 76 → 4, 51 → 3, 26 → 2, 25 → 1, empty → 0.
    const buckets: TokenActivityBucket[] = [
      { date: '2025-01-14', tokens: 100 },
      { date: '2025-01-13', tokens: 76 },
      { date: '2025-01-12', tokens: 51 },
      { date: '2025-01-11', tokens: 26 },
      { date: '2025-01-10', tokens: 25 },
    ];
    const raw = buildTokenActivityChartLines({ buckets, width: 200, today: TODAY }).join('\n');
    // Dark-theme stops: lerp(textDim #888888, primary #4FA8FF, alpha).
    const stops = ['#7b8fa2', '#7095ba', '#619ed9', '#4fa8ff'];
    expect(raw).toContain(chalk.hex(stops[0]!)('■')); // level 1: mostly gray, blue tint
    expect(raw).toContain(chalk.hex(stops[1]!)('■')); // level 2
    expect(raw).toContain(chalk.hex(stops[2]!)('■')); // level 3
    expect(raw).toContain(chalk.hex(stops[3]!).bold('■')); // level 4: full blue
    expect(raw).toContain(chalk.hex(darkColors.textMuted)('□')); // level 0
    // The stops form a smooth ramp: the blue channel strictly increases with
    // activity while red strictly decreases (gray → blue desaturation curve).
    const channel = (hex: string, offset: number): number =>
      Number.parseInt(hex.slice(offset, offset + 2), 16);
    for (let i = 1; i < stops.length; i += 1) {
      expect(channel(stops[i]!, 5)).toBeGreaterThan(channel(stops[i - 1]!, 5)); // blue ↑
      expect(channel(stops[i]!, 1)).toBeLessThan(channel(stops[i - 1]!, 1)); // red ↓
    }
    // Legend walks all five glyphs low → high.
    expect(stripLines([raw.split('\n').at(-1) ?? ''])[0]).toBe('   Less □ ■ ■ ■ ■ More');
  });

  it('computes the gradient from the live palette (light theme stops)', () => {
    currentTheme.setPalette(lightColors);
    const buckets: TokenActivityBucket[] = [
      { date: '2025-01-14', tokens: 100 },
      { date: '2025-01-13', tokens: 76 },
      { date: '2025-01-12', tokens: 51 },
      { date: '2025-01-11', tokens: 26 },
      { date: '2025-01-10', tokens: 25 },
    ];
    const raw = buildTokenActivityChartLines({ buckets, width: 200, today: TODAY }).join('\n');
    // Light-theme stops: lerp(textDim #454545, primary #1565C0, alpha).
    expect(raw).toContain(chalk.hex('#3a4c60')('■'));
    expect(raw).toContain(chalk.hex('#315279')('■'));
    expect(raw).toContain(chalk.hex('#245b99')('■'));
    expect(raw).toContain(chalk.hex('#1565c0').bold('■'));
  });

  it('degrades to nearest named colors below truecolor (chalk level 1-2)', () => {
    const prevLevel = chalk.level;
    chalk.level = 1;
    try {
      const buckets: TokenActivityBucket[] = [
        { date: '2025-01-14', tokens: 100 },
        { date: '2025-01-13', tokens: 76 },
        { date: '2025-01-12', tokens: 51 },
        { date: '2025-01-11', tokens: 26 },
        { date: '2025-01-10', tokens: 25 },
      ];
      const raw = buildTokenActivityChartLines({ buckets, width: 200, today: TODAY }).join('\n');
      // No truecolor escapes; hex tokens degrade to basic codes and keep the
      // gray → blue → bold ramp readable (named-color calls are guard-banned).
      expect(raw).not.toContain('38;2;');
      expect(raw).toContain(chalk.hex(currentTheme.color('primary'))('■')); // levels 2-3
      expect(raw).toContain(chalk.hex(currentTheme.color('primary')).bold('■')); // level 4
      expect(raw).toContain(chalk.hex(currentTheme.color('textDim'))('■')); // level 1
      expect(raw).toContain(chalk.hex(currentTheme.color('textDim'))('□')); // level 0
      // Glyphs and legend are untouched by the fallback.
      expect(stripLines([raw.split('\n').at(-1) ?? ''])[0]).toBe('   Less □ ■ ■ ■ ■ More');
    } finally {
      chalk.level = prevLevel;
    }
  });

  it('renders zh-CN copy', () => {
    setLocalePreference('zh-CN');
    const lines = chart([{ date: '2025-01-14', tokens: 1000 }], 200);
    expect(lines[0]).toBe(' 累计 1K · 峰值 1K · 连续 1d');
    expect(lines[2]).toContain('2月');
    expect(lines[2]).toContain('1月');
    expect(lines[11]).toContain('少');
    expect(lines[11]).toContain('多');

    expect(chart([{ date: '2025-01-14', tokens: 1000 }], 4).at(-1)).toBe(
      '   加宽终端以显示活动图',
    );
    expect(chart([], 200)).toEqual(['   近 12 个月没有 token 活动']);
  });
});

describe('gradeActivityLevels', () => {
  it('matches the codex thresholds at every boundary', () => {
    // max = 100: v*4>300 → 4, v*2>100 → 3, v*4>100 → 2, else 1.
    expect(gradeActivityLevels([100, 76, 75, 51, 50, 26, 25, 1, 0])).toEqual([
      4, 4, 3, 3, 2, 2, 1, 1, 0,
    ]);
  });

  it('is all-zero when the window has no activity', () => {
    expect(gradeActivityLevels([0, 0, 0])).toEqual([0, 0, 0]);
  });
});

describe('formatTokensCompact', () => {
  it('formats K/M/B/T with trimmed decimals', () => {
    expect(formatTokensCompact(0)).toBe('0');
    expect(formatTokensCompact(-5)).toBe('0');
    expect(formatTokensCompact(999)).toBe('999');
    expect(formatTokensCompact(1000)).toBe('1K');
    expect(formatTokensCompact(1234)).toBe('1.23K');
    expect(formatTokensCompact(1500)).toBe('1.5K');
    expect(formatTokensCompact(12_345)).toBe('12.3K');
    expect(formatTokensCompact(123_456)).toBe('123K');
    expect(formatTokensCompact(1_234_567)).toBe('1.23M');
    expect(formatTokensCompact(2_500_000)).toBe('2.5M');
    expect(formatTokensCompact(1_000_000_000)).toBe('1B');
    expect(formatTokensCompact(1_234_000_000_000)).toBe('1.23T');
  });
});

describe('TokenActivityChartComponent', () => {
  it('renders the chart with a leading blank line for the transcript', () => {
    const component = new TokenActivityChartComponent(
      [{ date: '2025-01-14', tokens: 1000 }],
      TODAY,
    );
    const lines = stripLines(component.render(200));
    expect(lines[0]).toBe('');
    expect(lines.slice(1)).toEqual(chart([{ date: '2025-01-14', tokens: 1000 }], 200));
  });
});

describe('buildTokenActivityChartLines — weekly/cumulative ranges', () => {
  // Two active weeks at the window tail: week of 2025-01-05 totals 500,
  // current week (2025-01-12…) totals 1000.
  const BUCKETS: TokenActivityBucket[] = [
    { date: '2025-01-08', tokens: 500 },
    { date: '2025-01-13', tokens: 300 },
    { date: '2025-01-14', tokens: 700 },
  ];

  function chartView(view: 'weekly' | 'cumulative', width = 200): string[] {
    return stripLines(buildTokenActivityChartLines({ buckets: BUCKETS, width, today: TODAY, view }));
  }

  it('weekly: bottom-up bars scaled to the tallest week, with a y-axis gutter', () => {
    const lines = chartView('weekly');
    expect(lines).toHaveLength(12);
    expect(lines[0]).toBe(' Lifetime 1.5K · Peak 700 · Streak 2d');
    expect(lines[3]?.startsWith('max ')).toBe(true);
    expect(lines[9]?.startsWith('  0 ')).toBe(true);
    // Current week (last column) is the max → full-height bar on every row.
    for (let row = 0; row < 7; row += 1) {
      expect(lines[3 + row]?.endsWith('█')).toBe(true);
    }
    // Previous week at half height (ceil(500*7/1000)=4): blank at rows 0–2.
    // Trailing 3 chars = previous-week cell + separator + current-week cell.
    expect(lines[3 + 0]?.slice(-3)).toBe('  █');
    expect(lines[3 + 3]?.slice(-3)).toBe('█ █');
    // Caption replaces the Less/More legend.
    expect(lines[11]).toBe('   Each column = 1 week · tallest 1K');
    expect(lines.join('\n')).not.toContain('Less');
  });

  it('cumulative: running weekly totals rising to the right', () => {
    const lines = chartView('cumulative');
    expect(lines[3]?.startsWith('max ')).toBe(true);
    // Series tail: …, 500, 1500 → heights ceil(500*7/1500)=3 and 7.
    expect(lines[3 + 0]?.slice(-3)).toBe('  █');
    expect(lines[3 + 4]?.slice(-3)).toBe('█ █');
    expect(lines[3 + 6]?.slice(-3)).toBe('█ █');
    expect(lines[11]).toBe('   Running total · top 1.5K');
  });

  it('keeps the summary and month rows on bar views; empty state is shared', () => {
    expect(chartView('weekly')[2]).toContain('Jan');
    expect(
      stripLines(buildTokenActivityChartLines({ buckets: [], width: 200, today: TODAY, view: 'weekly' })),
    ).toEqual(['   No token activity in the last 12 months']);
  });

  it('renders zh-CN bar captions', () => {
    setLocalePreference('zh-CN');
    expect(chartView('weekly')[11]).toBe('   每列 = 1 周 · 最高 1K');
    expect(chartView('cumulative')[11]).toBe('   累计总量 · 峰值 1.5K');
  });
});
