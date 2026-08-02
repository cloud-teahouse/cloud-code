import { describe, expect, it } from 'vitest';

import {
  formatCreditBalance,
  isRateLimitStale,
  RATE_LIMIT_STALE_THRESHOLD_MS,
  rateLimitCapturedMinutes,
  rateLimitPercentLeft,
  rateLimitWindowKind,
  renderRateLimitBar,
  resetTimestampParts,
} from '#/utils/usage/rate-limit';

describe('renderRateLimitBar', () => {
  it('fills by remaining percent (codex semantics)', () => {
    // 74% used → 26% left → 5 of 20 cells filled.
    expect(renderRateLimitBar(74)).toBe('█████' + '░'.repeat(15));
    // 26% used → 74% left → 15 of 20 cells filled.
    expect(renderRateLimitBar(26)).toBe('█'.repeat(15) + '░'.repeat(5));
  });

  it('renders empty and full bars at the extremes', () => {
    expect(renderRateLimitBar(100)).toBe('░'.repeat(20));
    expect(renderRateLimitBar(0)).toBe('█'.repeat(20));
  });

  it('clamps out-of-range input', () => {
    expect(renderRateLimitBar(150)).toBe('░'.repeat(20));
    expect(renderRateLimitBar(-10)).toBe('█'.repeat(20));
    expect(renderRateLimitBar(Number.NaN)).toBe('░'.repeat(20));
  });
});

describe('rateLimitWindowKind', () => {
  it('maps canonical window lengths to label kinds', () => {
    expect(rateLimitWindowKind(300)).toBe('5h');
    expect(rateLimitWindowKind(1440)).toBe('daily');
    expect(rateLimitWindowKind(10080)).toBe('weekly');
    expect(rateLimitWindowKind(43200)).toBe('monthly');
    expect(rateLimitWindowKind(525600)).toBe('annual');
  });

  it('accepts windows within ±5% of canonical lengths', () => {
    expect(rateLimitWindowKind(290)).toBe('5h');
    expect(rateLimitWindowKind(10100)).toBe('weekly');
  });

  it('falls back to other for unknown or missing lengths', () => {
    expect(rateLimitWindowKind(999)).toBe('other');
    expect(rateLimitWindowKind(0)).toBe('other');
    expect(rateLimitWindowKind(null)).toBe('other');
    expect(rateLimitWindowKind(undefined)).toBe('other');
    expect(rateLimitWindowKind(Number.NaN)).toBe('other');
  });
});

describe('rateLimitPercentLeft', () => {
  it('converts used to remaining and clamps to 0..100', () => {
    expect(rateLimitPercentLeft(26)).toBe(74);
    expect(rateLimitPercentLeft(74)).toBe(26);
    expect(rateLimitPercentLeft(0)).toBe(100);
    expect(rateLimitPercentLeft(100)).toBe(0);
    expect(rateLimitPercentLeft(-5)).toBe(100);
    expect(rateLimitPercentLeft(120)).toBe(0);
  });
});

describe('isRateLimitStale / rateLimitCapturedMinutes', () => {
  const now = 1_900_000_000_000;

  it('marks snapshots older than 15 minutes as stale', () => {
    expect(isRateLimitStale(now - 14 * 60_000, now)).toBe(false);
    expect(isRateLimitStale(now - RATE_LIMIT_STALE_THRESHOLD_MS, now)).toBe(false);
    expect(isRateLimitStale(now - 16 * 60_000, now)).toBe(true);
  });

  it('computes whole minutes since capture, clamped at zero', () => {
    expect(rateLimitCapturedMinutes(now - 3 * 60_000, now)).toBe(3);
    expect(rateLimitCapturedMinutes(now - 20_000, now)).toBe(0);
    expect(rateLimitCapturedMinutes(now + 60_000, now)).toBe(0);
  });
});

describe('resetTimestampParts', () => {
  // Local-time fixtures: 24 Jul 2026 10:00 local.
  const now = new Date(2026, 6, 24, 10, 0, 0).getTime();

  it('flags same-day resets with bare HH:MM', () => {
    const parts = resetTimestampParts(new Date(2026, 6, 24, 15, 25, 0).getTime() / 1000, now);
    expect(parts.sameDay).toBe(true);
    expect(parts.time).toBe('15:25');
  });

  it('flags cross-day resets with day and short month', () => {
    const parts = resetTimestampParts(new Date(2026, 7, 3, 9, 55, 0).getTime() / 1000, now);
    expect(parts.sameDay).toBe(false);
    expect(parts.time).toBe('09:55');
    expect(parts.day).toBe(3);
    expect(parts.month).toBe(8);
    expect(parts.monthName).toBe('Aug');
  });

  it('zero-pads hours and minutes', () => {
    const parts = resetTimestampParts(new Date(2026, 6, 24, 8, 5, 0).getTime() / 1000, now);
    expect(parts.time).toBe('08:05');
  });
});

describe('formatCreditBalance', () => {
  it('renders positive balances as rounded integers', () => {
    expect(formatCreditBalance('25')).toBe('25');
    expect(formatCreditBalance('25.6')).toBe('26');
    expect(formatCreditBalance('  7  ')).toBe('7');
  });

  it('returns null for empty, non-numeric, or non-positive input', () => {
    expect(formatCreditBalance('')).toBeNull();
    expect(formatCreditBalance('   ')).toBeNull();
    expect(formatCreditBalance('abc')).toBeNull();
    expect(formatCreditBalance('-3')).toBeNull();
    expect(formatCreditBalance('0')).toBeNull();
    expect(formatCreditBalance(null)).toBeNull();
    expect(formatCreditBalance(undefined)).toBeNull();
  });
});
