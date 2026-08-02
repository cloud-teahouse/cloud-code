/**
 * Production-path regression for ChatGPT Codex quota exhaustion.
 *
 * The managed ChatGPT Codex provider (`managed:chatgpt-codex`, wire type
 * `openai_responses`) is served by kosong's `OpenAIResponsesChatProvider`
 * built through `createProvider` — the same factory the agent session uses.
 * These tests drive the exact runtime stack with no mocked error classes:
 *
 *   loopback HTTP server (real 429 wire responses)
 *     -> the real OpenAI SDK client (its `APIError.generate` UNWRAPS the
 *        response body: `error.error` is the inner error object)
 *     -> convertOpenAIError (kosong provider error conversion)
 *     -> kosong generate() -> KosongLLM -> chatWithRetry
 *     -> toCloudCodeErrorPayload (wire serialization)
 *
 * An exhausted plan must fail on the FIRST attempt and surface as
 * `provider.quota_exhausted` with the window/reset details — never burn the
 * retry budget and land on the generic transient rate-limit error.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  APIProviderRateLimitError,
  APIQuotaExceededError,
  createProvider,
  isRetryableGenerateError,
} from '@cloud-code/kosong';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { KosongLLM } from '../../src/agent/turn/kosong-llm';
import { toCloudCodeErrorPayload } from '../../src/errors';
import { chatWithRetry } from '../../src/loop/retry';

const QUOTA_WIRE_BODY = {
  error: {
    type: 'usage_limit_reached',
    message: 'The usage limit has been reached',
    plan_type: 'pro',
    resets_at: 1_900_000_000,
  },
};

const QUOTA_HEADERS = {
  'content-type': 'application/json',
  'x-codex-plan-type': 'pro',
  'x-codex-primary-used-percent': '100',
  'x-codex-primary-window-minutes': '300',
  'x-codex-primary-reset-at': '1900000000',
  // Keep the SDK's own internal retry out of the measurement: each llm.chat
  // attempt is exactly one HTTP request, so the hit counter tracks the
  // chatWithRetry attempt count.
  'x-should-retry': 'false',
};

let server: Server;
let baseUrl: string;
let hits: number;
let responder: () => { status: number; headers: Record<string, string>; body: unknown };

beforeAll(async () => {
  server = createServer((req, res) => {
    hits += 1;
    // Drain the request body so the SDK's connection completes cleanly.
    req.resume();
    req.on('end', () => {
      const response = responder();
      res.writeHead(response.status, response.headers);
      res.end(typeof response.body === 'string' ? response.body : JSON.stringify(response.body));
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${String(port)}/v1`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
});

function codexLlm(): KosongLLM {
  const provider = createProvider({
    type: 'openai_responses',
    model: 'gpt-5.1-codex',
    apiKey: 'test-key',
    baseUrl,
  });
  return new KosongLLM({ provider, systemPrompt: 'sys' });
}

describe('chatWithRetry: codex quota exhaustion over the real SDK stack', () => {
  it('stops on the first attempt and serializes to provider.quota_exhausted', async () => {
    hits = 0;
    responder = () => ({ status: 429, headers: QUOTA_HEADERS, body: QUOTA_WIRE_BODY });
    const events: Array<{ type: string }> = [];

    const error = await chatWithRetry({
      llm: codexLlm(),
      params: {
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }], toolCalls: [] }],
        tools: [],
        signal: new AbortController().signal,
      },
      dispatchEvent: async (event) => {
        events.push(event as { type: string });
      },
      turnId: 't',
      currentStep: 1,
      stepUuid: 'u',
    }).then(
      () => {
        throw new Error('expected chatWithRetry to reject');
      },
      (error: unknown) => error,
    );

    // The pre-fix behavior burned the whole 10-attempt budget here.
    expect(hits).toBe(1);
    expect(events.filter((event) => event.type === 'step.retrying')).toHaveLength(0);

    expect(error).toBeInstanceOf(APIQuotaExceededError);
    const quota = error as APIQuotaExceededError;
    expect(quota.statusCode).toBe(429);
    expect(quota.planType).toBe('pro');
    expect(quota.resetsAtMs).toBe(1_900_000_000_000);
    expect(quota.quotaWindow).toBe('5h');
    expect(quota.message).toContain('The usage limit has been reached');
    expect(isRetryableGenerateError(error)).toBe(false);

    const payload = toCloudCodeErrorPayload(error);
    expect(payload.code).toBe('provider.quota_exhausted');
    expect(payload.retryable).toBe(false);
    expect(payload.message).toContain('The usage limit has been reached');
    expect(payload.details).toMatchObject({
      statusCode: 429,
      planType: 'pro',
      resetsAtMs: 1_900_000_000_000,
      quotaWindow: '5h',
    });
  });

  it('still retries a transient 429 from the same endpoint', async () => {
    hits = 0;
    responder = () => ({
      status: 429,
      headers: { 'content-type': 'application/json', 'x-should-retry': 'false' },
      body: { error: { type: 'rate_limit_error', message: 'slow down' } },
    });

    const error = await chatWithRetry({
      llm: codexLlm(),
      params: {
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }], toolCalls: [] }],
        tools: [],
        signal: new AbortController().signal,
      },
      dispatchEvent: async () => {},
      turnId: 't',
      currentStep: 1,
      stepUuid: 'u',
      maxAttempts: 3,
      // Clip the in-loop backoff so the transient-retry assertion stays fast.
      foregroundGate: { autoResume: false, maxDelayMs: 1 },
    }).then(
      () => {
        throw new Error('expected chatWithRetry to reject');
      },
      (error: unknown) => error,
    );

    expect(hits).toBe(3);
    expect(error).toBeInstanceOf(APIProviderRateLimitError);
    expect(error).not.toBeInstanceOf(APIQuotaExceededError);
    expect(toCloudCodeErrorPayload(error).code).toBe('provider.rate_limit');
  });
});
