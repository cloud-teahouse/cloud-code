/**
 * Token activity heatmap — codex `/usage` 52-week style
 * (`codex-rs/tui/src/chatwidget/tokens/chart.rs`), fed by locally aggregated
 * wire data instead of codex's backend buckets.
 *
 * Layout (Daily view):
 *
 *    Lifetime 1.23M · Peak 45.6K · Streak 7d
 *
 *        Aug       Sep       Oct
 *    Su □ ■ ■ □ …
 *    Mo …
 *    …
 *    Sa …
 *
 *    Less □ ■ ■ ■ ■ More
 *
 * The Weekly and Cumulative views reuse the same 52-week window as bottom-up
 * `█` bar columns (each column = one week, or the running weekly total) with
 * a `max `…`  0 ` y-axis gutter and a caption replacing the legend — codex
 * `bar_levels` / `bar_caption` parity.
 *
 * Colour strategy: a smooth blue→gray gradient, codex `palette.rs` style.
 * codex blends the theme accent over the terminal background at 4 alphas in
 * truecolor terminals; our palette has no background token, so the gradient
 * instead interpolates `primary` over the theme's gray (`textDim`) at the
 * same alpha curve (0.22 / 0.42 / 0.68 / 1.00) — full blue at peak activity,
 * progressively desaturated blue-gray as activity drops, computed from the
 * live palette so custom themes get a sensible ramp for free. Level 0 keeps
 * codex's low-color hollow `□` in `textMuted` (future cells stay blank), so
 * empty vs active stays distinguishable even when the terminal strips
 * colours (chalk level 0). Below truecolor (chalk level 1-2) the stops
 * degrade to the nearest named colors (gray → blue → bold blue), matching
 * codex's Ansi16 fallback of dim + one accent colour.
 *
 * The weekday gutter stays ASCII (`Su`…`Sa`) in every locale: full-width CJK
 * weekday glyphs render at inconsistent widths across terminals and would
 * break grid alignment.
 */

import { visibleWidth, type Component } from '@cloud-code/pi-tui';
import chalk from 'chalk';

import { t } from '#/tui/i18n';
import { currentTheme } from '#/tui/theme';

const WEEK_COUNT = 52;
const DAY_COUNT = 7;
const CELL_COUNT = WEEK_COUNT * DAY_COUNT;
/** Width of the weekday gutter (`" Su "`) before the first cell column. */
const CHART_LEFT_WIDTH = 4;
const EMPTY_CELL_GLYPH = '□';
const ACTIVE_CELL_GLYPH = '■';

/** One day of aggregated tokens. `date` is a local `YYYY-MM-DD` key. */
export interface TokenActivityBucket {
  readonly date: string;
  readonly tokens: number;
}

/** Chart ranges, mirroring codex `TokenActivityView` (chart.rs). */
export type TokenActivityView = 'daily' | 'weekly' | 'cumulative';

export interface TokenActivityChartInput {
  readonly buckets: readonly TokenActivityBucket[];
  /** Total columns available for the chart, gutter included. */
  readonly width: number;
  /** "Today" for windowing/streaks; injectable for tests. Defaults to now. */
  readonly today?: Date | undefined;
  /** Range view; defaults to 'daily' (the classic 52-week heatmap). */
  readonly view?: TokenActivityView | undefined;
}

/**
 * codex `format_tokens_compact`: decimal K/M/B/T, 2 decimals below 10, 1
 * below 100, 0 above, trailing zeros trimmed (`1.50K` → `1.5K`). Distinct
 * from `formatTokenCount` (1024-based, `k`/`M`) used by context sizes.
 */
export function formatTokensCompact(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0';
  const v = Math.floor(value);
  if (v < 1_000) return String(v);
  const [scaled, suffix] =
    v >= 1_000_000_000_000
      ? [v / 1_000_000_000_000, 'T']
      : v >= 1_000_000_000
        ? [v / 1_000_000_000, 'B']
        : v >= 1_000_000
          ? [v / 1_000_000, 'M']
          : [v / 1_000, 'K'];
  const decimals = scaled < 10 ? 2 : scaled < 100 ? 1 : 0;
  let formatted = scaled.toFixed(decimals);
  if (formatted.includes('.')) {
    formatted = formatted.replaceAll(/0+$/g, '').replaceAll(/\.$/g, '');
  }
  return `${formatted}${suffix}`;
}

/**
 * codex `graded_levels`: relative to the window max, exactly
 * `v*4>max*3 → 4`, `v*2>max → 3`, `v*4>max → 2`, else 1 (0 when v or max is 0).
 */
export function gradeActivityLevels(values: readonly number[]): number[] {
  const max = values.reduce((a, b) => Math.max(a, b), 0);
  return values.map((value) => {
    if (value <= 0 || max <= 0) return 0;
    if (value * 4 > max * 3) return 4;
    if (value * 2 > max) return 3;
    if (value * 4 > max) return 2;
    return 1;
  });
}

/** codex `shown_columns`: each cell column costs 2 cols (glyph + spacer). */
export function shownActivityColumns(width: number): number {
  return Math.min(WEEK_COUNT, Math.floor((Math.max(0, width) - CHART_LEFT_WIDTH + 1) / 2));
}

/* ── Local-time date helpers (bucket keys are local `YYYY-MM-DD`) ── */

function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addLocalDays(date: Date, days: number): Date {
  const result = startOfLocalDay(date);
  result.setDate(result.getDate() + days);
  return result;
}

function dayKeyOf(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function isDayKey(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return false;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  const date = new Date(y, m - 1, d);
  return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d;
}

const WEEKDAY_GUTTER = [' Su ', ' Mo ', ' Tu ', ' We ', ' Th ', ' Fr ', ' Sa '] as const;

function dim(text: string): string {
  return currentTheme.fg('textDim', text);
}

function numeric(text: string): string {
  return currentTheme.fg('success', text);
}

/** codex `alphas`: the anchor's blend factor per activity level (1-based). */
const GRADIENT_ALPHAS = [0.22, 0.42, 0.68, 1] as const;

/** Parses a #rrggbb palette hex into RGB channels; null otherwise. */
function hexToRgb(hex: string): readonly [number, number, number] | null {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return null;
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
}

function rgbToHex(rgb: readonly [number, number, number]): string {
  return `#${rgb.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * The gradient stop for an activity level (1-4): `primary` blended over the
 * theme's gray at the codex alpha curve, computed from the live palette.
 * Falls back to the raw tokens when a custom theme carries an unparseable
 * value (the JSON loader validates hex, so this is only a belt-and-braces
 * guard for programmatic palettes).
 */
function gradientStop(level: 1 | 2 | 3 | 4): string {
  const gray = hexToRgb(currentTheme.color('textDim'));
  const blue = hexToRgb(currentTheme.color('primary'));
  if (gray === null || blue === null) {
    return currentTheme.color(level <= 1 ? 'textDim' : level === 2 ? 'text' : 'primary');
  }
  const alpha = GRADIENT_ALPHAS[level - 1]!;
  return rgbToHex([
    Math.round(gray[0] + (blue[0] - gray[0]) * alpha),
    Math.round(gray[1] + (blue[1] - gray[1]) * alpha),
    Math.round(gray[2] + (blue[2] - gray[2]) * alpha),
  ]);
}

/**
 * Level → style ramp (see the module header). Truecolor terminals get the
 * interpolated gradient; below truecolor the stops collapse to the nearest
 * named colors (gray → blue → bold blue), and the □/■ glyph pair keeps
 * empty vs active readable even with colours stripped entirely.
 */
function levelStyle(level: number, text: string): string {
  const l = Math.min(4, Math.max(0, level));
  if (chalk.level < 3) {
    // hex degrades to the nearest basic color at low levels, keeping a
    // gray → blue → bold blue ramp without named-color calls.
    if (l <= 1) return chalk.hex(currentTheme.color('textDim'))(text);
    if (l <= 3) return chalk.hex(currentTheme.color('primary'))(text);
    return chalk.hex(currentTheme.color('primary')).bold(text);
  }
  if (l === 0) return currentTheme.fg('textMuted', text);
  const stop = gradientStop(l as 1 | 2 | 3 | 4);
  return l === 4 ? chalk.hex(stop).bold(text) : chalk.hex(stop)(text);
}

function levelGlyph(level: number): string {
  return level === 0 ? EMPTY_CELL_GLYPH : ACTIVE_CELL_GLYPH;
}

function cellSpan(level: number): string {
  return levelStyle(level, levelGlyph(level));
}

interface NormalizedActivity {
  /** Window cell values, ordered by chart cell from the oldest Sunday. */
  readonly values: number[];
  /** Sum over every valid non-future bucket (not just the 52-week window). */
  readonly lifetime: number;
  readonly peak: number;
  readonly streakDays: number;
  readonly hasActivity: boolean;
}

function normalizeActivity(buckets: readonly TokenActivityBucket[], today: Date): NormalizedActivity {
  const todayKey = dayKeyOf(today);
  const byDate = new Map<string, number>();
  let lifetime = 0;
  let peak = 0;
  for (const bucket of buckets) {
    if (!isDayKey(bucket.date)) continue;
    if (bucket.date > todayKey) continue; // clock-skewed future data is dropped everywhere
    const tokens = Number.isFinite(bucket.tokens) ? Math.max(0, Math.floor(bucket.tokens)) : 0;
    if (tokens === 0) continue;
    const merged = (byDate.get(bucket.date) ?? 0) + tokens;
    byDate.set(bucket.date, merged);
    lifetime += tokens;
    peak = Math.max(peak, merged);
  }

  const weekStart = addLocalDays(today, -today.getDay());
  const start = addLocalDays(weekStart, -(WEEK_COUNT - 1) * DAY_COUNT);
  const values: number[] = [];
  for (let offset = 0; offset < CELL_COUNT; offset += 1) {
    values.push(byDate.get(dayKeyOf(addLocalDays(start, offset))) ?? 0);
  }

  return {
    values,
    lifetime,
    peak,
    streakDays: currentStreakDays(byDate, today),
    hasActivity: byDate.size > 0,
  };
}

/**
 * Consecutive active days ending today; when today has no activity yet the
 * streak still counts back from yesterday (a streak dies after a full missed
 * day, not at midnight).
 */
function currentStreakDays(byDate: ReadonlyMap<string, number>, today: Date): number {
  let cursor = today;
  if (!byDate.has(dayKeyOf(cursor))) {
    cursor = addLocalDays(cursor, -1);
    if (!byDate.has(dayKeyOf(cursor))) return 0;
  }
  let streak = 0;
  while (byDate.has(dayKeyOf(cursor))) {
    streak += 1;
    cursor = addLocalDays(cursor, -1);
  }
  return streak;
}

const MONTH_KEYS = [
  'token-activity.month.1',
  'token-activity.month.2',
  'token-activity.month.3',
  'token-activity.month.4',
  'token-activity.month.5',
  'token-activity.month.6',
  'token-activity.month.7',
  'token-activity.month.8',
  'token-activity.month.9',
  'token-activity.month.10',
  'token-activity.month.11',
  'token-activity.month.12',
] as const;

/** Localized month abbreviation for a 1-based month number (chart label row). */
export function tokenActivityMonthLabel(month: number): string {
  return t(MONTH_KEYS[month - 1] ?? 'token-activity.month.1');
}

/**
 * codex `month_labels`: label a column when its week's first day (Sunday) is
 * within the first 7 days of a month; skip labels that would overlap the
 * previous one or overflow the row.
 */
function buildMonthLabelRow(today: Date, firstColumn: number, shownColumns: number): string {
  const weekStart = addLocalDays(today, -today.getDay());
  const start = addLocalDays(weekStart, -(WEEK_COUNT - 1) * DAY_COUNT);
  const rowWidth = shownColumns * 2 - 1;
  const cells: string[] = Array.from({ length: rowWidth }, () => ' ');
  let lastEnd = 0;
  for (let column = firstColumn; column < WEEK_COUNT; column += 1) {
    const date = addLocalDays(start, column * DAY_COUNT);
    if (date.getDate() > DAY_COUNT) continue;
    const label = tokenActivityMonthLabel(date.getMonth() + 1);
    const offset = (column - firstColumn) * 2;
    const labelWidth = visibleWidth(label);
    if (offset < lastEnd || offset + labelWidth > rowWidth) continue;
    // `cells` tracks display columns, not glyphs: a wide (CJK) glyph takes
    // one slot and blanks the continuation slot(s) it covers, so joining the
    // array reproduces the exact display width.
    let cursor = offset;
    for (const glyph of label) {
      const w = visibleWidth(glyph);
      cells[cursor] = glyph;
      for (let extra = 1; extra < w; extra += 1) {
        cells[cursor + extra] = '';
      }
      cursor += w;
    }
    lastEnd = offset + labelWidth + 1;
  }
  return ' '.repeat(CHART_LEFT_WIDTH) + dim(cells.join('').trimEnd());
}

function buildSummaryLine(activity: NormalizedActivity): string {
  // codex dims labels/separators and colours values; chalk restores the dim
  // style after each nested numeric span closes.
  return ` ${dim(
    t('token-activity.summary', {
      total: numeric(formatTokensCompact(activity.lifetime)),
      peak: numeric(formatTokensCompact(activity.peak)),
      streak: numeric(String(activity.streakDays)),
    }),
  )}`;
}

function buildLegendLine(): string {
  const glyphs: string[] = [];
  for (let level = 0; level <= 4; level += 1) {
    glyphs.push(cellSpan(level));
  }
  return `   ${dim(t('token-activity.less'))} ${glyphs.join(' ')} ${dim(t('token-activity.more'))}`;
}

/**
 * Build the chart lines: summary, blank, month row, 7 grid rows, blank, then
 * the legend (daily) or bar caption (weekly/cumulative). Empty states degrade
 * to a single dim line (codex parity).
 */
export function buildTokenActivityChartLines(input: TokenActivityChartInput): string[] {
  const view = input.view ?? 'daily';
  const today = startOfLocalDay(input.today ?? new Date());
  const activity = normalizeActivity(input.buckets, today);
  if (!activity.hasActivity) {
    return [dim(`   ${t('token-activity.empty')}`)];
  }

  const shownColumns = shownActivityColumns(input.width);
  if (shownColumns === 0) {
    return [buildSummaryLine(activity), '', dim(`   ${t('token-activity.widen')}`)];
  }
  const firstColumn = WEEK_COUNT - shownColumns;

  const header = [buildSummaryLine(activity), '', buildMonthLabelRow(today, firstColumn, shownColumns)];
  return view === 'daily'
    ? [...header, ...buildDailyGridLines(activity, today, firstColumn)]
    : [...header, ...buildBarGridLines(activity, view, firstColumn)];
}

/** Daily view: the 52×7 GitHub-style heatmap grid + Less/More legend. */
function buildDailyGridLines(
  activity: NormalizedActivity,
  today: Date,
  firstColumn: number,
): string[] {
  const levels = gradeActivityLevels(activity.values);
  const todayKey = dayKeyOf(today);
  const weekStart = addLocalDays(today, -today.getDay());
  const start = addLocalDays(weekStart, -(WEEK_COUNT - 1) * DAY_COUNT);

  const lines: string[] = [];
  for (let row = 0; row < DAY_COUNT; row += 1) {
    let line = dim(WEEKDAY_GUTTER[row] ?? '    ');
    for (let column = firstColumn; column < WEEK_COUNT; column += 1) {
      if (column > firstColumn) line += ' ';
      const index = column * DAY_COUNT + row;
      if (dayKeyOf(addLocalDays(start, index)) > todayKey) {
        line += ' '; // future dates stay blank
      } else {
        line += cellSpan(levels[index] ?? 0);
      }
    }
    lines.push(line);
  }
  lines.push('', buildLegendLine());
  return lines;
}

// ── Weekly / cumulative bar views (codex `bar_levels` / `bar_caption`) ──

const BAR_CELL_GLYPH = '█';

/** codex `weekly_totals`: one total per week column. */
function weeklyTotals(values: readonly number[]): number[] {
  const totals: number[] = [];
  for (let week = 0; week < WEEK_COUNT; week += 1) {
    let sum = 0;
    for (let day = 0; day < DAY_COUNT; day += 1) {
      sum += values[week * DAY_COUNT + day] ?? 0;
    }
    totals.push(sum);
  }
  return totals;
}

/** Weekly: per-week totals; cumulative: their running total (codex `scan`). */
function barSeries(values: readonly number[], view: 'weekly' | 'cumulative'): number[] {
  const weeks = weeklyTotals(values);
  if (view === 'weekly') return weeks;
  let sum = 0;
  return weeks.map((week) => (sum += week));
}

/**
 * codex `bar_levels`: heights are ceil-scaled to the max column
 * (`(value*7 + max-1) / max`), cells fill bottom-up; filled = level 4.
 */
function barLevels(totals: readonly number[]): number[] {
  const max = totals.reduce((a, b) => Math.max(a, b), 0);
  const levels: number[] = [];
  for (const value of totals) {
    const height = value <= 0 || max <= 0 ? 0 : Math.ceil((value * DAY_COUNT) / max);
    for (let row = 0; row < DAY_COUNT; row += 1) {
      levels.push(DAY_COUNT - row <= height ? 4 : 0);
    }
  }
  return levels;
}

/** codex `weekday_label` for bar views: the gutter doubles as a coarse Y-axis. */
function barGutter(row: number): string {
  if (row === 0) return 'max ';
  if (row === DAY_COUNT - 1) return '  0 ';
  return '    ';
}

/** Bar grid + caption; filled cells use the ramp's top level, empty = space. */
function buildBarGridLines(
  activity: NormalizedActivity,
  view: 'weekly' | 'cumulative',
  firstColumn: number,
): string[] {
  const series = barSeries(activity.values, view);
  const levels = barLevels(series);

  const lines: string[] = [];
  for (let row = 0; row < DAY_COUNT; row += 1) {
    let line = dim(barGutter(row));
    for (let column = firstColumn; column < WEEK_COUNT; column += 1) {
      if (column > firstColumn) line += ' ';
      const level = levels[column * DAY_COUNT + row] ?? 0;
      line += level === 0 ? ' ' : levelStyle(4, BAR_CELL_GLYPH);
    }
    lines.push(line);
  }
  lines.push('', buildBarCaption(view, series));
  return lines;
}

/**
 * codex `bar_caption`: states what each bar represents and the peak it is
 * scaled to. For the cumulative view the running total's top is the final
 * (largest) column, i.e. the series max.
 */
function buildBarCaption(view: 'weekly' | 'cumulative', series: readonly number[]): string {
  const top = series.reduce((a, b) => Math.max(a, b), 0);
  const caption =
    view === 'weekly'
      ? t('token-activity.weeklyCaption', { peak: numeric(formatTokensCompact(top)) })
      : t('token-activity.cumulativeCaption', { total: numeric(formatTokensCompact(top)) });
  return `   ${dim(caption)}`;
}

/**
 * Transcript-ready wrapper. Pure render: lines are rebuilt on every
 * `render(width)` so theme/locale hot-switches repaint without an explicit
 * invalidate (the chart only renders on demand, so there is no hot loop).
 */
export class TokenActivityChartComponent implements Component {
  constructor(
    private readonly buckets: readonly TokenActivityBucket[],
    private readonly today?: Date,
  ) {}

  invalidate(): void {}

  render(width: number): string[] {
    return [
      '',
      ...buildTokenActivityChartLines({ buckets: this.buckets, width, today: this.today }),
    ];
  }
}
