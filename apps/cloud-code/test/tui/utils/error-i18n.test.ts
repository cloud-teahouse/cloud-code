// translateErrorPayload — backend error codes render localized at the TUI
// boundary; unknown codes fall back to the raw `[code] message` format.

import { beforeEach, describe, expect, it } from 'vitest';

import { setLocalePreference } from '#/tui/i18n';
import { formatErrorPayload } from '#/tui/utils/event-payload';
import { translateErrorPayload } from '#/tui/utils/error-i18n';

describe('translateErrorPayload', () => {
  beforeEach(() => {
    setLocalePreference('en');
  });

  it('translates provider.api_error, keeping the message verbatim with details and guidance', () => {
    const out = translateErrorPayload({
      code: 'provider.api_error',
      message: '400 Invalid value',
      details: { statusCode: 400, requestId: 'req-123' },
    });
    expect(out).toBe(
      '[provider.api_error] 400 Invalid value (HTTP 400) (request req-123) — Check the provider status or retry later.',
    );
  });

  it('omits missing details cleanly', () => {
    const out = translateErrorPayload({ code: 'provider.rate_limit', message: '429' });
    expect(out).toBe('[provider.rate_limit] 429 — Retry after a delay or reduce request frequency.');
  });

  it('translates context.overflow with the actionable guidance', () => {
    const out = translateErrorPayload({ code: 'context.overflow', message: 'too long' });
    expect(out).toContain('/compact');
  });

  it('renders Chinese for zh-CN', () => {
    setLocalePreference('zh-CN');
    const out = translateErrorPayload({ code: 'provider.rate_limit', message: '429' });
    expect(out).toBe('[provider.rate_limit] 429 — 请稍后重试或降低请求频率。');
  });

  it('returns undefined for unmapped codes so the raw format applies', () => {
    const raw = { code: 'session.title_empty', message: 'title empty' };
    expect(translateErrorPayload(raw)).toBeUndefined();
    expect(formatErrorPayload(raw)).toBe('[session.title_empty] title empty');
  });
});

describe('translateErrorPayload — provider.quota_exhausted', () => {
  const RESETS_AT_MS = 1_900_000_000_000;

  beforeEach(() => {
    setLocalePreference('en');
  });

  // Local-time `YYYY-MM-DD HH:MM`, matching the presenter's deterministic
  // formatting so the expectation holds in any test-environment timezone.
  function expectedTimestamp(ms: number): string {
    const date = new Date(ms);
    const pad = (value: number): string => String(value).padStart(2, '0');
    return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  it('renders the exhausted window and reset time with the /status and /login hints (en)', () => {
    const out = translateErrorPayload({
      code: 'provider.quota_exhausted',
      message: 'The usage limit has been reached',
      details: {
        statusCode: 429,
        requestId: 'req-quota',
        planType: 'pro',
        quotaWindow: 'weekly',
        resetsAtMs: RESETS_AT_MS,
      },
    });

    expect(out).toBe(
      `[provider.quota_exhausted] The usage limit has been reached (HTTP 429) (request req-quota) — ` +
        `ChatGPT plan exhausted (weekly window; resets at ${expectedTimestamp(RESETS_AT_MS)}). ` +
        'Check the ChatGPT tab in /status, or /login to switch accounts.',
    );
  });

  it('renders the localized window and reset time for zh-CN', () => {
    setLocalePreference('zh-CN');
    const out = translateErrorPayload({
      code: 'provider.quota_exhausted',
      message: 'The usage limit has been reached',
      details: { statusCode: 429, quotaWindow: '5h', resetsAtMs: RESETS_AT_MS },
    });

    expect(out).toBe(
      `[provider.quota_exhausted] The usage limit has been reached (HTTP 429) — ` +
        `ChatGPT 套餐已用尽（5h 窗口；将于 ${expectedTimestamp(RESETS_AT_MS)} 重置）。` +
        '可在 /status 的 ChatGPT 标签页查看，或用 /login 切换账号。',
    );
  });

  it('degrades gracefully when window and reset are unknown (mid-stream variant)', () => {
    const out = translateErrorPayload({
      code: 'provider.quota_exhausted',
      message: 'OpenAI Responses response.failed: usage_limit_reached: limit',
    });

    expect(out).toContain('(usage window; reset time unknown)');

    setLocalePreference('zh-CN');
    const outZh = translateErrorPayload({
      code: 'provider.quota_exhausted',
      message: 'OpenAI Responses response.failed: usage_limit_reached: limit',
    });
    expect(outZh).toContain('（用量窗口；重置时间未知）');
  });
});
