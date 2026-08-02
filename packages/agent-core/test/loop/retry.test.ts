import {
  APIConnectionError,
  APIProviderQuotaExhaustedError,
  APIProviderRateLimitError,
  APIQuotaExceededError,
  emptyUsage,
  isRetryableGenerateError,
} from '@cloud-code/kosong';
import { describe, expect, it, vi } from 'vitest';

import type { CloudCodeConfig } from '#/config';
import { ErrorCodes, CloudCodeError } from '#/errors';
import { RateLimitPauseError } from '#/loop/errors';
import { isForegroundRequestKind, type LLM, type LLMChatParams, type LLMChatResponse } from '#/loop/llm';
import { chatWithRetry, DEFAULT_MAX_RETRY_ATTEMPTS, retryBackoffDelays } from '#/loop/retry';
import { ProviderManager } from '#/session/provider-manager';

function okResponse(): LLMChatResponse {
  return { toolCalls: [], usage: emptyUsage() };
}

function makeInput(
  llm: LLM,
  signal: AbortSignal,
): Parameters<typeof chatWithRetry>[0] {
  return {
    llm,
    params: { messages: [], tools: [], signal },
    dispatchEvent: async () => {},
    turnId: 't',
    currentStep: 1,
    stepUuid: 'u',
  };
}

describe('isForegroundRequestKind: source classification contract (C1 P2)', () => {
  it('classifies loop/compaction (and an absent kind) as foreground, everything else as background', () => {
    // Foreground sources ride chatWithRetry with the wait gates; background
    // sources (guardian/title, and any kind added later) must fail fast.
    expect(isForegroundRequestKind('loop')).toBe(true);
    expect(isForegroundRequestKind('compaction')).toBe(true);
    // An absent kind is a regular loop step — foreground.
    expect(isForegroundRequestKind(undefined)).toBe(true);
    expect(isForegroundRequestKind('guardian')).toBe(false);
    expect(isForegroundRequestKind('title')).toBe(false);
  });
});

describe('chatWithRetry: foreground wait gates (C1 P2)', () => {
  function rateLimitedLLM(retryAfterMs: number, succeedAfter = Number.POSITIVE_INFINITY): {
    llm: LLM;
    calls: () => number;
  } {
    let calls = 0;
    return {
      calls: () => calls,
      llm: {
        systemPrompt: '',
        modelName: 'mock',
        isRetryableError: (e) => isRetryableGenerateError(e),
        async chat(): Promise<LLMChatResponse> {
          calls += 1;
          if (calls >= succeedAfter) return okResponse();
          throw new APIProviderRateLimitError('rate limited', 'req-rl', retryAfterMs);
        },
      },
    };
  }

  it('throws RateLimitPauseError when a server Retry-After breaches the single-wait gate', async () => {
    const { llm, calls } = rateLimitedLLM(120_000);
    const captured: Array<{ type: string }> = [];
    const input = makeInput(llm, new AbortController().signal);

    const error = await chatWithRetry({
      ...input,
      dispatchEvent: async (event) => {
        captured.push(event as { type: string });
      },
    }).then(
      () => {
        throw new Error('expected chatWithRetry to reject');
      },
      (error: unknown) => error,
    );

    // The pause stays rate-limit-shaped: existing 429 handling
    // (isProviderRateLimitError, provider.rate_limit payload) keeps working.
    expect(error).toBeInstanceOf(RateLimitPauseError);
    expect(error).toBeInstanceOf(APIProviderRateLimitError);
    const pause = error as RateLimitPauseError;
    expect(pause.resumeAfterMs).toBe(120_000);
    expect(pause.attempts).toBe(1);
    expect(pause.totalWaitMs).toBe(120_000);
    expect(pause.autoResume).toBe(true);
    expect(pause.requestId).toBe('req-rl');
    // The gated attempt never reports a step.retrying — it pauses instead of
    // sleeping in-loop.
    expect(calls()).toBe(1);
    expect(captured.filter((e) => e.type === 'step.retrying')).toHaveLength(0);
  });

  it('applies the default 60s single-wait gate when no gate is configured', async () => {
    const { llm, calls } = rateLimitedLLM(70_000);
    const input = makeInput(llm, new AbortController().signal);

    await expect(chatWithRetry(input)).rejects.toMatchObject({
      name: 'RateLimitPauseError',
      resumeAfterMs: 70_000,
    });
    expect(calls()).toBe(1);
  });

  it('sleeps through a wait under the configured single-wait gate', async () => {
    // 120ms sits under the configured 200ms gate, so the retry proceeds
    // in-loop and succeeds on the second attempt.
    const { llm, calls } = rateLimitedLLM(120, 2);
    const input = makeInput(llm, new AbortController().signal);

    const response = await chatWithRetry({
      ...input,
      foregroundGate: { maxDelayMs: 200 },
    });

    expect(response).toEqual(okResponse());
    expect(calls()).toBe(2);
  });

  it('throws RateLimitPauseError when the cumulative per-step gate is exceeded', async () => {
    // Each attempt asks for 50ms — under the single-wait gate — but the
    // 120ms cumulative cap trips on the third wait (50+50+150%: 150 > 120).
    const { llm, calls } = rateLimitedLLM(50);
    const input = makeInput(llm, new AbortController().signal);

    const error = await chatWithRetry({
      ...input,
      foregroundGate: { maxTotalWaitMs: 120 },
    }).then(
      () => {
        throw new Error('expected chatWithRetry to reject');
      },
      (error: unknown) => error,
    );

    expect(error).toBeInstanceOf(RateLimitPauseError);
    const pause = error as RateLimitPauseError;
    expect(pause.attempts).toBe(3);
    expect(pause.resumeAfterMs).toBe(50);
    expect(pause.totalWaitMs).toBe(150);
    expect(calls()).toBe(3);
  });

  it('clips an over-long server Retry-After and keeps retrying when autoResume is off', async () => {
    // Gate off: the 500ms server directive is clipped to the 80ms cap and the
    // loop retries within its local budget, succeeding on attempt 2.
    const { llm, calls } = rateLimitedLLM(500, 2);
    const captured: Array<{ type: string; delayMs?: number }> = [];
    const input = makeInput(llm, new AbortController().signal);

    const response = await chatWithRetry({
      ...input,
      foregroundGate: { autoResume: false, maxDelayMs: 80 },
      dispatchEvent: async (event) => {
        captured.push(event as { type: string; delayMs?: number });
      },
    });

    expect(response).toEqual(okResponse());
    expect(calls()).toBe(2);
    const retrying = captured.find((e) => e.type === 'step.retrying');
    expect(retrying?.delayMs).toBe(80);
  });

  it('keeps step.retrying event fields unchanged for ungated retries', async () => {
    const { llm } = rateLimitedLLM(42, 2);
    const captured: Array<Record<string, unknown>> = [];
    const input = makeInput(llm, new AbortController().signal);

    await chatWithRetry({
      ...input,
      dispatchEvent: async (event) => {
        captured.push(event as unknown as Record<string, unknown>);
      },
    });

    const retrying = captured.find((e) => e['type'] === 'step.retrying');
    expect(retrying).toMatchObject({
      turnId: 't',
      step: 1,
      stepUuid: 'u',
      failedAttempt: 1,
      nextAttempt: 2,
      maxAttempts: DEFAULT_MAX_RETRY_ATTEMPTS,
      delayMs: 42,
      errorName: 'APIProviderRateLimitError',
    });
  });
});

describe('chatWithRetry: terminated stream drops', () => {
  it('preserves caller-set requestLogFields across attempts while owning turnStep/attempt', async () => {
    // The strict-resend path marks its params with `projection: 'strict'`;
    // the per-attempt rebuild must merge that marker instead of replacing
    // the whole fields object.
    let calls = 0;
    const seenFields: Array<LLMChatParams['requestLogFields']> = [];
    const llm: LLM = {
      systemPrompt: '',
      modelName: 'mock',
      isRetryableError: (e) => isRetryableGenerateError(e),
      async chat(params: LLMChatParams): Promise<LLMChatResponse> {
        calls += 1;
        seenFields.push(params.requestLogFields);
        if (calls === 1) throw new APIConnectionError('terminated');
        return okResponse();
      },
    };
    const input = makeInput(llm, new AbortController().signal);

    await chatWithRetry({
      ...input,
      params: { ...input.params, requestLogFields: { projection: 'strict' } },
    });

    expect(seenFields).toEqual([
      { projection: 'strict', turnStep: 't.1' },
      { projection: 'strict', turnStep: 't.1', attempt: '2/10' },
    ]);
  });

  it('retries an APIConnectionError("terminated") and succeeds on a later attempt', async () => {
    // A mid-stream `terminated` is classified as a retryable APIConnectionError,
    // so an intermittent connection drop should be recovered transparently.
    let calls = 0;
    const llm: LLM = {
      systemPrompt: '',
      modelName: 'mock',
      isRetryableError: (e) => isRetryableGenerateError(e),
      async chat(_params: LLMChatParams): Promise<LLMChatResponse> {
        calls += 1;
        if (calls === 1) throw new APIConnectionError('terminated');
        return okResponse();
      },
    };

    const response = await chatWithRetry(makeInput(llm, new AbortController().signal));

    expect(calls).toBe(2);
    expect(response).toEqual(okResponse());
  });

  it('does NOT retry when the signal is aborted (user ESC), surfacing a clean AbortError', async () => {
    // Even though `terminated` is retryable, a user-aborted request must never
    // be retried: the abort signal is checked before any retry, so it surfaces
    // as an AbortError rather than a provider error.
    let calls = 0;
    const ac = new AbortController();
    ac.abort();

    const llm: LLM = {
      systemPrompt: '',
      modelName: 'mock',
      isRetryableError: (e) => isRetryableGenerateError(e),
      async chat(_params: LLMChatParams): Promise<LLMChatResponse> {
        calls += 1;
        throw new APIConnectionError('terminated');
      },
    };

    await expect(chatWithRetry(makeInput(llm, ac.signal))).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(calls).toBe(1);
  });

  it('does not retry OAuth token fetch connection errors (already retried internally)', async () => {
    let tokenCalls = 0;
    const manager = new ProviderManager({
      config: oauthConfig(),
      resolveOAuthTokenProvider: () => ({
        async getAccessToken() {
          tokenCalls += 1;
          throw new CloudCodeError(
            ErrorCodes.PROVIDER_CONNECTION_ERROR,
            'OAuth provider "managed:kimi-code" failed to fetch an access token: fetch failed',
          );
        },
      }),
    });
    const resolveAuth = manager.resolveAuth('kimi-code/kimi-for-coding');
    if (resolveAuth === undefined) throw new Error('expected OAuth auth resolver');

    let chatCalls = 0;
    const llm: LLM = {
      systemPrompt: '',
      modelName: 'mock',
      isRetryableError: (e) => isRetryableGenerateError(e),
      async chat(_params: LLMChatParams): Promise<LLMChatResponse> {
        chatCalls += 1;
        return resolveAuth(async () => okResponse());
      },
    };

    await expect(chatWithRetry(makeInput(llm, new AbortController().signal))).rejects.toMatchObject({
      code: ErrorCodes.PROVIDER_CONNECTION_ERROR,
    });
    expect(chatCalls).toBe(1);
    expect(tokenCalls).toBe(1);
  });
});

describe('retryBackoffDelays', () => {
  it('uses a 500ms base, factor-2 ramp, 32s cap, and up to +25% jitter', () => {
    const delays = retryBackoffDelays(10);
    expect(delays).toHaveLength(9);
    // Max possible delay is the capped base (32s) plus 25% jitter = 40s.
    for (const d of delays) {
      expect(d).toBeGreaterThan(0);
      expect(d).toBeLessThanOrEqual(40_000);
    }
    // First attempt base is 500ms (plus up to 25% jitter) -> within [500, 625].
    expect(delays[0]).toBeGreaterThanOrEqual(500);
    expect(delays[0]).toBeLessThanOrEqual(625);
  });

  it('reaches the 32s cap for high-attempt configs (overload ride-out)', () => {
    // The ramp hits 32s by attempt 7 (500 * 2^6); across many draws the peak
    // approaches the cap (32s..40s with jitter), well above the old 5s cap.
    let maxSeen = 0;
    for (let i = 0; i < 50; i += 1) {
      for (const d of retryBackoffDelays(12)) {
        maxSeen = Math.max(maxSeen, d);
      }
    }
    expect(maxSeen).toBeGreaterThan(30_000);
  });

  it('keeps low-attempt configs quick so latency-sensitive runs are not slowed', () => {
    // 3 attempts -> 2 delays at the bottom of the ramp (~0.5s / ~1s before
    // jitter); their sum stays small.
    const delays = retryBackoffDelays(3);
    expect(delays).toHaveLength(2);
    expect(delays.reduce((a, b) => a + b, 0)).toBeLessThan(3_000);
  });
});

describe('chatWithRetry: default retry budget', () => {
  it('retries up to DEFAULT_MAX_RETRY_ATTEMPTS before giving up', async () => {
    // A sustained 429 carries a 1ms server retry-after so the test exercises
    // the full default budget without sleeping through the real backoff.
    let calls = 0;
    const captured: Array<{ type: string }> = [];
    const llm: LLM = {
      systemPrompt: '',
      modelName: 'mock',
      isRetryableError: (e) => isRetryableGenerateError(e),
      async chat(): Promise<LLMChatResponse> {
        calls += 1;
        throw new APIProviderRateLimitError('rate limited', null, 1);
      },
    };
    const input = makeInput(llm, new AbortController().signal);

    await expect(
      chatWithRetry({
        ...input,
        dispatchEvent: async (event) => {
          captured.push(event as { type: string });
        },
      }),
    ).rejects.toMatchObject({ name: 'APIProviderRateLimitError' });

    expect(calls).toBe(DEFAULT_MAX_RETRY_ATTEMPTS);
    expect(captured.filter((e) => e.type === 'step.retrying')).toHaveLength(
      DEFAULT_MAX_RETRY_ATTEMPTS - 1,
    );
  });
});

describe('chatWithRetry: quota-exhausted errors fail fast', () => {
  it('makes exactly one attempt and dispatches no step.retrying', async () => {
    // An exhausted ChatGPT plan cannot serve another request until the usage
    // window resets — the loop must surface the error on first sight instead
    // of riding out the full retry budget like a transient 429.
    let calls = 0;
    const captured: Array<{ type: string }> = [];
    const llm: LLM = {
      systemPrompt: '',
      modelName: 'mock',
      isRetryableError: (e) => isRetryableGenerateError(e),
      async chat(): Promise<LLMChatResponse> {
        calls += 1;
        throw new APIQuotaExceededError('The usage limit has been reached', {
          planType: 'pro',
          resetsAtMs: 1_900_000_000_000,
          quotaWindow: '5h',
        });
      },
    };
    const input = makeInput(llm, new AbortController().signal);

    await expect(
      chatWithRetry({
        ...input,
        dispatchEvent: async (event) => {
          captured.push(event as { type: string });
        },
      }),
    ).rejects.toMatchObject({ name: 'APIQuotaExceededError' });

    expect(calls).toBe(1);
    expect(captured.filter((e) => e.type === 'step.retrying')).toHaveLength(0);
  });

  it('still forwards the quota error rate-limit snapshot once via onRateLimit', async () => {
    const quotaError = new APIQuotaExceededError('The usage limit has been reached', {
      quotaWindow: 'weekly',
    });
    quotaError.rateLimit = {
      planType: 'pro',
      activeLimit: null,
      primary: { usedPercent: 40, windowMinutes: 300, resetsAt: null },
      secondary: { usedPercent: 100, windowMinutes: 10080, resetsAt: 1_900_500_000 },
      credits: null,
      capturedAt: 1_900_000_000_000,
    };
    const llm: LLM = {
      systemPrompt: '',
      modelName: 'mock',
      isRetryableError: (e) => isRetryableGenerateError(e),
      async chat(): Promise<LLMChatResponse> {
        throw quotaError;
      },
    };
    const input = makeInput(llm, new AbortController().signal);
    const onRateLimit = vi.fn();

    await expect(
      chatWithRetry({ ...input, params: { ...input.params, onRateLimit } }),
    ).rejects.toBe(quotaError);

    // The host's quota view refreshes from the single failed attempt even
    // though no retry follows.
    expect(onRateLimit).toHaveBeenCalledTimes(1);
    expect(onRateLimit).toHaveBeenCalledWith(quotaError.rateLimit);
  });
});

describe('chatWithRetry: honors server retry-after', () => {
  it('uses the error retryAfterMs as the retry delay instead of the backoff', async () => {
    let calls = 0;
    const captured: Array<{ type: string; delayMs?: number }> = [];
    const llm: LLM = {
      systemPrompt: '',
      modelName: 'mock',
      isRetryableError: (e) => isRetryableGenerateError(e),
      async chat(): Promise<LLMChatResponse> {
        calls += 1;
        if (calls === 1) {
          // 429 carrying a server `retry-after` of 42ms. Kept tiny so the test
          // sleeps only briefly, while still being distinguishable from the
          // attempt-1 backoff (500..625ms) it must override.
          throw new APIProviderRateLimitError('rate limited', null, 42);
        }
        return okResponse();
      },
    };
    const input = makeInput(llm, new AbortController().signal);
    await chatWithRetry({
      ...input,
      dispatchEvent: async (event) => {
        captured.push(event as { type: string; delayMs?: number });
      },
    });

    expect(calls).toBe(2);
    const retrying = captured.find((e) => e.type === 'step.retrying');
    expect(retrying?.delayMs).toBe(42);
  });
});

describe('chatWithRetry: rate-limit snapshot capture on failed attempts', () => {
  const SNAPSHOT = {
    planType: 'plus',
    activeLimit: 'premium',
    primary: { usedPercent: 100, windowMinutes: 300, resetsAt: 1900000000 },
    secondary: null,
    credits: null,
    capturedAt: 1900000000000,
  } as const;

  function rateLimitError(): APIProviderRateLimitError {
    // A 429 whose response carried the Codex `x-codex-*` quota headers; the
    // provider error converter attaches the parsed snapshot to the error.
    // retryAfterMs=1 keeps the retry sleeps negligible.
    const error = new APIProviderRateLimitError('rate limited', null, 1);
    error.rateLimit = SNAPSHOT;
    return error;
  }

  it('forwards the failed attempt rate-limit snapshot to params.onRateLimit on every attempt', async () => {
    let calls = 0;
    const llm: LLM = {
      systemPrompt: '',
      modelName: 'mock',
      isRetryableError: (e) => isRetryableGenerateError(e),
      async chat(): Promise<LLMChatResponse> {
        calls += 1;
        throw rateLimitError();
      },
    };
    const input = makeInput(llm, new AbortController().signal);
    const onRateLimit = vi.fn();

    await expect(
      chatWithRetry({
        ...input,
        params: { ...input.params, onRateLimit },
        maxAttempts: 3,
      }),
    ).rejects.toMatchObject({ name: 'APIProviderRateLimitError' });

    expect(calls).toBe(3);
    expect(onRateLimit).toHaveBeenCalledTimes(3);
    expect(onRateLimit).toHaveBeenCalledWith(SNAPSHOT);
  });

  it('fires onRateLimit once for a non-retryable error carrying a snapshot', async () => {
    const llm: LLM = {
      systemPrompt: '',
      modelName: 'mock',
      isRetryableError: (e) => isRetryableGenerateError(e),
      async chat(): Promise<LLMChatResponse> {
        throw rateLimitError();
      },
    };
    const input = makeInput(llm, new AbortController().signal);
    const onRateLimit = vi.fn();

    await expect(
      chatWithRetry({ ...input, params: { ...input.params, onRateLimit }, maxAttempts: 1 }),
    ).rejects.toMatchObject({ name: 'APIProviderRateLimitError' });

    expect(onRateLimit).toHaveBeenCalledTimes(1);
    expect(onRateLimit).toHaveBeenCalledWith(SNAPSHOT);
  });

  it('reaches the snapshot through a wrapped error cause chain', async () => {
    const wrapped = Object.assign(new Error('gateway wrapper'), { cause: rateLimitError() });
    const llm: LLM = {
      systemPrompt: '',
      modelName: 'mock',
      isRetryableError: (e) => isRetryableGenerateError(e),
      async chat(): Promise<LLMChatResponse> {
        throw wrapped;
      },
    };
    const input = makeInput(llm, new AbortController().signal);
    const onRateLimit = vi.fn();

    await expect(
      chatWithRetry({ ...input, params: { ...input.params, onRateLimit } }),
    ).rejects.toBe(wrapped);

    expect(onRateLimit).toHaveBeenCalledTimes(1);
    expect(onRateLimit).toHaveBeenCalledWith(SNAPSHOT);
  });

  it('does not fire onRateLimit when the error carries no snapshot', async () => {
    let calls = 0;
    const llm: LLM = {
      systemPrompt: '',
      modelName: 'mock',
      isRetryableError: (e) => isRetryableGenerateError(e),
      async chat(): Promise<LLMChatResponse> {
        calls += 1;
        if (calls === 1) throw new APIConnectionError('terminated');
        return okResponse();
      },
    };
    const input = makeInput(llm, new AbortController().signal);
    const onRateLimit = vi.fn();

    await chatWithRetry({ ...input, params: { ...input.params, onRateLimit } });

    expect(calls).toBe(2);
    expect(onRateLimit).not.toHaveBeenCalled();
  });
});

function oauthConfig(): CloudCodeConfig {
  return {
    defaultModel: 'kimi-code/kimi-for-coding',
    providers: {
      'managed:kimi-code': {
        type: 'kimi',
        apiKey: '',
        baseUrl: 'https://api.example/v1',
        oauth: { storage: 'file', key: 'oauth/kimi-code' },
      },
    },
    models: {
      'kimi-code/kimi-for-coding': {
        provider: 'managed:kimi-code',
        model: 'kimi-for-coding',
        maxContextSize: 1_000_000,
      },
    },
  };
}
