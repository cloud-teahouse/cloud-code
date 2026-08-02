/**
 * chatgpt-codex-reset-credits tests — payload parsing (field-level
 * degradation, unknown consume codes) and the fetch surface (method, URL,
 * headers, JSON body, idempotency-key passthrough, error/timeout mapping).
 * HTTP is mocked via the injected fetchImpl.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  CHATGPT_CODEX_RESET_CREDITS_URL,
  consumeCodexResetCredit,
  fetchCodexResetCredits,
  parseCodexResetCreditsPayload,
  parseConsumeCodexResetCreditPayload,
} from '../src/chatgpt-codex-reset-credits';

/** The real wham list-endpoint shape (extra summary fields pass through). */
const LIST_PAYLOAD = {
  credits: [
    {
      id: 'credit-1',
      reset_type: 'codex_rate_limits',
      status: 'available',
      granted_at: '2027-01-01T00:00:00Z',
      expires_at: '2027-01-02T03:04:05Z',
      title: 'Full reset',
      description: 'Reset your current usage limits.',
    },
    {
      id: 'credit-2',
      reset_type: 'codex_rate_limits',
      status: 'redeemed',
      granted_at: '2027-01-01T00:00:00Z',
      expires_at: null,
      title: null,
      description: null,
    },
  ],
  available_count: 1,
  total_earned_count: 4,
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('parseCodexResetCreditsPayload', () => {
  it('parses credits with RFC3339 expiry converted to epoch ms', () => {
    expect(parseCodexResetCreditsPayload(LIST_PAYLOAD)).toEqual({
      availableCount: 1,
      credits: [
        {
          id: 'credit-1',
          resetType: 'codex_rate_limits',
          status: 'available',
          title: 'Full reset',
          description: 'Reset your current usage limits.',
          expiresAt: Date.parse('2027-01-02T03:04:05Z'),
        },
        {
          id: 'credit-2',
          resetType: 'codex_rate_limits',
          status: 'redeemed',
          title: null,
          description: null,
          expiresAt: null,
        },
      ],
    });
  });

  it('degrades to an empty list on a non-record payload', () => {
    expect(parseCodexResetCreditsPayload('garbage')).toEqual({
      availableCount: 0,
      credits: [],
    });
  });

  it('drops malformed credit rows and an invalid count instead of failing', () => {
    const parsed = parseCodexResetCreditsPayload({
      available_count: -2,
      credits: [
        { id: 'ok', status: 'available', expires_at: 'not-a-date' },
        { status: 'available' },
        'junk',
        null,
      ],
    });
    expect(parsed.availableCount).toBe(0);
    expect(parsed.credits).toEqual([
      {
        id: 'ok',
        resetType: '',
        status: 'available',
        title: null,
        description: null,
        expiresAt: null,
      },
    ]);
  });
});

describe('parseConsumeCodexResetCreditPayload', () => {
  it('parses every known outcome code', () => {
    for (const code of ['reset', 'nothing_to_reset', 'no_credit', 'already_redeemed'] as const) {
      expect(parseConsumeCodexResetCreditPayload({ code, windows_reset: 2 })).toEqual({
        code,
        rawCode: null,
        windowsReset: 2,
      });
    }
  });

  it('surfaces an unrecognized code as unknown without throwing', () => {
    expect(parseConsumeCodexResetCreditPayload({ code: 'rate_limited' })).toEqual({
      code: 'unknown',
      rawCode: 'rate_limited',
      windowsReset: 0,
    });
    expect(parseConsumeCodexResetCreditPayload({})).toEqual({
      code: 'unknown',
      rawCode: null,
      windowsReset: 0,
    });
  });
});

describe('fetchCodexResetCredits', () => {
  it('GETs the wham reset-credits URL with bearer, account id, and product UA', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(200, LIST_PAYLOAD));
    const list = await fetchCodexResetCredits({
      accessToken: 'access-1',
      accountId: 'acct-1',
      userAgent: 'cloud-code-cli/1.2.3',
      fetchImpl,
    });

    expect(CHATGPT_CODEX_RESET_CREDITS_URL).toBe(
      'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits',
    );
    expect(list.availableCount).toBe(1);
    expect(list.credits).toHaveLength(2);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(CHATGPT_CODEX_RESET_CREDITS_URL);
    expect(init?.method).toBe('GET');
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer access-1');
    expect(headers['ChatGPT-Account-ID']).toBe('acct-1');
    expect(headers['User-Agent']).toBe('cloud-code-cli/1.2.3');
    expect(headers['Accept']).toBe('application/json');
  });

  it('honours the URL override and omits absent optional headers', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(200, LIST_PAYLOAD));
    await fetchCodexResetCredits({
      accessToken: 'access-1',
      url: 'http://127.0.0.1:9/wham/rate-limit-reset-credits',
      fetchImpl,
    });

    expect(fetchImpl.mock.calls[0]![0]).toBe(
      'http://127.0.0.1:9/wham/rate-limit-reset-credits',
    );
    const headers = (fetchImpl.mock.calls[0]![1]?.headers ?? {}) as Record<string, string>;
    expect(headers['ChatGPT-Account-ID']).toBeUndefined();
    expect(headers['User-Agent']).toBeUndefined();
  });

  it('throws the backend error message on non-2xx', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonResponse(403, { error: 'cloudflare_challenge' }),
    );
    await expect(fetchCodexResetCredits({ accessToken: 'access-1', fetchImpl })).rejects.toThrow(
      'cloudflare_challenge',
    );
  });

  it('maps the timeout abort to a clean timeout error', async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          });
        }),
    );
    await expect(
      fetchCodexResetCredits({ accessToken: 'access-1', fetchImpl, timeoutMs: 5 }),
    ).rejects.toThrow('request timed out');
  });
});

describe('consumeCodexResetCredit', () => {
  it('POSTs the idempotency key as JSON to the consume endpoint', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonResponse(200, { code: 'reset', windows_reset: 2 }),
    );
    const result = await consumeCodexResetCredit({
      accessToken: 'access-1',
      accountId: 'acct-1',
      userAgent: 'cloud-code-cli/1.2.3',
      redeemRequestId: 'req-uuid-1',
      fetchImpl,
    });

    expect(result).toEqual({ code: 'reset', rawCode: null, windowsReset: 2 });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(`${CHATGPT_CODEX_RESET_CREDITS_URL}/consume`);
    expect(init?.method).toBe('POST');
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['Authorization']).toBe('Bearer access-1');
    expect(headers['ChatGPT-Account-ID']).toBe('acct-1');
    expect(JSON.parse(init?.body as string)).toEqual({ redeem_request_id: 'req-uuid-1' });
  });

  it('includes credit_id only when a specific credit is consumed', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(200, { code: 'reset' }));
    await consumeCodexResetCredit({
      accessToken: 'access-1',
      redeemRequestId: 'req-uuid-2',
      creditId: 'credit-1',
      fetchImpl,
    });
    expect(JSON.parse(fetchImpl.mock.calls[0]![1]?.body as string)).toEqual({
      redeem_request_id: 'req-uuid-2',
      credit_id: 'credit-1',
    });

    await consumeCodexResetCredit({
      accessToken: 'access-1',
      redeemRequestId: 'req-uuid-3',
      fetchImpl,
    });
    expect(JSON.parse(fetchImpl.mock.calls[1]![1]?.body as string)).toEqual({
      redeem_request_id: 'req-uuid-3',
    });
  });

  it('passes the exact redeem_request_id through (uuid idempotency)', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonResponse(200, { code: 'already_redeemed', windows_reset: 0 }),
    );
    const uuid = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
    const result = await consumeCodexResetCredit({
      accessToken: 'access-1',
      redeemRequestId: uuid,
      fetchImpl,
    });
    expect(result.code).toBe('already_redeemed');
    expect(JSON.parse(fetchImpl.mock.calls[0]![1]?.body as string)['redeem_request_id']).toBe(uuid);
  });

  it('throws the backend error message on non-2xx', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonResponse(429, { error: { message: 'slow down' } }),
    );
    await expect(
      consumeCodexResetCredit({ accessToken: 'access-1', redeemRequestId: 'r-1', fetchImpl }),
    ).rejects.toThrow('slow down');
  });

  it('maps the timeout abort to a clean timeout error', async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          });
        }),
    );
    await expect(
      consumeCodexResetCredit({
        accessToken: 'access-1',
        redeemRequestId: 'r-1',
        fetchImpl,
        timeoutMs: 5,
      }),
    ).rejects.toThrow('request timed out');
  });
});
