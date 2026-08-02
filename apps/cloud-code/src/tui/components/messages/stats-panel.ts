/**
 * Stats tab line builder for the `/status` dialog.
 *
 * Claude Code /stats-style aggregate facts (favorite model, total tokens,
 * sessions, longest session, active days, most active day) over a
 * codex-style switchable activity chart (daily / weekly / cumulative). All facts
 * are computed from the local wire-log walk in
 * `#/tui/services/token-activity`; facts that cannot be derived render an
 * explicit `—` instead of a fabricated value.
 */

import { visibleWidth } from '@cloud-code/pi-tui';

import type { TokenActivityStats } from '#/tui/services/token-activity';
import { columnWidth, renderRow } from '#/tui/components/primitives';
import { getActiveLocale, t } from '#/tui/i18n';
import { currentTheme } from '#/tui/theme';
import { highlightBgIf } from '#/tui/utils/mouse-hover';

import {
  buildTokenActivityChartLines,
  formatTokensCompact,
  tokenActivityMonthLabel,
  type TokenActivityBucket,
  type TokenActivityView,
} from './token-activity-chart';

export interface StatsTabOptions {
  /** Daily buckets feeding the chart (same source as the /usage heatmap);
   * undefined while the wire-log walk is still running. */
  readonly buckets?: readonly TokenActivityBucket[] | undefined;
  /** All-time aggregates from `loadTokenActivityStats`; undefined while loading. */
  readonly stats?: TokenActivityStats | undefined;
  /** Active chart range (keyboard-switched in the dialog). */
  readonly view: TokenActivityView;
  /** Content width available to the chart. */
  readonly width: number;
  /** Hovered range-selector word (mouse motion); null → no hover affordance. */
  readonly hoverRangeIndex?: number | null | undefined;
  /** "Today" for chart windowing; injectable for tests. */
  readonly today?: Date | undefined;
}

const RANGE_ORDER: readonly TokenActivityView[] = ['daily', 'weekly', 'cumulative'];

const RANGE_LABEL_KEYS = {
  daily: 'token-activity.range.daily',
  weekly: 'token-activity.range.weekly',
  cumulative: 'token-activity.range.cumulative',
} as const;

/** Leading spaces before the first range label (see buildRangeSelectorLine). */
const RANGE_SELECTOR_INDENT = 3;
/** Separator between range labels; hit-test math must match the renderer. */
const RANGE_SELECTOR_SEPARATOR = ' · ';

/** codex `view_footer`: all ranges listed, the active one highlighted. */
function buildRangeSelectorLine(active: TokenActivityView, hoverIndex: number | null): string {
  const dim = (text: string) => currentTheme.fg('textDim', text);
  const segments = RANGE_ORDER.map((view, index) => {
    const label = t(RANGE_LABEL_KEYS[view]);
    const styled = view === active ? currentTheme.boldFg('primary', label) : dim(label);
    return highlightBgIf(styled, index === hoverIndex);
  });
  return `${' '.repeat(RANGE_SELECTOR_INDENT)}${segments.join(dim(RANGE_SELECTOR_SEPARATOR))}`;
}

/**
 * The on-screen layout of the range-selector words: 1-based start column and
 * visible width of each word, in RANGE_ORDER, using the same layout math as
 * {@link buildRangeSelectorLine}. The dialog declares one hit zone per word
 * from these spans, so click/hover hit-testing can never drift from the
 * renderer. The indent and the separators are chrome and get no span.
 */
export function statsRangeWordSpans(): readonly { col: number; width: number }[] {
  const spans: { col: number; width: number }[] = [];
  let next = RANGE_SELECTOR_INDENT + 1; // 1-based column of the current word
  for (const view of RANGE_ORDER) {
    const width = visibleWidth(t(RANGE_LABEL_KEYS[view]));
    spans.push({ col: next, width });
    next += width + visibleWidth(RANGE_SELECTOR_SEPARATOR);
  }
  return spans;
}

/** Session span like `2h 5m` / `5m 30s` / `45s` (reuses the goal duration formats). */
function formatSessionDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return t('panels.goal.duration.hours', { hours, minutes });
  if (minutes > 0) return t('panels.goal.duration.minutes', { minutes, seconds });
  return t('panels.goal.duration.seconds', { seconds });
}

/** `Mar 5` (en) / `3月5日` (zh-CN) from a local `YYYY-MM-DD` bucket key. */
function formatActivityDay(date: string): string {
  const parts = date.split('-').map(Number);
  const month = parts[1] ?? 1;
  const day = parts[2] ?? 1;
  return getActiveLocale() === 'zh-CN'
    ? `${month}月${day}日`
    : `${tokenActivityMonthLabel(month)} ${day}`;
}

export function buildStatsTabLines(options: StatsTabOptions): string[] {
  const muted = (text: string) => currentTheme.fg('textDim', text);

  // Nothing resolved yet: a single placeholder instead of a hollow shell.
  if (options.stats === undefined && options.buckets === undefined) {
    return [muted(`   ${t('common.loading')}`)];
  }
  // A resolved stats load is authoritative: zero active days means no
  // activity, even if the chart's buckets are still in flight.
  if (options.stats !== undefined && options.stats.activeDays === 0) {
    return [muted(`   ${t('panels.stats.empty')}`)];
  }

  const lines: string[] = [
    buildRangeSelectorLine(options.view, options.hoverRangeIndex ?? null),
    '',
    ...(options.buckets === undefined
      ? [muted(`   ${t('common.loading')}`)]
      : buildTokenActivityChartLines({
          buckets: options.buckets,
          width: options.width,
          today: options.today,
          view: options.view,
        })),
  ];
  if (options.stats === undefined) {
    lines.push('', muted(`   ${t('common.loading')}`));
    return lines;
  }

  const unavailable = t('panels.stats.unavailable');
  const { stats } = options;
  const rows: Array<{ label: string; text: string }> = [
    {
      label: t('panels.stats.favoriteModel'),
      text: stats.favoriteModel?.model ?? unavailable,
    },
    {
      label: t('panels.stats.totalTokens'),
      text: formatTokensCompact(stats.totalTokens),
    },
    { label: t('panels.stats.sessions'), text: String(stats.sessionCount) },
    {
      label: t('panels.stats.longestSession'),
      text:
        stats.longestSessionMs === undefined
          ? unavailable
          : formatSessionDuration(stats.longestSessionMs),
    },
    { label: t('panels.stats.activeDays'), text: String(stats.activeDays) },
    {
      label: t('panels.stats.mostActiveDay'),
      text:
        stats.mostActiveDay === undefined ? unavailable : formatActivityDay(stats.mostActiveDay.date),
    },
  ];

  const labelWidth = columnWidth(
    rows.map((row) => row.label),
    10,
  );
  lines.push(
    '',
    ...rows.map((row) =>
      renderRow(
        [
          { text: row.label, token: 'textDim', width: labelWidth },
          { text: row.text, token: 'text' },
        ],
        { margin: 2 },
      ),
    ),
  );
  return lines;
}
