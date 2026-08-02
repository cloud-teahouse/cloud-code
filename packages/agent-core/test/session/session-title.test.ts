/**
 * session-title — AI-generated session titles via the `agent.generate`
 * side channel, with the truncated-first-prompt title as the fallback:
 *   - the JSON contract is parsed and sanitized (quotes, whitespace, length)
 *   - plain-text output is accepted as a first-line title
 *   - any failure (no provider, throw, contract violation) returns null so
 *     the caller keeps the fallback title
 */

import { describe, expect, it, vi } from 'vitest';

import type { Agent } from '../../src/agent';
import {
  generateSessionTitle,
  sanitizeSessionTitle,
  SESSION_TITLE_TIMEOUT_MS,
} from '../../src/session/session-title';

function fakeAgent(options: {
  readonly response?: unknown;
  readonly error?: unknown;
  readonly hasProvider?: boolean;
}): { agent: Agent; generate: ReturnType<typeof vi.fn> } {
  const generate =
    options.error !== undefined
      ? vi.fn(async () => {
          throw options.error;
        })
      : vi.fn(async () => options.response);
  const agent = {
    config: {
      hasProvider: options.hasProvider ?? true,
      provider: { name: 'test-provider', modelName: 'test-model' },
    },
    generate,
    usage: { record: vi.fn() },
  } as unknown as Agent;
  return { agent, generate };
}

function textResponse(text: string, usage: unknown = null) {
  return {
    message: { role: 'assistant', content: [{ type: 'text', text }], toolCalls: [] },
    usage,
    finishReason: 'stop',
  };
}

describe('generateSessionTitle', () => {
  it('returns the parsed title from a JSON response', async () => {
    const { agent, generate } = fakeAgent({
      response: textResponse('{"title": "Fix login button on mobile"}'),
    });

    const title = await generateSessionTitle(agent, 'the login button does not respond on mobile');

    expect(title).toBe('Fix login button on mobile');
    expect(generate).toHaveBeenCalledTimes(1);
    const [provider, systemPrompt, tools, messages, , generateOptions] = generate.mock.calls[0]!;
    expect((provider as { modelName: string }).modelName).toBe('test-model');
    expect(systemPrompt).toContain('sentence-case title (3-7 words)');
    expect(systemPrompt).toContain('Good examples:');
    expect(systemPrompt).toContain('Bad (too vague):');
    expect(tools).toEqual([]);
    expect(messages).toHaveLength(1);
    expect(generateOptions).toMatchObject({ requestLogFields: { kind: 'title' } });
  });

  it('accepts plain-text output as a first-line title', async () => {
    const { agent } = fakeAgent({ response: textResponse('Add OAuth authentication\n(extra)') });

    expect(await generateSessionTitle(agent, 'add oauth')).toBe('Add OAuth authentication');
  });

  it('records usage when the response carries it', async () => {
    const usage = { inputOther: 10, output: 5, inputCacheRead: 0, inputCacheCreation: 0 };
    const { agent } = fakeAgent({ response: textResponse('{"title": "T"}', usage) });

    await generateSessionTitle(agent, 'something');

    expect(agent.usage.record).toHaveBeenCalledWith('test-model', usage);
  });

  it('sends only the tail of an oversized description', async () => {
    const { agent, generate } = fakeAgent({ response: textResponse('{"title": "T"}') });

    await generateSessionTitle(agent, `head-${'x'.repeat(2_000)}-tail`);

    const messages = generate.mock.calls[0]![3] as Array<{ content: unknown }>;
    const text = JSON.stringify(messages[0]!.content);
    expect(text).not.toContain('head-');
    expect(text).toContain('-tail');
    expect(text.length).toBeLessThanOrEqual(1_100);
  });

  it('returns null without a configured provider and never calls generate', async () => {
    const { agent, generate } = fakeAgent({ hasProvider: false, response: textResponse('T') });

    expect(await generateSessionTitle(agent, 'real work')).toBeNull();
    expect(generate).not.toHaveBeenCalled();
  });

  it('returns null for an empty description and never calls generate', async () => {
    const { agent, generate } = fakeAgent({ response: textResponse('T') });

    expect(await generateSessionTitle(agent, '   ')).toBeNull();
    expect(generate).not.toHaveBeenCalled();
  });

  it('returns null when the request fails, so the fallback title stays', async () => {
    const { agent } = fakeAgent({ error: new Error('boom') });

    expect(await generateSessionTitle(agent, 'real work')).toBeNull();
  });

  it('returns null when the model ignores the contract', async () => {
    const { agent } = fakeAgent({ response: textResponse('{"summary": "no title here"}') });

    expect(await generateSessionTitle(agent, 'real work')).toBeNull();
  });

  it('exposes a sane default timeout for the side-channel call', () => {
    expect(SESSION_TITLE_TIMEOUT_MS).toBeGreaterThan(0);
  });
});

describe('sanitizeSessionTitle', () => {
  it('parses the JSON contract', () => {
    expect(sanitizeSessionTitle('{"title": "Debug failing CI tests"}')).toBe(
      'Debug failing CI tests',
    );
  });

  it('strips wrapping quotes and collapses whitespace', () => {
    expect(sanitizeSessionTitle('  "Refactor   API client"  ')).toBe('Refactor API client');
  });

  it('rejects empty and overlong output', () => {
    expect(sanitizeSessionTitle('')).toBeNull();
    expect(sanitizeSessionTitle('   ')).toBeNull();
    expect(sanitizeSessionTitle(`{"title": "${'word '.repeat(40)}"}`)).toBeNull();
  });

  it('rejects JSON without a string title field', () => {
    expect(sanitizeSessionTitle('{"title": 42}')).toBeNull();
    expect(sanitizeSessionTitle('{"other": "x"}')).toBeNull();
  });
});
