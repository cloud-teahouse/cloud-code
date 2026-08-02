/**
 * Guardian rejection circuit breaker (F3). Ported from codex
 * `codex-rs/core/src/guardian/mod.rs` (`GuardianRejectionCircuitBreaker`):
 * per-turn consecutive and sliding-window denial counts that trip after too
 * many reviewer denials, so an adversarial or drifting reviewer cannot
 * deadlock the turn. Review *failures* (timeout/parse/session) never count —
 * a flaky model service must not trip the breaker (codex review.rs:403-405
 * vs 514-522).
 *
 * Cloud Code adaptation: tripping does not abort the turn; the policy falls
 * back to a human (interactive) or denies (headless) for the rest of the
 * turn. See `guardian-review.ts`.
 */

export const GUARDIAN_MAX_CONSECUTIVE_DENIALS = 3;
export const GUARDIAN_MAX_WINDOW_DENIALS = 10;
export const GUARDIAN_DENIAL_WINDOW_SIZE = 50;

export interface GuardianCircuitBreakerLimits {
  readonly maxConsecutiveDenials: number;
  readonly maxWindowDenials: number;
  readonly windowSize: number;
}

export interface GuardianCircuitBreakerTrip {
  /** True only on the denial that tripped the breaker (codex's InterruptTurn transition). */
  readonly tripped: boolean;
  readonly consecutiveDenials: number;
  readonly windowDenials: number;
}

interface GuardianCircuitBreakerTurn {
  consecutiveDenials: number;
  recentDenials: boolean[];
  tripped: boolean;
}

export class GuardianCircuitBreaker {
  private readonly turns = new Map<string, GuardianCircuitBreakerTurn>();

  constructor(private readonly limits: GuardianCircuitBreakerLimits) {}

  tripped(turnId: string): boolean {
    return this.turns.get(turnId)?.tripped === true;
  }

  recordDenial(turnId: string): GuardianCircuitBreakerTrip {
    const turn = this.turn(turnId);
    turn.consecutiveDenials += 1;
    this.recordRecent(turn, true);
    const windowDenials = turn.recentDenials.filter(Boolean).length;
    let justTripped = false;
    if (
      !turn.tripped &&
      (turn.consecutiveDenials >= this.limits.maxConsecutiveDenials ||
        windowDenials >= this.limits.maxWindowDenials)
    ) {
      turn.tripped = true;
      justTripped = true;
    }
    return {
      tripped: justTripped,
      consecutiveDenials: turn.consecutiveDenials,
      windowDenials,
    };
  }

  recordNonDenial(turnId: string): void {
    const turn = this.turn(turnId);
    turn.consecutiveDenials = 0;
    this.recordRecent(turn, false);
  }

  clearTurn(turnId: string): void {
    this.turns.delete(turnId);
  }

  /** Drop state for every turn except `keepTurnId` (turn-lifecycle bound). */
  pruneExcept(keepTurnId: string): void {
    for (const turnId of this.turns.keys()) {
      if (turnId !== keepTurnId) this.turns.delete(turnId);
    }
  }

  private turn(turnId: string): GuardianCircuitBreakerTurn {
    let turn = this.turns.get(turnId);
    if (turn === undefined) {
      turn = { consecutiveDenials: 0, recentDenials: [], tripped: false };
      this.turns.set(turnId, turn);
    }
    return turn;
  }

  private recordRecent(turn: GuardianCircuitBreakerTurn, denied: boolean): void {
    turn.recentDenials.push(denied);
    if (turn.recentDenials.length > this.limits.windowSize) {
      turn.recentDenials.shift();
    }
  }
}
