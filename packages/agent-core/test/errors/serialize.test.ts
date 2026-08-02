import { APIProviderQuotaExhaustedError, APIProviderRateLimitError, APIQuotaExceededError, APIStatusError } from '@cloud-code/kosong';
import { describe, expect, it } from 'vitest';

import { toCloudCodeErrorPayload } from '#/errors/serialize';
import { RateLimitPauseError } from '#/loop/errors';

const NGINX_413_HTML =
  '413 <html>\r\n<head><title>413 Request Entity Too Large</title></head>\r\n' +
  '<body>\r\n<center><h1>413 Request Entity Too Large</h1></center>\r\n' +
  '<hr><center>nginx</center>\r\n</body>\r\n</html>\r\n';

describe('toCloudCodeErrorPayload — APIStatusError message sanitization', () => {
  it('extracts the <title> from an nginx 413 HTML body and strips CR', () => {
    const payload = toCloudCodeErrorPayload(new APIStatusError(413, NGINX_413_HTML));
    expect(payload.code).toBe('provider.api_error');
    expect(payload.message).toBe('413 Request Entity Too Large');
    expect(payload.details).toMatchObject({ statusCode: 413 });
  });

  it('extracts the <title> from other nginx HTML error pages', () => {
    const html =
      '<html>\r\n<head><title>502 Bad Gateway</title></head>\r\n' +
      '<body><center><h1>502 Bad Gateway</h1></center></body></html>';
    const payload = toCloudCodeErrorPayload(new APIStatusError(502, html));
    expect(payload.message).toBe('502 Bad Gateway');
  });

  it('leaves a plain-text message unchanged', () => {
    const payload = toCloudCodeErrorPayload(new APIStatusError(500, 'Internal Server Error'));
    expect(payload.message).toBe('Internal Server Error');
  });

  it('strips carriage returns from a non-HTML message', () => {
    const payload = toCloudCodeErrorPayload(new APIStatusError(500, 'line1\r\nline2\r'));
    expect(payload.message).toBe('line1\nline2');
  });

  it('falls back to the original message when the <title> is empty', () => {
    const html = '<html><head><title>   </title></head><body>x</body></html>';
    const payload = toCloudCodeErrorPayload(new APIStatusError(500, html));
    expect(payload.message).toContain('<html>');
  });

  it('does not affect 429 / 401 code mapping, only the message', () => {
    const html = '<html><head><title>429 Too Many Requests</title></head></html>';
    expect(toCloudCodeErrorPayload(new APIStatusError(429, html)).code).toBe('provider.rate_limit');
    expect(toCloudCodeErrorPayload(new APIStatusError(401, 'Unauthorized')).code).toBe(
      'provider.auth_error',
    );
  });
});

describe('toCloudCodeErrorPayload — rate-limit pause details (C1 P2)', () => {
  it('forwards resumeAfterMs/autoResume from a RateLimitPauseError onto the wire payload', () => {
    const error = new RateLimitPauseError({
      resumeAfterMs: 42_000,
      attempts: 2,
      totalWaitMs: 50_000,
      requestId: 'req-pause',
      traceId: 'trace-pause',
    });

    const payload = toCloudCodeErrorPayload(error);

    expect(payload.code).toBe('provider.rate_limit');
    expect(payload.name).toBe('RateLimitPauseError');
    expect(payload.details).toMatchObject({
      statusCode: 429,
      requestId: 'req-pause',
      resumeAfterMs: 42_000,
      autoResume: true,
    });
  });

  it('keeps a plain 429 payload free of pause details', () => {
    const payload = toCloudCodeErrorPayload(
      new APIProviderRateLimitError('rate limited', 'req-rl', 1000),
    );

    expect(payload.code).toBe('provider.rate_limit');
    expect(payload.details).toEqual({ statusCode: 429, requestId: 'req-rl' });
  });
});

describe('toCloudCodeErrorPayload — quota exhaustion', () => {
  it('maps APIQuotaExceededError to provider.quota_exhausted with window and reset details', () => {
    const payload = toCloudCodeErrorPayload(
      new APIQuotaExceededError('The usage limit has been reached', {
        requestId: 'req-quota',
        planType: 'pro',
        resetsAtMs: 1_900_000_000_000,
        quotaWindow: 'weekly',
      }),
    );

    expect(payload.code).toBe('provider.quota_exhausted');
    expect(payload.name).toBe('APIQuotaExceededError');
    expect(payload.retryable).toBe(false);
    expect(payload.message).toBe('The usage limit has been reached');
    expect(payload.details).toEqual({
      statusCode: 429,
      requestId: 'req-quota',
      planType: 'pro',
      resetsAtMs: 1_900_000_000_000,
      quotaWindow: 'weekly',
    });
  });

  it('keeps the transient 429 mapping to provider.rate_limit unchanged', () => {
    // Kimi parity: a non-quota 429 (e.g. Moonshot max RPM) is retryable and
    // stays on the rate-limit code — only the quota subclass diverges.
    const payload = toCloudCodeErrorPayload(
      new APIProviderRateLimitError('request reached user+model max RPM: 50'),
    );

    expect(payload.code).toBe('provider.rate_limit');
    expect(payload.retryable).toBe(true);
  });

  it('serializes the mid-stream quota variant with null window/reset details', () => {
    const payload = toCloudCodeErrorPayload(
      new APIQuotaExceededError('OpenAI Responses response.failed: usage_limit_reached: limit'),
    );

    expect(payload.code).toBe('provider.quota_exhausted');
    expect(payload.details).toMatchObject({
      statusCode: 429,
      planType: null,
      resetsAtMs: null,
      quotaWindow: null,
    });
  });
});

describe('toCloudCodeErrorPayload — quota-exhausted 429', () => {
  it('maps a quota-exhausted 429 to provider.api_error, not provider.rate_limit', () => {
    // provider.rate_limit is retryable and re-minted as a rate-limit error
    // across the wire boundary, which drives the swarm requeue/suspend loop;
    // quota exhaustion must carry the non-retryable generic code instead.
    const payload = toCloudCodeErrorPayload(
      new APIProviderQuotaExhaustedError(
        'Your account is suspended due to insufficient balance, please recharge your account',
        'req-quota',
      ),
    );
    expect(payload.code).toBe('provider.api_error');
    expect(payload.retryable).toBe(false);
    expect(payload.message).toContain('recharge');
    expect(payload.details).toMatchObject({ statusCode: 429, requestId: 'req-quota' });
  });
});
