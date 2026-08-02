/** See common.ts for contribution rules. */

export const tokenActivity = {
  // ── /status Stats tab activity chart (codex 52-week style, local data) ──
  'token-activity.summary': 'Lifetime {total} · Peak {peak} · Streak {streak}d',
  'token-activity.widen': 'Widen terminal to show activity graph',
  'token-activity.empty': 'No token activity in the last 12 months',
  'token-activity.less': 'Less',
  'token-activity.more': 'More',

  // Range views (/status Stats tab; codex view_footer + bar captions).
  'token-activity.range.daily': 'daily',
  'token-activity.range.weekly': 'weekly',
  'token-activity.range.cumulative': 'cumulative',
  'token-activity.weeklyCaption': 'Each column = 1 week · tallest {peak}',
  'token-activity.cumulativeCaption': 'Running total · top {total}',

  // Month abbreviations for the chart's label row.
  'token-activity.month.1': 'Jan',
  'token-activity.month.2': 'Feb',
  'token-activity.month.3': 'Mar',
  'token-activity.month.4': 'Apr',
  'token-activity.month.5': 'May',
  'token-activity.month.6': 'Jun',
  'token-activity.month.7': 'Jul',
  'token-activity.month.8': 'Aug',
  'token-activity.month.9': 'Sep',
  'token-activity.month.10': 'Oct',
  'token-activity.month.11': 'Nov',
  'token-activity.month.12': 'Dec',
} as const;
