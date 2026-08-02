import { describe, expect, it } from 'vitest';

import { setLocalePreference, t } from '#/tui/i18n';
import {
  formatTurnCompletionLine,
  formatTurnDuration,
  pickTurnCompletionSymbol,
  pickTurnCompletionVerb,
  TURN_COMPLETION_SYMBOLS,
} from '#/tui/utils/turn-completion';

/** Deterministic PRNG (Park–Miller LCG) for distribution checks. */
function seededRandom(seed: number): () => number {
  let state = seed % 2147483647;
  if (state <= 0) state += 2147483646;
  return () => {
    state = (state * 16807) % 2147483647;
    return (state - 1) / 2147483646;
  };
}

function localeVerbPool(): string[] {
  return t('session.turn.completionVerbs')
    .split(',')
    .map((verb) => verb.trim())
    .filter((verb) => verb.length > 0);
}

describe('pickTurnCompletionVerb', () => {
  it('picks from the locale verb set', () => {
    // Default test locale is English.
    expect(pickTurnCompletionVerb(() => 0)).toBe('Worked');
    expect(pickTurnCompletionVerb(() => 0.999)).toBe('Whittled');
  });

  it('picks from the zh-CN verb set when that locale is active', () => {
    setLocalePreference('zh-CN');
    expect(pickTurnCompletionVerb(() => 0)).toBe('忙活了');
    expect(pickTurnCompletionVerb(() => 0.999)).toBe('发酵了');
    setLocalePreference('en');
  });

  it('never returns an empty verb', () => {
    for (const r of [0, 0.1, 0.5, 0.9, 0.999]) {
      expect(pickTurnCompletionVerb(() => r).length).toBeGreaterThan(0);
    }
  });

  it('stays inside the locale pool across a seeded distribution', () => {
    const random = seededRandom(42);
    const pool = localeVerbPool();
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const verb = pickTurnCompletionVerb(random);
      expect(pool).toContain(verb);
      seen.add(verb);
    }
    // 500 draws over a 20-verb pool must surface more than one distinct verb.
    expect(seen.size).toBeGreaterThan(1);
  });
});

describe('pickTurnCompletionSymbol', () => {
  it('picks from the fixed glyph set', () => {
    expect(pickTurnCompletionSymbol(() => 0)).toBe('✢');
    expect(pickTurnCompletionSymbol(() => 0.999)).toBe('✦');
  });

  it('stays inside the glyph set across a seeded distribution', () => {
    const random = seededRandom(7);
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const symbol = pickTurnCompletionSymbol(random);
      expect(TURN_COMPLETION_SYMBOLS).toContain(symbol);
      seen.add(symbol);
    }
    expect(seen.size).toBeGreaterThan(1);
  });
});

describe('formatTurnDuration', () => {
  it('formats sub-minute durations as seconds', () => {
    expect(formatTurnDuration(0)).toBe('0s');
    expect(formatTurnDuration(12_300)).toBe('12s');
    expect(formatTurnDuration(59_400)).toBe('59s');
    // 59.5s rounds up to a full minute.
    expect(formatTurnDuration(59_500)).toBe('1m 0s');
  });

  it('formats longer durations as minutes and seconds', () => {
    expect(formatTurnDuration(65_000)).toBe('1m 5s');
    expect(formatTurnDuration(3_725_000)).toBe('62m 5s');
  });
});

describe('formatTurnCompletionLine', () => {
  it('formats "<symbol> <verb> for <duration>" with a seeded picker', () => {
    expect(formatTurnCompletionLine(10_000, () => 0)).toBe('✢ Worked for 10s');
    expect(formatTurnCompletionLine(65_000, () => 0)).toBe('✢ Worked for 1m 5s');
  });

  it('matches the expected shape for any pick', () => {
    const random = seededRandom(123);
    for (let i = 0; i < 100; i++) {
      expect(formatTurnCompletionLine(9_000, random)).toMatch(
        /^[✢✳✶✻✽✦] \S+ for \d+s$/,
      );
    }
  });

  it('renders the same structure in zh-CN', () => {
    setLocalePreference('zh-CN');
    expect(formatTurnCompletionLine(10_000, () => 0)).toBe('✢ 忙活了 10 秒');
    const random = seededRandom(123);
    for (let i = 0; i < 100; i++) {
      expect(formatTurnCompletionLine(9_000, random)).toMatch(/^[✢✳✶✻✽✦] \S+ \d+ 秒$/);
    }
    setLocalePreference('en');
  });
});
