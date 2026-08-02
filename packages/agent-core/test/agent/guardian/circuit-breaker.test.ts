import { describe, expect, it } from 'vitest';

import { GuardianCircuitBreaker } from '../../../src/agent/guardian/circuit-breaker';

const LIMITS = { maxConsecutiveDenials: 3, maxWindowDenials: 10, windowSize: 50 };

function breaker(limits = LIMITS) {
  return new GuardianCircuitBreaker(limits);
}

describe('GuardianCircuitBreaker', () => {
  it('trips on the third consecutive denial and reports counts', () => {
    const b = breaker();
    expect(b.recordDenial('t1').tripped).toBe(false);
    expect(b.recordDenial('t1').tripped).toBe(false);
    const third = b.recordDenial('t1');
    expect(third).toEqual({ tripped: true, consecutiveDenials: 3, windowDenials: 3 });
    expect(b.tripped('t1')).toBe(true);
  });

  it('does not re-report the trip on later denials', () => {
    const b = breaker();
    b.recordDenial('t1');
    b.recordDenial('t1');
    b.recordDenial('t1');
    expect(b.recordDenial('t1').tripped).toBe(false);
    expect(b.tripped('t1')).toBe(true);
  });

  it('trips on ten window denials even when not consecutive', () => {
    const b = breaker();
    let tripped = false;
    for (let i = 0; i < 10; i++) {
      tripped = b.recordDenial('t1').tripped;
      b.recordNonDenial('t1');
    }
    expect(tripped).toBe(true);
    expect(b.tripped('t1')).toBe(true);
  });

  it('resets the consecutive count on a non-denial but keeps the window count', () => {
    const b = breaker();
    b.recordDenial('t1');
    b.recordDenial('t1');
    b.recordNonDenial('t1');
    const next = b.recordDenial('t1');
    expect(next.consecutiveDenials).toBe(1);
    expect(next.windowDenials).toBe(3);
    expect(next.tripped).toBe(false);
  });

  it('never trips on non-denials alone (review failures record non-denials)', () => {
    const b = breaker();
    for (let i = 0; i < 60; i++) {
      b.recordNonDenial('t1');
    }
    expect(b.tripped('t1')).toBe(false);
  });

  it('slides the window so old denials stop counting', () => {
    const b = breaker({ maxConsecutiveDenials: 100, maxWindowDenials: 3, windowSize: 5 });
    // Two denials, then enough non-denials to push them out of the window,
    // repeated — the window never holds three denials at once.
    for (let round = 0; round < 5; round++) {
      expect(b.recordDenial('t1').tripped).toBe(false);
      expect(b.recordDenial('t1').tripped).toBe(false);
      for (let i = 0; i < 5; i++) b.recordNonDenial('t1');
    }
    expect(b.tripped('t1')).toBe(false);
  });

  it('tracks turns independently and prunes old turns', () => {
    const b = breaker();
    b.recordDenial('t1');
    b.recordDenial('t1');
    b.recordDenial('t1');
    expect(b.tripped('t1')).toBe(true);
    expect(b.tripped('t2')).toBe(false);

    b.pruneExcept('t2');
    expect(b.tripped('t1')).toBe(false);

    b.recordDenial('t2');
    b.clearTurn('t2');
    expect(b.tripped('t2')).toBe(false);
  });

  it('honours configured limit overrides', () => {
    const b = breaker({ maxConsecutiveDenials: 1, maxWindowDenials: 100, windowSize: 50 });
    expect(b.recordDenial('t1').tripped).toBe(true);
  });
});
