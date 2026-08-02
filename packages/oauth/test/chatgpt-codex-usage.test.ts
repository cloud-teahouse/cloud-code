/**
 * chatgpt-codex-usage tests — payload parsing (field-level degradation) and
 * the fetch surface (headers, default URL, error/timeout mapping). HTTP is
 * mocked via the injected fetchImpl.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  CHATGPT_CODEX_USAGE_URL,
  fetchCodexPlanUsage,
  parseCodexPlanUsagePayload,
} from '../src/chatgpt-codex-usage';

const NOW = 1_800_000_000_000;

/**
 * The real `GET /wham/usage` 200 payload captured from a ChatGPT OAuth
 * (Plus) account — unknown sibling fields must pass through the loose
 * parser untouched.
 */
const FULL_PAYLOAD = {
  user_id: 'user-abc123',
  account_id: 'acct-def456',
  email: 'user@example.com',
  plan_type: 'plus',
  rate_limit: {
    allowed: true,
    limit_reached: false,
    primary_window: {
      used_percent: 42,
      limit_window_seconds: 18_000,
      reset_after_seconds: 120,
      reset_at: 1_735_689_720,
    },
    secondary_window: {
      used_percent: 5.5,
      limit_window_seconds: 604_800,
      reset_after_seconds: 43_200,
      reset_at: 1_735_759_200,
    },
  },
  code_review_rate_limit: null,
  additional_rate_limits: [],
  credits: {
    has_credits: true,
    unlimited: false,
    overage_limit_reached: false,
    balance: 25,
    approx_local_messages: 500,
    approx_cloud_messages: 250,
  },
  spend_control: { reached: false, individual_limit: null },
  rate_limit_reached_type: { type: null, details: null },
  rate_limit_upsell: {
    banner_type: null,
    title: null,
    description: null,
    ctas: [],
    reset_at: null,
  },
  promo: null,
  rate_limit_reset_credits: { available_count: 3, applicable_available_count: 2 },
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('parseCodexPlanUsagePayload', () => {
  it('parses the real wham payload (windows in minutes, numeric balance)', () => {
    expect(parseCodexPlanUsagePayload(FULL_PAYLOAD, NOW)).toEqual({
      planType: 'plus',
      primary: { usedPercent: 42, windowMinutes: 300, resetsAt: 1_735_689_720 },
      secondary: { usedPercent: 5.5, windowMinutes: 10_080, resetsAt: 1_735_759_200 },
      credits: { hasCredits: true, unlimited: false, balance: '25' },
      // applicable_available_count wins over the raw available_count.
      resetCreditsAvailable: 2,
      capturedAt: NOW,
    });
  });

  it('falls back to available_count when no applicable count is present', () => {
    const parsed = parseCodexPlanUsagePayload(
      { rate_limit_reset_credits: { available_count: 3 } },
      NOW,
    );
    expect(parsed.resetCreditsAvailable).toBe(3);
  });

  it('derives the reset time from reset_after_seconds when reset_at is absent', () => {
    const parsed = parseCodexPlanUsagePayload(
      {
        rate_limit: {
          primary_window: { used_percent: 42, limit_window_seconds: 18_000, reset_after_seconds: 120 },
        },
      },
      NOW,
    );
    expect(parsed.primary).toEqual({
      usedPercent: 42,
      windowMinutes: 300,
      resetsAt: Math.floor(NOW / 1000) + 120,
    });
  });

  it('accepts a null secondary window', () => {
    const parsed = parseCodexPlanUsagePayload(
      { plan_type: 'plus', rate_limit: { primary_window: null, secondary_window: null } },
      NOW,
    );
    expect(parsed.primary).toBeNull();
    expect(parsed.secondary).toBeNull();
    expect(parsed.planType).toBe('plus');
  });

  it('degrades field-by-field instead of zeroing the quota state', () => {
    const parsed = parseCodexPlanUsagePayload(
      {
        plan_type: 42,
        rate_limit: {
          primary_window: { limit_window_seconds: 18_000 },
          secondary_window: 'weekly',
        },
        credits: { has_credits: true },
        rate_limit_reset_credits: { available_count: -1, applicable_available_count: 'many' },
      },
      NOW,
    );
    expect(parsed).toEqual({
      planType: null,
      primary: null,
      secondary: null,
      credits: null,
      resetCreditsAvailable: null,
      capturedAt: NOW,
    });
  });

  it('keeps a window whose only field is missing reset/window metadata', () => {
    const parsed = parseCodexPlanUsagePayload(
      { rate_limit: { primary_window: { used_percent: 12 } } },
      NOW,
    );
    expect(parsed.primary).toEqual({ usedPercent: 12, windowMinutes: null, resetsAt: null });
  });

  it('treats a non-record payload as empty', () => {
    expect(parseCodexPlanUsagePayload('garbage', NOW)).toEqual({
      planType: null,
      primary: null,
      secondary: null,
      credits: null,
      resetCreditsAvailable: null,
      capturedAt: NOW,
    });
  });
});

describe('fetchCodexPlanUsage', () => {
  it('GETs the wham usage URL with bearer, account id, and product UA', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(200, FULL_PAYLOAD));
    const usage = await fetchCodexPlanUsage({
      accessToken: 'access-1',
      accountId: 'acct-1',
      userAgent: 'cloud-code-cli/1.2.3',
      fetchImpl,
      now: () => NOW,
    });

    expect(CHATGPT_CODEX_USAGE_URL).toBe('https://chatgpt.com/backend-api/wham/usage');
    expect(usage.resetCreditsAvailable).toBe(2);
    expect(usage.capturedAt).toBe(NOW);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(CHATGPT_CODEX_USAGE_URL);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer access-1');
    expect(headers['ChatGPT-Account-ID']).toBe('acct-1');
    expect(headers['User-Agent']).toBe('cloud-code-cli/1.2.3');
    expect(headers['Accept']).toBe('application/json');
  });

  it('omits the optional headers when account id / UA are absent', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(200, FULL_PAYLOAD));
    await fetchCodexPlanUsage({ accessToken: 'access-1', fetchImpl });

    const headers = (fetchImpl.mock.calls[0]![1]?.headers ?? {}) as Record<string, string>;
    expect(headers['ChatGPT-Account-ID']).toBeUndefined();
    expect(headers['User-Agent']).toBeUndefined();
  });

  it('honours the URL override', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(200, FULL_PAYLOAD));
    await fetchCodexPlanUsage({
      accessToken: 'access-1',
      url: 'http://127.0.0.1:9/wham/usage',
      fetchImpl,
    });
    expect(fetchImpl.mock.calls[0]![0]).toBe('http://127.0.0.1:9/wham/usage');
  });

  it('throws the backend error message on non-2xx', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonResponse(403, { error: 'cloudflare_challenge' }),
    );
    await expect(fetchCodexPlanUsage({ accessToken: 'access-1', fetchImpl })).rejects.toThrow(
      'cloudflare_challenge',
    );
  });

  it('falls back to the HTTP status when the error body is not JSON', async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () => new Response('<html>challenge</html>', { status: 503 }),
    );
    await expect(fetchCodexPlanUsage({ accessToken: 'access-1', fetchImpl })).rejects.toThrow(
      'HTTP 503',
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
      fetchCodexPlanUsage({ accessToken: 'access-1', fetchImpl, timeoutMs: 5 }),
    ).rejects.toThrow('request timed out');
  });
});
