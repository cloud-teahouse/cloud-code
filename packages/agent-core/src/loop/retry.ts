import { sleep } from '@antfu/utils';

import { APIStatusError } from '@cloud-code/kosong';
import type { Logger } from '#/logging/types';

import { abortable } from '../utils/abort';
import type { LoopEventDispatcher } from './events';
import { isAbortError, RateLimitPauseError } from './errors';
import type { LLM, LLMChatParams, LLMChatResponse } from './llm';

// Default retry budget per step: 10 attempts (9 retries). With the
// exponential ramp below the backoff climbs 0.5s, 1s, 2s … up to the 32s
// cap, giving roughly 2–3 minutes of total wait — enough to ride out a
// typical provider overload window (sustained 429s) instead of surfacing
// the error after a couple of quick retries.
export const DEFAULT_MAX_RETRY_ATTEMPTS = 10;

const BASE_DELAY_MS = 500;
// Per-attempt backoff cap (32s). The default 10-attempt ramp reaches the
// cap on the 7th retry, so most of the budget is spent at the cap waiting
// out multi-minute provider overload.
const MAX_DELAY_MS = 32_000;
const RETRY_FACTOR = 2;
// Up to 25% jitter on top of the exponential base to avoid herd retries.
const JITTER_FACTOR = 0.25;

/**
 * Foreground wait gates (C1 P2): bounds on how long `chatWithRetry` sleeps
 * inside the turn loop before the wait is moved out of the session — the
 * turn ends as a rate-limit pause and a session-level timer retries it
 * (see RateLimitPauseError). Defaults: a single wait may not exceed 60s
 * (even when the server's `Retry-After` asks for more — such directives are
 * no longer honored in-loop), and the accumulated backoff of one step may
 * not exceed 150s.
 */
export const DEFAULT_FOREGROUND_MAX_DELAY_MS = 60_000;
export const DEFAULT_FOREGROUND_MAX_TOTAL_WAIT_MS = 150_000;

export interface ForegroundRetryGate {
  /** Single-wait cap in ms (default {@link DEFAULT_FOREGROUND_MAX_DELAY_MS}). */
  readonly maxDelayMs?: number;
  /**
   * Cumulative per-step backoff cap in ms (default
   * {@link DEFAULT_FOREGROUND_MAX_TOTAL_WAIT_MS}): the sum of waits already
   * slept for this step plus the upcoming one.
   */
  readonly maxTotalWaitMs?: number;
  /**
   * Default true: a breached gate throws RateLimitPauseError so the turn
   * parks and auto-resumes. When false the gates degrade to the near-current
   * behavior — an over-long server `Retry-After` is clipped to `maxDelayMs`
   * and the loop keeps retrying within the local attempt budget.
   */
  readonly autoResume?: boolean;
}

export interface ChatWithRetryInput {
  readonly llm: LLM;
  readonly params: LLMChatParams;
  readonly dispatchEvent: LoopEventDispatcher;
  readonly turnId: string;
  readonly currentStep: number;
  readonly stepUuid: string;
  readonly maxAttempts?: number;
  /**
   * Foreground wait gates for this step (C1 P2). Only FOREGROUND request
   * sources may call `chatWithRetry` at all (`isForegroundRequestKind`);
   * background sources fail fast instead. Omitting the gate applies the
   * defaults (60s single wait / 150s cumulative / auto-resume on).
   */
  readonly foregroundGate?: ForegroundRetryGate;
  readonly log?: Logger | undefined;
}

export async function chatWithRetry(input: ChatWithRetryInput): Promise<LLMChatResponse> {
  const maxAttempts = input.maxAttempts ?? DEFAULT_MAX_RETRY_ATTEMPTS;

  if (input.llm.isRetryableError === undefined || maxAttempts <= 1) {
    const effectiveMaxAttempts = Math.max(maxAttempts, 1);
    input.params.trace?.reset();
    try {
      const response = await input.llm.chat(paramsForAttempt(input, 1, effectiveMaxAttempts));
      input.params.trace?.capture(response.traceId);
      return response;
    } catch (error) {
      captureAttemptTraceId(input, error);
      captureAttemptRateLimit(input, error);
      logRequestFailure(input, error, 1, effectiveMaxAttempts);
      throw error;
    }
  }

  const delays = retryBackoffDelays(maxAttempts);
  // Backoff actually slept for this step, feeding the cumulative gate.
  let totalWaitMs = 0;

  for (let attempt = 1; ; attempt += 1) {
    input.params.trace?.reset();
    try {
      const response = await input.llm.chat(paramsForAttempt(input, attempt, maxAttempts));
      input.params.trace?.capture(response.traceId);
      return response;
    } catch (error) {
      captureAttemptTraceId(input, error);
      captureAttemptRateLimit(input, error);
      if (attempt >= maxAttempts || !input.llm.isRetryableError(error)) {
        logRequestFailure(input, error, attempt, maxAttempts);
        throw error;
      }

      // A server `Retry-After` (carried on the error) overrides the computed
      // backoff. The foreground gates may then clip that wait (auto-resume
      // off) or refuse it entirely (auto-resume on → RateLimitPauseError);
      // the delay that survives the gates is what gets reported on the
      // `step.retrying` event via `delayMs`.
      const delayMs = readRetryAfterMs(error) ?? delays[attempt - 1] ?? 0;
      input.params.signal.throwIfAborted();
      const delayAfterGates = applyForegroundGates(input, error, delayMs, attempt, totalWaitMs);
      input.dispatchEvent({
        type: 'step.retrying',
        turnId: input.turnId,
        step: input.currentStep,
        stepUuid: input.stepUuid,
        failedAttempt: attempt,
        nextAttempt: attempt + 1,
        maxAttempts,
        delayMs: delayAfterGates,
        ...retryErrorFields(error),
      });
      await sleepForRetry(delayAfterGates, input.params.signal);
      totalWaitMs += delayAfterGates;
    }
  }
}

/**
 * Pass the chosen wait through the two foreground gates (C1 P2): the
 * single-wait cap and the cumulative per-step cap. Auto-resume ON (default):
 * a breach throws RateLimitPauseError so the turn parks and a session-level
 * timer resumes it after the refused wait. Auto-resume OFF: the single gate
 * degrades to clipping an over-long server `Retry-After` to the cap and the
 * loop keeps retrying within the local attempt budget (near-current
 * behavior).
 */
function applyForegroundGates(
  input: ChatWithRetryInput,
  error: unknown,
  delayMs: number,
  attempt: number,
  totalWaitMs: number,
): number {
  const gate = input.foregroundGate;
  const maxDelayMs = gate?.maxDelayMs ?? DEFAULT_FOREGROUND_MAX_DELAY_MS;
  const maxTotalWaitMs = gate?.maxTotalWaitMs ?? DEFAULT_FOREGROUND_MAX_TOTAL_WAIT_MS;
  const autoResume = gate?.autoResume ?? true;

  const singleBreached = delayMs > maxDelayMs;
  const cumulativeBreached = totalWaitMs + delayMs > maxTotalWaitMs;
  if (!singleBreached && !cumulativeBreached) return delayMs;

  if (!autoResume) {
    // Only the single gate survives with auto-resume off: clip the wait
    // (a server directive longer than the cap is no longer honored verbatim)
    // and continue within the local budget.
    return Math.min(delayMs, maxDelayMs);
  }

  const statusError = findAPIStatusError(error);
  input.log?.info('rate limit wait exceeds the foreground budget; pausing for auto-resume', {
    turnStep: `${input.turnId}.${String(input.currentStep)}`,
    attempt: `${String(attempt)}/${String(input.maxAttempts ?? DEFAULT_MAX_RETRY_ATTEMPTS)}`,
    delayMs,
    totalWaitMs: totalWaitMs + delayMs,
    gate: singleBreached ? 'single' : 'cumulative',
  });
  throw new RateLimitPauseError({
    resumeAfterMs: delayMs,
    attempts: attempt,
    totalWaitMs: totalWaitMs + delayMs,
    requestId: statusError?.requestId,
    traceId: statusError?.traceId,
  });
}

function logRequestFailure(
  input: ChatWithRetryInput,
  error: unknown,
  attempt: number,
  maxAttempts: number,
): void {
  if (isAbortError(error) || input.params.signal.aborted) return;
  input.log?.warn('llm request failed', {
    turnStep: `${input.turnId}.${String(input.currentStep)}`,
    attempt: `${String(attempt)}/${String(maxAttempts)}`,
    model: input.llm.modelName,
    ...retryErrorFields(error),
  });
}

/**
 * Surface a failed attempt's trace id through the same early-capture channel
 * as a successful attempt. A status-error response still carried response
 * headers, so its `x-trace-id` is available on the converted error; writing
 * it here (before the failure propagates to the loop's `turn.interrupted`
 * dispatch) lets turn-level diagnostics attribute the turn to the failed
 * request rather than the previous successful one. Mid-stream failures were
 * already captured by the attempt's request trace; failures before any
 * response (network errors, local aborts) keep the attempt-start reset.
 */
function captureAttemptTraceId(input: ChatWithRetryInput, error: unknown): void {
  const statusError = findAPIStatusError(error);
  if (statusError?.traceId !== null && statusError?.traceId !== undefined) {
    input.params.trace?.capture(statusError.traceId);
  }
}

export function findAPIStatusError(error: unknown): APIStatusError | undefined {
  let current = error;
  const visited = new Set<unknown>();
  while (current !== null && typeof current === 'object' && !visited.has(current)) {
    if (current instanceof APIStatusError) return current;
    visited.add(current);
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * Surface a failed attempt's rate-limit snapshot through the same
 * early-capture channel as the trace id. An error response (a 429 above
 * all) from the Codex backend still carries the `x-codex-*` quota headers
 * on the converted status error; forwarding the parsed snapshot per attempt
 * keeps the host's quota view accurate while the retry loop rides out a
 * rate-limit window, instead of going stale until the next successful
 * response. Errors without a snapshot (non-Codex backends, transport
 * failures) fire nothing, leaving the last known snapshot in place.
 */
function captureAttemptRateLimit(input: ChatWithRetryInput, error: unknown): void {
  const rateLimit = findAPIStatusError(error)?.rateLimit;
  if (rateLimit !== null && rateLimit !== undefined) {
    input.params.onRateLimit?.(rateLimit);
  }
}

function paramsForAttempt(
  input: ChatWithRetryInput,
  attempt: number,
  maxAttempts: number,
): LLMChatParams {
  const turnStep = `${input.turnId}.${String(input.currentStep)}`;
  // Preserve caller-set fields (e.g. the strict-resend projection marker);
  // only the per-attempt turnStep/attempt pair is owned here.
  return {
    ...input.params,
    requestLogFields:
      attempt === 1
        ? { ...input.params.requestLogFields, turnStep }
        : {
            ...input.params.requestLogFields,
            turnStep,
            attempt: `${String(attempt)}/${String(maxAttempts)}`,
          },
  };
}

export function retryBackoffDelays(maxAttempts: number): number[] {
  // For attempt (1-based) the base delay is min(500ms * 2^(attempt-1), 32s),
  // plus up to 25% jitter. Index i here is 0-based, so attempt = i + 1.
  const count = Math.max(maxAttempts - 1, 0);
  const delays: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const base = Math.min(BASE_DELAY_MS * Math.pow(RETRY_FACTOR, i), MAX_DELAY_MS);
    delays.push(base + Math.random() * JITTER_FACTOR * base);
  }
  return delays;
}

/**
 * Server-requested backoff carried on a kosong `APIStatusError` (parsed from
 * the `retry-after` response header). When present and positive it overrides
 * the computed backoff — a server `Retry-After` directive takes precedence
 * over the local exponential delay.
 */
function readRetryAfterMs(error: unknown): number | null {
  if (typeof error !== 'object' || error === null) return null;
  const value = (error as { retryAfterMs?: unknown }).retryAfterMs;
  return typeof value === 'number' && value > 0 ? value : null;
}

export async function sleepForRetry(delayMs: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await abortable(sleep(delayMs), signal);
}

interface RetryErrorFields {
  readonly errorName: string;
  readonly errorMessage: string;
  readonly statusCode?: number;
}

function retryErrorFields(error: unknown): RetryErrorFields {
  return {
    errorName: error instanceof Error ? error.name : typeof error,
    errorMessage: error instanceof Error ? error.message : String(error),
    statusCode: maybeStatusCode(error),
  };
}

function maybeStatusCode(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const statusCode = (error as { statusCode?: unknown }).statusCode;
  return typeof statusCode === 'number' ? statusCode : undefined;
}
