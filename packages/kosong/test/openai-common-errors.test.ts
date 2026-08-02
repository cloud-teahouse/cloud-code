import {
  APIConnectionError,
  APIContextOverflowError,
  APIProviderQuotaExhaustedError,
  APIProviderRateLimitError,
  APIQuotaExceededError,
  APIStatusError,
  APITimeoutError,
  ChatProviderError,
  isRetryableGenerateError,
  normalizeAPIStatusError,
} from '#/errors';
import type { ContentPart } from '#/message';
import { classifyKimiQuotaError } from '#/providers/kimi-errors';
import {
  convertContentPart,
  convertOpenAIError,
} from '#/providers/openai-common';
import { OpenAILegacyChatProvider, OpenAILegacyStreamedMessage } from '#/providers/openai-legacy';
import { ReasoningKeyDialect } from '#/providers/reasoning-key';
import {
  APIError as OpenAIAPIError,
  APIConnectionError as OpenAIConnectionError,
  APIConnectionTimeoutError as OpenAITimeoutError,
  APIUserAbortError as OpenAIUserAbortError,
} from 'openai';
import { describe, it, expect } from 'vitest';
describe('OpenAI client creation', () => {
  it('does not inject max_retries into OpenAI client', () => {
    // The OpenAI constructor is called with apiKey and baseURL only —
    // we verify that the provider does not set max_retries.
    const provider = new OpenAILegacyChatProvider({
      model: 'gpt-4.1',
      apiKey: 'test-key',
      baseUrl: 'https://example.com/v1',
    });

    const client = (provider as any)._client as Record<string, unknown>;
    expect((client as unknown as Record<string, unknown>)['maxRetries']).not.toBe(0);
  });
});
describe('convertOpenAIError: base APIError mapping', () => {
  const cases: Array<{ message: string; expectedType: typeof ChatProviderError; id: string }> = [
    {
      message: 'Network connection lost.',
      expectedType: APIConnectionError,
      id: 'network_connection_lost',
    },
    { message: 'Connection error.', expectedType: APIConnectionError, id: 'connection_error' },
    { message: 'network error', expectedType: APIConnectionError, id: 'network_error' },
    { message: 'disconnected from server', expectedType: APIConnectionError, id: 'disconnected' },
    {
      message: 'connection reset by peer',
      expectedType: APIConnectionError,
      id: 'connection_reset_by_peer',
    },
    {
      message: 'connection closed unexpectedly',
      expectedType: APIConnectionError,
      id: 'connection_closed_unexpectedly',
    },
    { message: 'Request timed out.', expectedType: APITimeoutError, id: 'request_timed_out' },
    { message: 'timed out', expectedType: APITimeoutError, id: 'timed_out' },
    // Timeout must take priority over network when both patterns match.
    {
      message: 'connection timed out',
      expectedType: APITimeoutError,
      id: 'connection_timed_out_timeout_priority',
    },
    {
      message: 'Something completely unrelated',
      expectedType: ChatProviderError,
      id: 'unrelated_error',
    },
    {
      message: 'Internal server error',
      expectedType: ChatProviderError,
      id: 'internal_server_error',
    },
    // Bare "reset"/"closed" must NOT match — they are too broad
    {
      message: 'Your session has been reset',
      expectedType: ChatProviderError,
      id: 'bare_reset_no_match',
    },
    {
      message: 'Stream closed by server due to policy violation',
      expectedType: ChatProviderError,
      id: 'bare_closed_no_match',
    },
  ];

  for (const { message, expectedType, id } of cases) {
    it(`classifies "${id}": ${message}`, () => {
      // Base APIError with no status and no body (transport-layer failure)
      const err = new OpenAIAPIError(undefined, undefined, message, undefined);
      const result = convertOpenAIError(err);
      expect(result).toBeInstanceOf(expectedType);
    });
  }
});
describe('convertOpenAIError: existing provider errors', () => {
  it('preserves an existing ChatProviderError instance', () => {
    const err = new APIStatusError(401, 'Unauthorized', 'req-401');

    expect(convertOpenAIError(err)).toBe(err);
  });
});
describe('convertOpenAIError: context overflow', () => {
  it('normalizes context overflow status errors', () => {
    const err = new OpenAIAPIError(413, undefined, 'Context length exceeded', undefined);
    const result = convertOpenAIError(err);
    expect(result).toBeInstanceOf(APIContextOverflowError);
    expect((result as APIContextOverflowError).statusCode).toBe(413);
  });
});
describe('convertOpenAIError: provider rate limit', () => {
  it('normalizes HTTP 429 status errors to APIProviderRateLimitError', () => {
    const err = new OpenAIAPIError(429, undefined, 'Too many requests', new Headers());
    const result = convertOpenAIError(err);
    expect(result).toBeInstanceOf(APIProviderRateLimitError);
    expect((result as APIProviderRateLimitError).statusCode).toBe(429);
  });

  it('reads an integer retry-after header (seconds) onto the rate-limit error', () => {
    const err = new OpenAIAPIError(
      429,
      undefined,
      'Too many requests',
      new Headers({ 'retry-after': '12' }),
    );
    const result = convertOpenAIError(err);
    expect(result).toBeInstanceOf(APIProviderRateLimitError);
    expect((result as APIProviderRateLimitError).retryAfterMs).toBe(12_000);
  });

  it('ignores a past HTTP-date retry-after header, leaving retryAfterMs null', () => {
    // A past date asks for no wait at all, so it is not a backoff directive;
    // a FUTURE HTTP-date would now be honored (see errors.test.ts).
    const err = new OpenAIAPIError(
      429,
      undefined,
      'Too many requests',
      new Headers({ 'retry-after': 'Wed, 21 Oct 2015 07:28:00 GMT' }),
    );
    const result = convertOpenAIError(err);
    expect(result).toBeInstanceOf(APIProviderRateLimitError);
    expect((result as APIProviderRateLimitError).retryAfterMs).toBeNull();
  });

  it('carries the x-trace-id response header onto the status error', () => {
    const err = new OpenAIAPIError(
      500,
      undefined,
      'Internal server error',
      new Headers({ 'x-trace-id': 'trace-err-500' }),
    );
    const result = convertOpenAIError(err);
    expect(result).toBeInstanceOf(APIStatusError);
    expect((result as APIStatusError).traceId).toBe('trace-err-500');
  });

  it('leaves traceId null when the error response has no x-trace-id header', () => {
    const err = new OpenAIAPIError(500, undefined, 'Internal server error', new Headers());
    const result = convertOpenAIError(err);
    expect(result).toBeInstanceOf(APIStatusError);
    expect((result as APIStatusError).traceId).toBeNull();
  });

  it('leaves traceId null when the x-trace-id header is empty', () => {
    const err = new OpenAIAPIError(
      500,
      undefined,
      'Internal server error',
      new Headers({ 'x-trace-id': '' }),
    );
    const result = convertOpenAIError(err);
    expect(result).toBeInstanceOf(APIStatusError);
    expect((result as APIStatusError).traceId).toBeNull();
  });

  it('carries the x-codex-* rate-limit headers from a 429 error response as a snapshot', () => {
    const err = new OpenAIAPIError(
      429,
      undefined,
      'Too many requests',
      new Headers({
        'x-codex-plan-type': 'plus',
        'x-codex-active-limit': 'premium',
        'x-codex-primary-used-percent': '99.5',
        'x-codex-primary-window-minutes': '300',
        'x-codex-primary-reset-at': '1900000000',
        'x-codex-secondary-used-percent': '40',
        'x-codex-secondary-window-minutes': '10080',
        'x-codex-credits-has-credits': 'true',
        'x-codex-credits-unlimited': 'false',
        'x-codex-credits-balance': '25',
      }),
    );
    const result = convertOpenAIError(err);
    expect(result).toBeInstanceOf(APIProviderRateLimitError);
    expect((result as APIProviderRateLimitError).rateLimit).toMatchObject({
      planType: 'plus',
      activeLimit: 'premium',
      primary: { usedPercent: 99.5, windowMinutes: 300, resetsAt: 1900000000 },
      secondary: { usedPercent: 40, windowMinutes: 10080, resetsAt: null },
      credits: { hasCredits: true, unlimited: false, balance: '25' },
    });
    expect(typeof (result as APIProviderRateLimitError).rateLimit?.capturedAt).toBe('number');
  });

  it('carries the x-codex-* snapshot on a non-429 status error too (e.g. 500)', () => {
    const err = new OpenAIAPIError(
      500,
      undefined,
      'Internal server error',
      new Headers({
        'x-codex-plan-type': 'team',
        'x-codex-primary-used-percent': '12',
        'x-codex-primary-window-minutes': '300',
      }),
    );
    const result = convertOpenAIError(err);
    expect(result).toBeInstanceOf(APIStatusError);
    expect((result as APIStatusError).statusCode).toBe(500);
    expect((result as APIStatusError).rateLimit).toMatchObject({
      planType: 'team',
      primary: { usedPercent: 12, windowMinutes: 300, resetsAt: null },
    });
  });

  it('leaves rateLimit null when the error response has no x-codex-* headers', () => {
    const err = new OpenAIAPIError(429, undefined, 'Too many requests', new Headers());
    const result = convertOpenAIError(err);
    expect(result).toBeInstanceOf(APIProviderRateLimitError);
    expect((result as APIProviderRateLimitError).rateLimit).toBeNull();
  });

  it('leaves rateLimit null when the SDK error carries no headers at all', () => {
    const err = new OpenAIAPIError(429, undefined, 'Too many requests', undefined);
    const result = convertOpenAIError(err);
    expect(result).toBeInstanceOf(APIProviderRateLimitError);
    expect((result as APIProviderRateLimitError).rateLimit).toBeNull();
  });
});
describe('convertOpenAIError: codex quota exhaustion', () => {
  it('classifies a 429 with a usage_limit_reached body as APIQuotaExceededError', () => {
    const err = new OpenAIAPIError(
      429,
      {
        error: {
          type: 'usage_limit_reached',
          message: 'The usage limit has been reached',
          plan_type: 'pro',
          resets_at: 1_900_000_000,
        },
      },
      'The usage limit has been reached',
      new Headers(),
    );
    const result = convertOpenAIError(err);
    expect(result).toBeInstanceOf(APIQuotaExceededError);
    expect(result).toBeInstanceOf(APIProviderRateLimitError);
    const quota = result as APIQuotaExceededError;
    expect(quota.statusCode).toBe(429);
    expect(quota.planType).toBe('pro');
    expect(quota.resetsAtMs).toBe(1_900_000_000_000);
    expect(isRetryableGenerateError(result)).toBe(false);
  });

  it('derives the exhausted window from the x-codex-* headers on the same response', () => {
    const err = new OpenAIAPIError(
      429,
      { error: { type: 'usage_limit_reached', message: 'limit reached' } },
      'limit reached',
      new Headers({
        'x-codex-plan-type': 'plus',
        'x-codex-primary-used-percent': '100',
        'x-codex-primary-window-minutes': '300',
        'x-codex-primary-reset-at': '1900000000',
      }),
    );
    const result = convertOpenAIError(err) as APIQuotaExceededError;
    // Body carried no resets_at: the exhausted primary window's reset-at
    // (unix seconds) fills in, and the plan type falls back to the snapshot.
    expect(result.resetsAtMs).toBe(1_900_000_000_000);
    expect(result.quotaWindow).toBe('5h');
    expect(result.planType).toBe('plus');
    expect(result.rateLimit).toMatchObject({
      primary: { usedPercent: 100, windowMinutes: 300, resetsAt: 1900000000 },
    });
  });

  it('leaves window/reset null when the 429 carries no x-codex-* headers', () => {
    const err = new OpenAIAPIError(
      429,
      { error: { type: 'usage_limit_reached', message: 'limit reached' } },
      'limit reached',
      new Headers(),
    );
    const result = convertOpenAIError(err) as APIQuotaExceededError;
    expect(result).toBeInstanceOf(APIQuotaExceededError);
    expect(result.quotaWindow).toBeNull();
    expect(result.resetsAtMs).toBeNull();
    expect(result.rateLimit).toBeNull();
  });

  it('keeps a 429 with a non-quota body on the transient retry path', () => {
    const err = new OpenAIAPIError(
      429,
      { error: { type: 'rate_limit_error', message: 'slow down' } },
      'slow down',
      new Headers(),
    );
    const result = convertOpenAIError(err);
    expect(result).toBeInstanceOf(APIProviderRateLimitError);
    expect(result).not.toBeInstanceOf(APIQuotaExceededError);
    expect(isRetryableGenerateError(result)).toBe(true);
  });

  it('keeps a Kimi-style RPM 429 (no body) retryable — kimi parity unchanged', () => {
    const err = new OpenAIAPIError(
      429,
      undefined,
      'request reached user+model max RPM: 50',
      new Headers(),
    );
    const result = convertOpenAIError(err);
    expect(result).toBeInstanceOf(APIProviderRateLimitError);
    expect(result).not.toBeInstanceOf(APIQuotaExceededError);
    expect(isRetryableGenerateError(result)).toBe(true);
  });
});

describe('convertOpenAIError: codex quota exhaustion via the real SDK constructor', () => {
  // Regression: the OpenAI SDK v6 builds status errors through
  // `APIError.generate(status, parsedBody, message, headers)`, which UNWRAPS
  // the body — `error.error` is the inner error object
  // `{type, message, plan_type, resets_at}`, never `{error: {...}}`. Tests
  // that hand-construct `new APIError(429, {error: {...}})` exercise a shape
  // production never produces; these cases go through the SDK's own
  // constructor exactly as `makeStatusError` calls it.
  it('classifies the SDK-generated RateLimitError as APIQuotaExceededError', () => {
    const wireBody = {
      error: {
        type: 'usage_limit_reached',
        message: 'The usage limit has been reached',
        plan_type: 'pro',
        resets_at: 1_900_000_000,
      },
    };
    const err = OpenAIAPIError.generate(
      429,
      wireBody,
      undefined,
      new Headers({
        'x-codex-plan-type': 'pro',
        'x-codex-primary-used-percent': '100',
        'x-codex-primary-window-minutes': '300',
        'x-codex-primary-reset-at': '1900000000',
      }),
    );
    // Guard the guard: the SDK really did unwrap the body.
    expect(err.error).toEqual(wireBody.error);

    const result = convertOpenAIError(err);
    expect(result).toBeInstanceOf(APIQuotaExceededError);
    const quota = result as APIQuotaExceededError;
    expect(quota.statusCode).toBe(429);
    expect(quota.planType).toBe('pro');
    expect(quota.resetsAtMs).toBe(1_900_000_000_000);
    expect(quota.quotaWindow).toBe('5h');
    expect(isRetryableGenerateError(result)).toBe(false);
  });

  it('keeps the SDK-generated transient 429 retryable', () => {
    const err = OpenAIAPIError.generate(
      429,
      { error: { type: 'rate_limit_error', message: 'slow down' } },
      undefined,
      new Headers(),
    );
    const result = convertOpenAIError(err);
    expect(result).toBeInstanceOf(APIProviderRateLimitError);
    expect(result).not.toBeInstanceOf(APIQuotaExceededError);
    expect(isRetryableGenerateError(result)).toBe(true);
  });

  it('classifies a 429 with an unparseable body via the message token', () => {
    // When the body is not JSON (plain text, or an edge proxy relaying the
    // backend's error as text) the SDK leaves `error.error` undefined and
    // folds the raw text into the message — the machine token is the only
    // signal left. Plan/reset then come from the x-codex-* headers.
    const err = OpenAIAPIError.generate(
      429,
      undefined,
      'usage_limit_reached',
      new Headers({
        'x-codex-plan-type': 'plus',
        'x-codex-secondary-used-percent': '100',
        'x-codex-secondary-window-minutes': '10080',
        'x-codex-secondary-reset-at': '1900500000',
      }),
    );
    expect(err.error).toBeUndefined();

    const result = convertOpenAIError(err);
    expect(result).toBeInstanceOf(APIQuotaExceededError);
    const quota = result as APIQuotaExceededError;
    expect(quota.planType).toBe('plus');
    expect(quota.resetsAtMs).toBe(1_900_500_000_000);
    expect(quota.quotaWindow).toBe('weekly');
    expect(isRetryableGenerateError(result)).toBe(false);
  });

  it('keeps a plain-text transient 429 (no token) retryable', () => {
    const err = OpenAIAPIError.generate(429, undefined, 'Too Many Requests', new Headers());
    const result = convertOpenAIError(err);
    expect(result).toBeInstanceOf(APIProviderRateLimitError);
    expect(result).not.toBeInstanceOf(APIQuotaExceededError);
    expect(isRetryableGenerateError(result)).toBe(true);
  });
});

describe('convertOpenAIError: subclass errors still match first', () => {
  it('APIConnectionError matches its own case', () => {
    const connErr = new OpenAIConnectionError({ message: 'Connection error.' });
    const result = convertOpenAIError(connErr);
    expect(result).toBeInstanceOf(APIConnectionError);
  });

  it('APIConnectionTimeoutError matches as timeout', () => {
    const timeoutErr = new OpenAITimeoutError({ message: 'Request timed out.' });
    const result = convertOpenAIError(timeoutErr);
    expect(result).toBeInstanceOf(APITimeoutError);
  });
});
describe('convertOpenAIError: APIError with body skips heuristic', () => {
  it('does not heuristically reclassify when error has a body', () => {
    // SSE error events carry a body — they must NOT be reclassified
    // even if the message contains network keywords.
    const err = new OpenAIAPIError(
      undefined,
      { error: { message: 'Connection limit exceeded', type: 'server_error' } },
      'Connection limit exceeded',
      undefined,
    );
    const result = convertOpenAIError(err);
    // Should NOT be APIConnectionError despite "Connection" in message
    expect(result.constructor).toBe(ChatProviderError);
  });
});
describe('convertOpenAIError: abort guard', () => {
  it('APIUserAbortError throws the standard abort DOMException instead of being classified', () => {
    // A user cancellation must never be converted into (or returned as) a
    // retryable provider error: the guard at the very front of the
    // classification chain throws the standard abort shape.
    const err = new OpenAIUserAbortError({ message: 'connection aborted by user' });
    const thrown = catchThrown(() => convertOpenAIError(err));
    expect(thrown).toBeInstanceOf(DOMException);
    expect((thrown as DOMException).name).toBe('AbortError');
    expect(isRetryableGenerateError(thrown)).toBe(false);
  });

  it('bare AbortError DOMException throws the standard abort DOMException', () => {
    const err = new DOMException('The operation was aborted.', 'AbortError');
    const thrown = catchThrown(() => convertOpenAIError(err));
    expect(thrown).toBeInstanceOf(DOMException);
    expect((thrown as DOMException).name).toBe('AbortError');
    expect(isRetryableGenerateError(thrown)).toBe(false);
  });

  it('bare Error named AbortError throws the standard abort DOMException', () => {
    const err = new Error('The operation was aborted.');
    err.name = 'AbortError';
    const thrown = catchThrown(() => convertOpenAIError(err));
    expect(thrown).toBeInstanceOf(DOMException);
    expect((thrown as DOMException).name).toBe('AbortError');
    expect(isRetryableGenerateError(thrown)).toBe(false);
  });
});

function catchThrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('Expected the function to throw');
}
describe('OpenAI streaming error propagation', () => {
  it('base APIError("Network connection lost.") during streaming becomes APIConnectionError', async () => {
    // Simulates: streaming for ~33 minutes, then SSE connection drops
    // and the SDK raises openai.APIError("Network connection lost.")
    async function* failingStream(): AsyncGenerator<never> {
      throw new OpenAIAPIError(undefined, undefined, 'Network connection lost.', undefined);
      // Make this an async generator (unreachable)
      yield undefined as never;
    }

    const msg = new OpenAILegacyStreamedMessage(
      failingStream() as AsyncIterable<never>,
      true,
      new ReasoningKeyDialect(),
    );

    await expect(async () => {
      for await (const _ of msg) {
        void _;
      }
    }).rejects.toThrow(APIConnectionError);

    await expect(async () => {
      async function* failingStream2(): AsyncGenerator<never> {
        throw new OpenAIAPIError(undefined, undefined, 'Network connection lost.', undefined);
        yield undefined as never;
      }
      const msg2 = new OpenAILegacyStreamedMessage(
        failingStream2() as AsyncIterable<never>,
        true,
        new ReasoningKeyDialect(),
      );
      for await (const _ of msg2) {
        void _;
      }
    }).rejects.toThrow(/Network connection lost/);
  });
});
describe('convertOpenAIError: raw transport-layer stream errors', () => {
  it('classifies undici TypeError("terminated") as a retryable APIConnectionError', () => {
    // Node v24 + undici raises a raw `TypeError: terminated` when an SSE
    // response stream is dropped mid-flight. It is NOT an OpenAI SDK error,
    // so it falls into the generic Error branch — but it is a transport-layer
    // connection failure and must be retryable like any dropped connection.
    const err = new TypeError('terminated');
    (err as { cause?: unknown }).cause = new Error('other side closed');

    const result = convertOpenAIError(err);

    expect(result).toBeInstanceOf(APIConnectionError);
    expect(isRetryableGenerateError(result)).toBe(true);
  });

  it('still wraps an unrelated raw Error as a base ChatProviderError, now retryable via fallback', () => {
    // An unrelated raw Error is NOT an OpenAI SDK error and carries no usable
    // HTTP status, so convertOpenAIError wraps it as a base ChatProviderError
    // (constructor check guards that typing). The fallback safety net in
    // isRetryableGenerateError then treats such unclassified provider failures
    // as transient — retry beats failing the run on the first blip.
    const result = convertOpenAIError(new Error('something completely unrelated'));

    expect(result.constructor).toBe(ChatProviderError);
    expect(isRetryableGenerateError(result)).toBe(true);
  });
});
describe('OpenAI streaming: undici terminated mid-stream', () => {
  it('a stream that throws TypeError("terminated") rejects with retryable APIConnectionError', async () => {
    // Simulates the real-world failure: the SSE stream drops mid-flight and
    // undici raises a raw `TypeError: terminated` from inside the for-await
    // loop. The provider must surface a retryable APIConnectionError so the
    // loop retries instead of failing the turn outright.
    async function* terminatedStream(): AsyncGenerator<never> {
      throw new TypeError('terminated');
      yield undefined as never;
    }

    const msg = new OpenAILegacyStreamedMessage(
      terminatedStream() as AsyncIterable<never>,
      true,
      new ReasoningKeyDialect(),
    );

    let caught: unknown;
    try {
      for await (const _ of msg) {
        void _;
      }
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(APIConnectionError);
    expect(isRetryableGenerateError(caught)).toBe(true);
  });
});
describe('convertContentPart', () => {
  it('converts TextPart to OpenAI text content part', () => {
    expect(convertContentPart({ type: 'text', text: 'hi' })).toEqual({
      type: 'text',
      text: 'hi',
    });
  });

  it('returns null for ThinkPart (handled separately as reasoning_content)', () => {
    expect(convertContentPart({ type: 'think', think: 'reasoning' })).toBeNull();
  });

  it('converts ImageURLPart without id', () => {
    expect(
      convertContentPart({ type: 'image_url', imageUrl: { url: 'https://ex/img.png' } }),
    ).toEqual({ type: 'image_url', image_url: { url: 'https://ex/img.png' } });
  });

  it('converts ImageURLPart with id', () => {
    expect(
      convertContentPart({
        type: 'image_url',
        imageUrl: { url: 'https://ex/img.png', id: 'img-1' },
      }),
    ).toEqual({ type: 'image_url', image_url: { url: 'https://ex/img.png', id: 'img-1' } });
  });

  it('converts AudioURLPart without id', () => {
    expect(
      convertContentPart({ type: 'audio_url', audioUrl: { url: 'https://ex/a.mp3' } }),
    ).toEqual({ type: 'audio_url', audio_url: { url: 'https://ex/a.mp3' } });
  });

  it('converts AudioURLPart with id', () => {
    expect(
      convertContentPart({
        type: 'audio_url',
        audioUrl: { url: 'https://ex/a.mp3', id: 'a-1' },
      }),
    ).toEqual({ type: 'audio_url', audio_url: { url: 'https://ex/a.mp3', id: 'a-1' } });
  });

  it('converts VideoURLPart without id', () => {
    expect(
      convertContentPart({ type: 'video_url', videoUrl: { url: 'https://ex/v.mp4' } }),
    ).toEqual({ type: 'video_url', video_url: { url: 'https://ex/v.mp4' } });
  });

  it('converts VideoURLPart with id', () => {
    expect(
      convertContentPart({
        type: 'video_url',
        videoUrl: { url: 'https://ex/v.mp4', id: 'v-1' },
      }),
    ).toEqual({ type: 'video_url', video_url: { url: 'https://ex/v.mp4', id: 'v-1' } });
  });

  it('throws on unknown content part type', () => {
    // Force an invalid type to exercise the defensive branch.
    const bogus = { type: 'bogus', text: 'x' } as unknown as ContentPart;
    expect(() => convertContentPart(bogus)).toThrow(/Unknown content part type/);
  });
});
describe('normalizeAPIStatusError thinking effort guidance', () => {
  it('adds configuration guidance when a provider rejects reasoning_effort', () => {
    const error = normalizeAPIStatusError(400, 'Invalid reasoning_effort: xhigh');

    expect(error.message).toContain('Non-Kimi providers receive effort strings');
    expect(error.message).toContain(
      'https://github.com/cloud-teahouse/cloud-code#readme',
    );
  });
});
describe('convertOpenAIError: non-Error values', () => {
  it('wraps a plain string as ChatProviderError', () => {
    const result = convertOpenAIError('something went sideways');
    expect(result.constructor).toBe(ChatProviderError);
    expect(result.message).toContain('something went sideways');
  });

  it('wraps a plain Error as ChatProviderError', () => {
    const result = convertOpenAIError(new Error('plain error'));
    expect(result.constructor).toBe(ChatProviderError);
    expect(result.message).toContain('plain error');
  });
});

describe('convertOpenAIError: quota-exhausted 429', () => {
  const QUOTA_MESSAGE =
    'Your account org-0123456789abcdef <ak-test> is suspended due to insufficient balance, please recharge your account or check your plan and billing details';

  it("classifies OpenAI's own insufficient_quota code without any vendor hook", () => {
    // insufficient_quota is OpenAI's documented signal on its own wire, so
    // the base converter recognizes it directly.
    const err = new OpenAIAPIError(
      429,
      { message: 'You exceeded your current quota.', type: 'insufficient_quota' },
      '429 You exceeded your current quota.',
      new Headers(),
    );
    const result = convertOpenAIError(err);
    expect(result).toBeInstanceOf(APIProviderQuotaExhaustedError);
    expect((result as APIProviderQuotaExhaustedError).statusCode).toBe(429);
    expect(isRetryableGenerateError(result)).toBe(false);
  });

  it('keeps vendor quota signals a rate limit without the vendor hook', () => {
    // Moonshot's structured type and billing wordings are vendor knowledge —
    // the shared base must not decide what another vendor's 429 means.
    const err = new OpenAIAPIError(
      429,
      { message: QUOTA_MESSAGE, type: 'exceeded_current_quota_error' },
      `429 ${QUOTA_MESSAGE}`,
      new Headers(),
    );
    const result = convertOpenAIError(err);
    expect(result).toBeInstanceOf(APIProviderRateLimitError);
    expect(result).not.toBeInstanceOf(APIProviderQuotaExhaustedError);
  });

  it('classifies vendor quota signals through the convertError hook', () => {
    const err = new OpenAIAPIError(
      429,
      { message: QUOTA_MESSAGE, type: 'exceeded_current_quota_error' },
      `429 ${QUOTA_MESSAGE}`,
      new Headers(),
    );
    const result = convertOpenAIError(err, classifyKimiQuotaError);
    expect(result).toBeInstanceOf(APIProviderQuotaExhaustedError);
    expect(isRetryableGenerateError(result)).toBe(false);
  });

  it('keeps a transient structured 429 an APIProviderRateLimitError', () => {
    const err = new OpenAIAPIError(
      429,
      { message: 'Too many requests', type: 'rate_limit_reached_error' },
      'Too many requests',
      new Headers(),
    );
    const result = convertOpenAIError(err, classifyKimiQuotaError);
    expect(result).toBeInstanceOf(APIProviderRateLimitError);
    expect(result).not.toBeInstanceOf(APIProviderQuotaExhaustedError);
    expect(isRetryableGenerateError(result)).toBe(true);
  });
});
