import { APIProviderRateLimitError, APIQuotaExceededError, isRetryableGenerateError } from '#/errors';
import { generate } from '#/generate';
import {
  OpenAIResponsesChatProvider,
  OpenAIResponsesStreamedMessage,
} from '#/providers/openai-responses';
import {
  exhaustedRateLimitWindow,
  parseCodexRateLimitHeaders,
  parseCodexUsageLimitError,
  parseCodexUsageLimitMessage,
  rateLimitWindowLabel,
} from '#/rate-limit';
import { APIError as OpenAIAPIError } from 'openai';
import { describe, expect, it, vi } from 'vitest';

const CAPTURED_AT = 1_900_000_000_000;

function codexHeaders(entries: Record<string, string>): Headers {
  return new Headers(entries);
}

describe('parseCodexRateLimitHeaders', () => {
  it('parses the full x-codex-* header family', () => {
    const snapshot = parseCodexRateLimitHeaders(
      codexHeaders({
        'x-codex-plan-type': 'plus',
        'x-codex-active-limit': 'premium',
        'x-codex-primary-used-percent': '26',
        'x-codex-primary-window-minutes': '300',
        'x-codex-primary-reset-at': '1900000000',
        'x-codex-secondary-used-percent': '74.5',
        'x-codex-secondary-window-minutes': '10080',
        'x-codex-secondary-reset-at': '1900500000',
        'x-codex-credits-has-credits': 'true',
        'x-codex-credits-unlimited': 'false',
        'x-codex-credits-balance': '25',
      }),
      CAPTURED_AT,
    );

    expect(snapshot).toEqual({
      planType: 'plus',
      activeLimit: 'premium',
      primary: { usedPercent: 26, windowMinutes: 300, resetsAt: 1900000000 },
      secondary: { usedPercent: 74.5, windowMinutes: 10080, resetsAt: 1900500000 },
      credits: { hasCredits: true, unlimited: false, balance: '25' },
      capturedAt: CAPTURED_AT,
    });
  });

  it('returns null when no x-codex-* headers are present (non-Codex backend)', () => {
    expect(
      parseCodexRateLimitHeaders(
        codexHeaders({ 'content-type': 'text/event-stream', 'openai-request-id': 'req_1' }),
      ),
    ).toBeNull();
  });

  it('keeps partial data when only some headers are present', () => {
    const snapshot = parseCodexRateLimitHeaders(
      codexHeaders({ 'x-codex-plan-type': 'plus' }),
      CAPTURED_AT,
    );

    expect(snapshot).toEqual({
      planType: 'plus',
      activeLimit: null,
      primary: null,
      secondary: null,
      credits: null,
      capturedAt: CAPTURED_AT,
    });
  });

  it('treats an all-zero secondary window as absent', () => {
    const snapshot = parseCodexRateLimitHeaders(
      codexHeaders({
        'x-codex-primary-used-percent': '26',
        'x-codex-primary-window-minutes': '10080',
        'x-codex-primary-reset-at': '1900000000',
        'x-codex-secondary-used-percent': '0',
        'x-codex-secondary-window-minutes': '0',
      }),
    );

    expect(snapshot?.primary).not.toBeNull();
    expect(snapshot?.secondary).toBeNull();
  });

  it('treats a zero-percent window with a real duration as present', () => {
    const snapshot = parseCodexRateLimitHeaders(
      codexHeaders({
        'x-codex-primary-used-percent': '0',
        'x-codex-primary-window-minutes': '300',
      }),
    );

    expect(snapshot?.primary).toEqual({ usedPercent: 0, windowMinutes: 300, resetsAt: null });
  });

  it('drops a window whose used-percent does not parse', () => {
    const snapshot = parseCodexRateLimitHeaders(
      codexHeaders({
        'x-codex-primary-used-percent': 'not-a-number',
        'x-codex-primary-window-minutes': '300',
        'x-codex-plan-type': 'plus',
      }),
    );

    expect(snapshot?.primary).toBeNull();
    expect(snapshot?.planType).toBe('plus');
  });

  it('requires both credits booleans to parse', () => {
    const snapshot = parseCodexRateLimitHeaders(
      codexHeaders({
        'x-codex-plan-type': 'plus',
        'x-codex-credits-has-credits': 'true',
        'x-codex-credits-unlimited': 'maybe',
        'x-codex-credits-balance': '25',
      }),
    );

    expect(snapshot?.credits).toBeNull();
  });

  it('normalizes an empty credits balance to null', () => {
    const snapshot = parseCodexRateLimitHeaders(
      codexHeaders({
        'x-codex-credits-has-credits': 'false',
        'x-codex-credits-unlimited': 'false',
        'x-codex-credits-balance': '   ',
      }),
    );

    expect(snapshot?.credits).toEqual({ hasCredits: false, unlimited: false, balance: null });
  });

  it('looks headers up case-insensitively', () => {
    const snapshot = parseCodexRateLimitHeaders(
      new Headers({ 'X-Codex-Plan-Type': 'plus', 'X-CODEX-PRIMARY-USED-PERCENT': '26' }),
    );

    expect(snapshot?.planType).toBe('plus');
    expect(snapshot?.primary?.usedPercent).toBe(26);
  });

  it('stamps capturedAt from the caller-provided clock', () => {
    const snapshot = parseCodexRateLimitHeaders(
      codexHeaders({ 'x-codex-plan-type': 'plus' }),
      123456789,
    );
    expect(snapshot?.capturedAt).toBe(123456789);
  });
});

function withResponseOk(data: unknown, headers?: Record<string, string>) {
  return {
    withResponse: () =>
      Promise.resolve({ data, response: new Response(null, { headers }) }),
  };
}

function makeCompletedResponse() {
  return {
    id: 'resp_test123',
    object: 'response',
    created_at: 1234567890,
    status: 'completed',
    model: 'gpt-4.1',
    output: [
      {
        type: 'message',
        id: 'msg_test',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Hello', annotations: [] }],
      },
    ],
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
  };
}

describe('OpenAIResponsesChatProvider rate limit headers', () => {
  it('exposes the parsed snapshot on the streamed message and generate result', async () => {
    const provider = new OpenAIResponsesChatProvider({ model: 'gpt-4.1', apiKey: 'test-key' });
    (provider as any)._stream = false;
    ((provider as any)._client.responses as Record<string, unknown>)['create'] = vi
      .fn()
      .mockReturnValue(
        withResponseOk(makeCompletedResponse(), {
          'x-codex-plan-type': 'plus',
          'x-codex-active-limit': 'premium',
          'x-codex-primary-used-percent': '26',
          'x-codex-primary-window-minutes': '10080',
          'x-codex-primary-reset-at': '1900000000',
          'x-codex-credits-has-credits': 'true',
          'x-codex-credits-unlimited': 'false',
        }),
      );

    const result = await generate(provider, 'sys', [], [
      { role: 'user', content: [{ type: 'text', text: 'hi' }], toolCalls: [] },
    ]);

    expect(result.rateLimit).toMatchObject({
      planType: 'plus',
      activeLimit: 'premium',
      primary: { usedPercent: 26, windowMinutes: 10080, resetsAt: 1900000000 },
      credits: { hasCredits: true, unlimited: false },
    });
    expect(typeof result.rateLimit?.capturedAt).toBe('number');
  });

  it('reports null rateLimit when the backend sends no x-codex-* headers', async () => {
    const provider = new OpenAIResponsesChatProvider({ model: 'gpt-4.1', apiKey: 'test-key' });
    (provider as any)._stream = false;
    ((provider as any)._client.responses as Record<string, unknown>)['create'] = vi
      .fn()
      .mockReturnValue(withResponseOk(makeCompletedResponse()));

    const stream = await provider.generate('sys', [], [
      { role: 'user', content: [{ type: 'text', text: 'hi' }], toolCalls: [] },
    ]);
    for await (const part of stream) void part;

    expect(stream.rateLimit).toBeNull();
  });

  it('defaults rateLimit to null when constructed without headers', () => {
    const stream = new OpenAIResponsesStreamedMessage(makeCompletedResponse(), false);
    expect(stream.rateLimit).toBeNull();
  });
});

describe('OpenAIResponsesChatProvider rate limit headers on error responses', () => {
  it('attaches the x-codex-* snapshot to the thrown error when withResponse() rejects with a 429', async () => {
    const provider = new OpenAIResponsesChatProvider({ model: 'gpt-5.1-codex', apiKey: 'test-key' });
    const apiError = new OpenAIAPIError(
      429,
      { error: { message: 'Rate limit reached', type: 'rate_limit_error' } },
      'Rate limit reached',
      new Headers({
        'x-codex-plan-type': 'plus',
        'x-codex-primary-used-percent': '100',
        'x-codex-primary-window-minutes': '300',
        'x-codex-primary-reset-at': '1900000000',
      }),
    );
    ((provider as any)._client.responses as Record<string, unknown>)['create'] = vi
      .fn()
      .mockReturnValue({ withResponse: () => Promise.reject(apiError) });

    const failure = await provider
      .generate('sys', [], [{ role: 'user', content: [{ type: 'text', text: 'hi' }], toolCalls: [] }])
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(APIProviderRateLimitError);
    expect((failure as APIProviderRateLimitError).statusCode).toBe(429);
    expect((failure as APIProviderRateLimitError).rateLimit).toMatchObject({
      planType: 'plus',
      primary: { usedPercent: 100, windowMinutes: 300, resetsAt: 1900000000 },
    });
  });

  it('throws without a snapshot when the 429 response carries no x-codex-* headers', async () => {
    const provider = new OpenAIResponsesChatProvider({ model: 'gpt-4.1', apiKey: 'test-key' });
    const apiError = new OpenAIAPIError(429, undefined, 'Too many requests', new Headers());
    ((provider as any)._client.responses as Record<string, unknown>)['create'] = vi
      .fn()
      .mockReturnValue({ withResponse: () => Promise.reject(apiError) });

    const failure = await provider
      .generate('sys', [], [{ role: 'user', content: [{ type: 'text', text: 'hi' }], toolCalls: [] }])
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(APIProviderRateLimitError);
    expect((failure as APIProviderRateLimitError).rateLimit).toBeNull();
  });
});

describe('parseCodexUsageLimitError', () => {
  it('parses the Codex quota body: type, plan_type, resets_at', () => {
    // The exact wire shape codex classifies on (codex-rs
    // codex-api/src/api_bridge.rs): 429 with a usage_limit_reached body.
    const parsed = parseCodexUsageLimitError({
      error: {
        type: 'usage_limit_reached',
        message: 'The usage limit has been reached',
        plan_type: 'pro',
        resets_at: 1_738_888_888,
      },
    });

    expect(parsed).toEqual({ planType: 'pro', resetsAtMs: 1_738_888_888_000 });
  });

  it('tolerates missing plan_type / resets_at', () => {
    expect(parseCodexUsageLimitError({ error: { type: 'usage_limit_reached' } })).toEqual({
      planType: null,
      resetsAtMs: null,
    });
  });

  it('parses the SDK-unwrapped inner error object (the production shape)', () => {
    // The OpenAI SDK v6 unwraps the body in `APIError.generate`:
    // `error.error` is the inner error object, not `{error: {...}}`. This is
    // the shape convertOpenAIError actually receives at runtime.
    const parsed = parseCodexUsageLimitError({
      type: 'usage_limit_reached',
      message: 'The usage limit has been reached',
      plan_type: 'pro',
      resets_at: 1_738_888_888,
    });

    expect(parsed).toEqual({ planType: 'pro', resetsAtMs: 1_738_888_888_000 });
  });

  it('parses the unwrapped inner object with missing plan_type / resets_at', () => {
    expect(parseCodexUsageLimitError({ type: 'usage_limit_reached' })).toEqual({
      planType: null,
      resetsAtMs: null,
    });
  });

  it.each([
    ['transient rate-limit body', { error: { type: 'rate_limit_error', message: 'slow down' } }],
    ['unwrapped transient rate-limit body', { type: 'rate_limit_error', message: 'slow down' }],
    ['usage_not_included body', { error: { type: 'usage_not_included' } }],
    ['unwrapped usage_not_included body', { type: 'usage_not_included' }],
    ['undefined body', undefined],
    ['non-object body', 'usage_limit_reached'],
    ['body without error object', { message: 'usage_limit_reached' }],
    ['error as a non-object', { error: 'usage_limit_reached' }],
  ])('returns null for %s', (_label, body) => {
    expect(parseCodexUsageLimitError(body)).toBeNull();
  });
});

describe('parseCodexUsageLimitMessage', () => {
  it('matches the machine token embedded in an SDK-rendered 429 message', () => {
    // A 429 whose body never parsed as JSON (plain-text body, or an edge
    // proxy relaying the error as text) surfaces the token in the message the
    // SDK renders (`"<status> <body text>"`).
    expect(
      parseCodexUsageLimitMessage('429 {"error":{"type":"usage_limit_reached"}}'),
    ).toEqual({ planType: null, resetsAtMs: null });
    expect(parseCodexUsageLimitMessage('429 usage_limit_reached')).not.toBeNull();
  });

  it.each([
    '429 Too Many Requests',
    'request reached user+model max RPM: 50',
    'usage limit almost reached',
    '',
  ])('returns null for %s', (message) => {
    expect(parseCodexUsageLimitMessage(message)).toBeNull();
  });
});

describe('exhaustedRateLimitWindow', () => {
  const snapshot = {
    planType: 'plus',
    activeLimit: null,
    primary: { usedPercent: 100, windowMinutes: 300, resetsAt: 1_900_000_000 },
    secondary: { usedPercent: 40, windowMinutes: 10080, resetsAt: 1_900_500_000 },
    credits: null,
    capturedAt: CAPTURED_AT,
  } as const;

  it('identifies the window at 100% consumption', () => {
    expect(exhaustedRateLimitWindow(snapshot)).toEqual({
      name: 'primary',
      windowMinutes: 300,
      resetsAt: 1_900_000_000,
    });
  });

  it('identifies the secondary window when only it is exhausted', () => {
    expect(
      exhaustedRateLimitWindow({
        ...snapshot,
        primary: { usedPercent: 99.5, windowMinutes: 300, resetsAt: 1_900_000_000 },
        secondary: { usedPercent: 100, windowMinutes: 10080, resetsAt: 1_900_500_000 },
      }),
    ).toEqual({ name: 'secondary', windowMinutes: 10080, resetsAt: 1_900_500_000 });
  });

  it('returns null when no window is exhausted or no snapshot exists', () => {
    expect(
      exhaustedRateLimitWindow({
        ...snapshot,
        primary: { usedPercent: 99.9, windowMinutes: 300, resetsAt: 1_900_000_000 },
      }),
    ).toBeNull();
    expect(exhaustedRateLimitWindow(null)).toBeNull();
    expect(exhaustedRateLimitWindow(undefined)).toBeNull();
  });
});

describe('rateLimitWindowLabel', () => {
  it.each([
    [300, '5h'],
    [1440, 'daily'],
    [10080, 'weekly'],
    [43200, 'monthly'],
    [525600, 'annual'],
  ])('labels %i minutes as %s', (minutes, label) => {
    expect(rateLimitWindowLabel(minutes)).toBe(label);
  });

  it('applies the ±5% tolerance codex uses for nominal window minutes', () => {
    expect(rateLimitWindowLabel(295)).toBe('5h');
    expect(rateLimitWindowLabel(10150)).toBe('weekly');
  });

  it('returns null for unknown lengths and absent minutes', () => {
    expect(rateLimitWindowLabel(60)).toBeNull();
    expect(rateLimitWindowLabel(null)).toBeNull();
  });
});

describe('OpenAIResponsesChatProvider quota-exhausted error responses', () => {
  it('classifies a 429 usage_limit_reached body as a terminal APIQuotaExceededError', async () => {
    // The real exhausted-plan response: 429 + usage_limit_reached body +
    // x-codex-* headers showing the primary (5h) window at 100%.
    const provider = new OpenAIResponsesChatProvider({ model: 'gpt-5.1-codex', apiKey: 'test-key' });
    const apiError = new OpenAIAPIError(
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
      new Headers({
        'x-codex-plan-type': 'pro',
        'x-codex-primary-used-percent': '100',
        'x-codex-primary-window-minutes': '300',
        'x-codex-primary-reset-at': '1900000000',
        'x-codex-secondary-used-percent': '40',
        'x-codex-secondary-window-minutes': '10080',
      }),
    );
    ((provider as any)._client.responses as Record<string, unknown>)['create'] = vi
      .fn()
      .mockReturnValue({ withResponse: () => Promise.reject(apiError) });

    const failure = await provider
      .generate('sys', [], [{ role: 'user', content: [{ type: 'text', text: 'hi' }], toolCalls: [] }])
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(APIQuotaExceededError);
    expect(failure).toBeInstanceOf(APIProviderRateLimitError);
    const quota = failure as APIQuotaExceededError;
    expect(quota.statusCode).toBe(429);
    expect(quota.planType).toBe('pro');
    expect(quota.resetsAtMs).toBe(1_900_000_000_000);
    expect(quota.quotaWindow).toBe('5h');
    expect(quota.rateLimit).toMatchObject({
      planType: 'pro',
      primary: { usedPercent: 100, windowMinutes: 300, resetsAt: 1900000000 },
    });
    // Terminal: the retry loop must not burn attempts on an exhausted plan.
    expect(isRetryableGenerateError(quota)).toBe(false);
  });

  it('falls back to the exhausted window reset when the body carries no resets_at', async () => {
    const provider = new OpenAIResponsesChatProvider({ model: 'gpt-5.1-codex', apiKey: 'test-key' });
    const apiError = new OpenAIAPIError(
      429,
      { error: { type: 'usage_limit_reached', message: 'limit reached' } },
      'limit reached',
      new Headers({
        'x-codex-secondary-used-percent': '100',
        'x-codex-secondary-window-minutes': '10080',
        'x-codex-secondary-reset-at': '1900500000',
      }),
    );
    ((provider as any)._client.responses as Record<string, unknown>)['create'] = vi
      .fn()
      .mockReturnValue({ withResponse: () => Promise.reject(apiError) });

    const failure = await provider
      .generate('sys', [], [{ role: 'user', content: [{ type: 'text', text: 'hi' }], toolCalls: [] }])
      .catch((error: unknown) => error);

    const quota = failure as APIQuotaExceededError;
    expect(quota).toBeInstanceOf(APIQuotaExceededError);
    expect(quota.resetsAtMs).toBe(1_900_500_000_000);
    expect(quota.quotaWindow).toBe('weekly');
    expect(quota.planType).toBeNull();
  });

  it('keeps a transient 429 (non-quota body) retryable as APIProviderRateLimitError', async () => {
    // Kimi parity guard: a Moonshot-style RPM rejection carries no
    // usage_limit_reached body and must stay on the transient retry path.
    const provider = new OpenAIResponsesChatProvider({ model: 'gpt-4.1', apiKey: 'test-key' });
    const apiError = new OpenAIAPIError(
      429,
      { error: { message: 'request reached user+model max RPM: 50', type: 'rate_limit_error' } },
      'request reached user+model max RPM: 50',
      new Headers(),
    );
    ((provider as any)._client.responses as Record<string, unknown>)['create'] = vi
      .fn()
      .mockReturnValue({ withResponse: () => Promise.reject(apiError) });

    const failure = await provider
      .generate('sys', [], [{ role: 'user', content: [{ type: 'text', text: 'hi' }], toolCalls: [] }])
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(APIProviderRateLimitError);
    expect(failure).not.toBeInstanceOf(APIQuotaExceededError);
    expect(isRetryableGenerateError(failure)).toBe(true);
  });
});
