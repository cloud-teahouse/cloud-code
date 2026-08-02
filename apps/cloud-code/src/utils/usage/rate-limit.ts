/**
 * Codex-style rate-limit display helpers for the `/usage` panel.
 *
 * Pure + ANSI-free so they're trivial to unit-test; colouring and i18n stay
 * with the panel. The mapping/formatting contract mirrors codex's TUI
 * (`codex-rs/tui/src/status/rate_limits.rs`, `chatwidget/rate_limits.rs`,
 * `status/helpers.rs`): window labels keyed off the window length, reset
 * timestamps shown as `HH:MM` same-day and `HH:MM on D Mon` otherwise, and a
 * 15-minute staleness threshold for captured snapshots.
 */

import { renderProgressBar } from './usage-format';

/** codex `RATE_LIMIT_STALE_THRESHOLD_MINUTES`. */
export const RATE_LIMIT_STALE_THRESHOLD_MS = 15 * 60 * 1000;

export type RateLimitWindowKind = '5h' | 'daily' | 'weekly' | 'monthly' | 'annual' | 'other';

const MINUTES_PER_HOUR = 60;
const WINDOW_MINUTES: ReadonlyArray<readonly [kind: RateLimitWindowKind, minutes: number]> = [
  ['5h', 5 * MINUTES_PER_HOUR],
  ['daily', 24 * MINUTES_PER_HOUR],
  ['weekly', 7 * 24 * MINUTES_PER_HOUR],
  ['monthly', 30 * 24 * MINUTES_PER_HOUR],
  ['annual', 365 * 24 * MINUTES_PER_HOUR],
];

/** codex `is_approximate_window`: ±5% tolerance around the canonical length. */
function isApproximateWindow(minutes: number, expectedMinutes: number): boolean {
  return minutes >= expectedMinutes * 0.95 && minutes <= expectedMinutes * 1.05;
}

/** Map a window length in minutes to a canonical label kind (codex `get_limits_duration`). */
export function rateLimitWindowKind(windowMinutes: number | null | undefined): RateLimitWindowKind {
  if (windowMinutes === null || windowMinutes === undefined || !Number.isFinite(windowMinutes)) {
    return 'other';
  }
  const minutes = Math.max(0, windowMinutes);
  for (const [kind, expected] of WINDOW_MINUTES) {
    if (isApproximateWindow(minutes, expected)) return kind;
  }
  return 'other';
}

/** Remaining percent (0-100, integer) from a used percent, clamped. */
export function rateLimitPercentLeft(usedPercent: number): number {
  if (!Number.isFinite(usedPercent)) return 0;
  const used = Math.max(0, Math.min(usedPercent, 100));
  return Math.round(100 - used);
}

/**
 * 20-cell `█/░` bar filled by the REMAINING share of the window (codex
 * `render_status_limit_progress_bar`): a fuller bar means more quota left.
 */
export function renderRateLimitBar(usedPercent: number): string {
  return renderProgressBar(rateLimitPercentLeft(usedPercent) / 100, 20);
}

/** True when the snapshot is older than codex's 15-minute staleness threshold. */
export function isRateLimitStale(capturedAtMs: number, nowMs: number): boolean {
  return nowMs - capturedAtMs > RATE_LIMIT_STALE_THRESHOLD_MS;
}

/** Whole minutes since capture, clamped at 0 (clock-skew safe). */
export function rateLimitCapturedMinutes(capturedAtMs: number, nowMs: number): number {
  return Math.max(0, Math.round((nowMs - capturedAtMs) / 60_000));
}

/**
 * Normalize a raw credits balance for display (codex `format_credit_balance`):
 * positive numbers render as rounded integers; empty or non-numeric input
 * yields null so the caller can fall back to a generic "Available" label.
 */
export function formatCreditBalance(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value <= 0) return null;
  return String(Math.round(value));
}

const MONTH_SHORT_NAMES = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

export interface ResetTimestampParts {
  /** `HH:MM` local time. */
  readonly time: string;
  /** True when the reset falls on the same local day as `nowMs`. */
  readonly sameDay: boolean;
  readonly day: number;
  /** 1-based month number. */
  readonly month: number;
  /** English short month name (e.g. `Aug`); zh-CN formats use `month`. */
  readonly monthName: string;
}

/**
 * Split a unix-seconds reset timestamp into display parts (codex
 * `format_reset_timestamp`): same-day resets show bare `HH:MM`, later ones
 * add the calendar day.
 */
export function resetTimestampParts(resetsAtSec: number, nowMs: number): ResetTimestampParts {
  const date = new Date(resetsAtSec * 1000);
  const now = new Date(nowMs);
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  const month = date.getMonth() + 1;
  return {
    time: `${hh}:${mm}`,
    sameDay,
    day: date.getDate(),
    month,
    monthName: MONTH_SHORT_NAMES[date.getMonth()] ?? '',
  };
}
