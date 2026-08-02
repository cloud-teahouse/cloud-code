/**
 * Loop-local error helpers.
 */

import { APIProviderRateLimitError } from '@cloud-code/kosong';

import { ErrorCodes, CloudCodeError, isCloudCodeError } from '#/errors';

export function createMaxStepsExceededError(maxSteps: number, message?: string): CloudCodeError {
  return new CloudCodeError(
    ErrorCodes.LOOP_MAX_STEPS_EXCEEDED,
    message ??
      `Turn exceeded maxSteps=${maxSteps}. If max_steps_per_turn is too small, raise it in config.toml (loop_control.max_steps_per_turn), or run "/update-config" to update it, then "/reload".`,
    {
      details: { maxSteps },
    },
  );
}

export function isMaxStepsExceededError(error: unknown): boolean {
  return isCloudCodeError(error) && error.code === ErrorCodes.LOOP_MAX_STEPS_EXCEEDED;
}

/**
 * Foreground retry split (C1 P2): thrown by `chatWithRetry` when a rate-limit
 * wait breaches the foreground budget (single-delay or cumulative gate) while
 * auto-resume is on. The turn layer catches it and ends the turn as a
 * rate-limit PAUSE — `turn.ended` failed with a `provider.rate_limit` payload
 * — then parks a session-level timer to retry the turn after `resumeAfterMs`
 * instead of sleeping inside the loop.
 *
 * Extends the 429 status error so the existing rate-limit handling keeps
 * working unchanged: `isProviderRateLimitError` stays true and
 * `toCloudCodeErrorPayload` maps it to `provider.rate_limit` (serialize also
 * forwards `resumeAfterMs`/`autoResume` into the payload details).
 */
export class RateLimitPauseError extends APIProviderRateLimitError {
  /** Wait the loop refused to sleep in-loop, in ms; the pause resumes after it. */
  readonly resumeAfterMs: number;
  /** Failed attempt (1-based) after which the gate tripped. */
  readonly attempts: number;
  /** Would-be total backoff for this step including the refused wait, in ms. */
  readonly totalWaitMs: number;
  /** Always true: the pause is only thrown when auto-resume is enabled. */
  readonly autoResume = true;

  constructor(input: {
    readonly resumeAfterMs: number;
    readonly attempts: number;
    readonly totalWaitMs: number;
    readonly requestId?: string | null;
    readonly traceId?: string | null;
  }) {
    super(
      `Rate limit wait of ${String(input.resumeAfterMs)}ms exceeds the foreground retry budget; ` +
        `pausing the turn to resume in ${String(input.resumeAfterMs)}ms ` +
        `(attempt ${String(input.attempts)}, total wait ${String(input.totalWaitMs)}ms).`,
      input.requestId,
      input.resumeAfterMs,
      input.traceId,
    );
    this.name = 'RateLimitPauseError';
    this.resumeAfterMs = input.resumeAfterMs;
    this.attempts = input.attempts;
    this.totalWaitMs = input.totalWaitMs;
  }
}

export function isRateLimitPauseError(error: unknown): error is RateLimitPauseError {
  return error instanceof RateLimitPauseError;
}

export function isAbortError(err: unknown): boolean {
  if (err instanceof Error) {
    return err.name === 'AbortError';
  }
  return false;
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
