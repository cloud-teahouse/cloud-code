import { describe, expect, it, vi } from 'vitest';
import type { ChatProvider } from '@cloud-code/kosong';
import { OpenAIResponsesChatProvider } from '@cloud-code/kosong/providers/openai-responses';

import { isFastTierSupported, serviceTierFromConfig } from '../../src/agent/config';
import type { CloudCodeConfig } from '../../src/config';
import { ProviderManager } from '../../src/session/provider-manager';
import { testAgent } from './harness';

const CODEX_MODEL_ALIAS = 'chatgpt-codex/gpt-5.2-codex';
const CODEX_SLOW_MODEL_ALIAS = 'chatgpt-codex/gpt-5.1-codex-mini';

const codexConfig: CloudCodeConfig = {
  providers: {
    codex: {
      type: 'openai_responses',
      apiKey: 'test-key',
      baseUrl: 'https://chatgpt.com/backend-api/codex',
    },
  },
  models: {
    [CODEX_MODEL_ALIAS]: {
      provider: 'codex',
      model: 'gpt-5.2-codex',
      maxContextSize: 400_000,
      capabilities: ['tool_use'],
      serviceTiers: ['priority'],
    },
    // Official backend but the catalog declares no fast tier for this model.
    [CODEX_SLOW_MODEL_ALIAS]: {
      provider: 'codex',
      model: 'gpt-5.1-codex-mini',
      maxContextSize: 200_000,
      capabilities: ['tool_use'],
    },
  },
};

// Third-party OpenAI-compatible endpoint: same wire type, and a hand-written
// alias even declares the priority tier — the gate must still refuse.
const thirdPartyConfig: CloudCodeConfig = {
  providers: {
    gateway: {
      type: 'openai_responses',
      apiKey: 'test-key',
      baseUrl: 'https://openai-proxy.example.com/v1',
    },
  },
  models: {
    'gateway/gpt-5.2-codex': {
      provider: 'gateway',
      model: 'gpt-5.2-codex',
      maxContextSize: 400_000,
      capabilities: ['tool_use'],
      serviceTiers: ['priority'],
    },
  },
};

const cloudCodeConfig: CloudCodeConfig = {
  providers: {
    kimi: { type: 'kimi', apiKey: 'test-key' },
  },
  models: {
    'kimi-code/kimi-for-coding': {
      provider: 'kimi',
      model: 'kimi-for-coding',
      maxContextSize: 1_000_000,
      capabilities: ['tool_use'],
    },
  },
};

function makeResponsesAPIResponse() {
  return {
    id: 'resp_test123',
    object: 'response',
    created_at: 1234567890,
    status: 'completed',
    model: 'gpt-5.2-codex',
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

/**
 * Capture the request body a provider sends to the Responses API by stubbing
 * the SDK client's `responses.create` (mirrors kosong's own provider tests).
 */
async function captureRequestBody(provider: ChatProvider): Promise<Record<string, unknown>> {
  let capturedBody: Record<string, unknown> | undefined;
  const target = provider as unknown as {
    _stream: boolean;
    _client: { responses: Record<string, unknown> };
  };
  target._stream = false;
  target._client.responses['create'] = vi.fn().mockImplementation((params: unknown) => {
    capturedBody = params as Record<string, unknown>;
    return {
      withResponse: () =>
        Promise.resolve({ data: makeResponsesAPIResponse(), response: new Response(null) }),
    };
  });

  const stream = await provider.generate('system', [], [
    { role: 'user', content: [{ type: 'text', text: 'hi' }], toolCalls: [] },
  ]);
  for await (const part of stream) {
    void part;
  }
  if (capturedBody === undefined) {
    throw new Error('Expected provider.generate() to call responses.create');
  }
  return capturedBody;
}

describe('serviceTierFromConfig', () => {
  it('maps "fast" to the priority wire value and everything else to undefined', () => {
    expect(serviceTierFromConfig('fast')).toBe('priority');
    expect(serviceTierFromConfig('default')).toBeUndefined();
    expect(serviceTierFromConfig(undefined)).toBeUndefined();
  });
});

describe('isFastTierSupported', () => {
  const officialProvider = {
    type: 'openai_responses',
    baseUrl: 'https://chatgpt.com/backend-api/codex',
  };

  it('allows the official Codex backend when the model catalog declares the priority tier', () => {
    expect(isFastTierSupported({ serviceTiers: ['priority'] }, officialProvider)).toBe(true);
    expect(isFastTierSupported({ serviceTiers: ['flex', 'priority'] }, officialProvider)).toBe(true);
  });

  it('refuses the official Codex backend when the model does not declare the priority tier', () => {
    expect(isFastTierSupported({ serviceTiers: ['flex'] }, officialProvider)).toBe(false);
    expect(isFastTierSupported({ serviceTiers: [] }, officialProvider)).toBe(false);
    expect(isFastTierSupported({}, officialProvider)).toBe(false);
    expect(isFastTierSupported(undefined, officialProvider)).toBe(false);
  });

  it('refuses third-party openai_responses endpoints even when the model declares the tier', () => {
    const thirdParty = { type: 'openai_responses', baseUrl: 'https://openai-proxy.example.com/v1' };
    expect(isFastTierSupported({ serviceTiers: ['priority'] }, thirdParty)).toBe(false);
    expect(isFastTierSupported({ serviceTiers: ['priority'] }, { type: 'openai_responses' })).toBe(false);
  });

  it('allows a third-party endpoint when the provider itself declares the priority tier', () => {
    const declared = {
      type: 'openai_responses',
      baseUrl: 'https://openai-proxy.example.com/v1',
      serviceTiers: ['priority'],
    };
    // Alias-level declaration merged from the catalog…
    expect(isFastTierSupported({ serviceTiers: ['priority'] }, declared)).toBe(true);
    // …and a bare alias relying on the provider's declaration.
    expect(isFastTierSupported({}, declared)).toBe(true);
    expect(isFastTierSupported(undefined, declared)).toBe(true);
    // A provider declaration without 'priority' does not qualify.
    expect(
      isFastTierSupported(
        { serviceTiers: ['priority'] },
        { ...declared, serviceTiers: ['flex'] },
      ),
    ).toBe(false);
    // An alias-level declaration overrides the provider's: alias says none.
    expect(
      isFastTierSupported(
        { serviceTiers: [] },
        { ...declared },
      ),
    ).toBe(false);
  });

  it('refuses non-openai_responses wires and missing providers', () => {
    expect(isFastTierSupported({ serviceTiers: ['priority'] }, { type: 'kimi' })).toBe(false);
    expect(isFastTierSupported({ serviceTiers: ['priority'] }, undefined)).toBe(false);
  });

  it('provider-level serviceTiers parses through the config schema', async () => {
    const { ProviderConfigSchema } = await import('#/config/schema');
    const parsed = ProviderConfigSchema.parse({
      type: 'openai_responses',
      baseUrl: 'https://openai-proxy.example.com/v1',
      serviceTiers: ['priority'],
    });
    expect(parsed.serviceTiers).toEqual(['priority']);
    expect(ProviderConfigSchema.parse({ type: 'kimi' }).serviceTiers).toBeUndefined();
  });

  it('threads reasoningRoundTrip from the model alias into the provider options', async () => {
    const { ProviderManager } = await import('#/session/provider-manager');
    const config: CloudCodeConfig = {
      providers: {
        gateway: { type: 'openai', apiKey: 'k', baseUrl: 'https://openai-proxy.example.com/v1' },
      },
      models: {
        'gateway/gpt-x': {
          provider: 'gateway',
          model: 'gpt-x',
          maxContextSize: 200_000,
          reasoningRoundTrip: 'tool-calls-only',
        },
        'gateway/gpt-y': {
          provider: 'gateway',
          model: 'gpt-y',
          maxContextSize: 200_000,
        },
      },
    };
    const manager = new ProviderManager({ config });
    const withKnob = manager.resolveProviderConfig('gateway/gpt-x').provider;
    expect(withKnob.type === 'openai' && withKnob.reasoningRoundTrip).toBe('tool-calls-only');
    const without = manager.resolveProviderConfig('gateway/gpt-y').provider;
    expect(without.type === 'openai' && without.reasoningRoundTrip).toBeUndefined();
  });
});

describe('ConfigState service tier (/fast)', () => {
  function codexAgent(initialServiceTier?: 'fast' | 'default') {
    const ctx = testAgent({
      initialConfig:
        initialServiceTier === undefined
          ? codexConfig
          : { ...codexConfig, serviceTier: initialServiceTier },
      providerManager: new ProviderManager({ config: codexConfig }),
    });
    ctx.agent.config.update({ modelAlias: CODEX_MODEL_ALIAS });
    return ctx;
  }

  it('sends service_tier: "priority" to the Responses API while fast is on', async () => {
    const ctx = codexAgent();
    ctx.agent.config.setServiceTier('priority');

    const provider = ctx.agent.config.provider;
    expect(provider).toBeInstanceOf(OpenAIResponsesChatProvider);
    const body = await captureRequestBody(provider);

    expect(body['service_tier']).toBe('priority');
  });

  it('sends service_tier to a third-party endpoint when the provider declares priority', async () => {
    const thirdPartyConfig: CloudCodeConfig = {
      providers: {
        gateway: {
          type: 'openai_responses',
          apiKey: 'test-key',
          baseUrl: 'https://openai-proxy.example.com/v1',
          serviceTiers: ['priority'],
        },
      },
      models: {
        'gateway/gpt-x': {
          provider: 'gateway',
          model: 'gpt-x',
          maxContextSize: 200_000,
          capabilities: ['tool_use'],
        },
      },
    };
    const ctx = testAgent({
      initialConfig: thirdPartyConfig,
      providerManager: new ProviderManager({ config: thirdPartyConfig }),
    });
    ctx.agent.config.update({ modelAlias: 'gateway/gpt-x' });
    ctx.agent.config.setServiceTier('priority');

    const provider = ctx.agent.config.provider;
    expect(provider).toBeInstanceOf(OpenAIResponsesChatProvider);
    const body = await captureRequestBody(provider);
    expect(body['service_tier']).toBe('priority');
  });

  it('does not send service_tier to a third-party endpoint without a provider declaration', async () => {
    const thirdPartyConfig: CloudCodeConfig = {
      providers: {
        gateway: {
          type: 'openai_responses',
          apiKey: 'test-key',
          baseUrl: 'https://openai-proxy.example.com/v1',
        },
      },
      models: {
        'gateway/gpt-x': {
          provider: 'gateway',
          model: 'gpt-x',
          maxContextSize: 200_000,
          capabilities: ['tool_use'],
          serviceTiers: ['priority'],
        },
      },
    };
    const ctx = testAgent({
      initialConfig: { ...thirdPartyConfig, serviceTier: 'fast' },
      providerManager: new ProviderManager({ config: thirdPartyConfig }),
    });
    ctx.agent.config.update({ modelAlias: 'gateway/gpt-x' });

    const body = await captureRequestBody(ctx.agent.config.provider);
    expect(body['service_tier']).toBeUndefined();
  });

  it('omits service_tier from the request body while fast is off', async () => {
    const ctx = codexAgent();

    const body = await captureRequestBody(ctx.agent.config.provider);

    expect('service_tier' in body).toBe(false);
  });

  it('round-trips a toggle: on then explicitly off leaves no trace on the wire', async () => {
    const ctx = codexAgent();

    ctx.agent.config.setServiceTier('priority');
    expect(ctx.agent.config.serviceTier).toBe('priority');
    expect(ctx.agent.config.data().serviceTier).toBe('priority');
    let body = await captureRequestBody(ctx.agent.config.provider);
    expect(body['service_tier']).toBe('priority');

    ctx.agent.config.setServiceTier(undefined);
    expect(ctx.agent.config.serviceTier).toBeUndefined();
    expect(ctx.agent.config.data().serviceTier).toBeUndefined();
    body = await captureRequestBody(ctx.agent.config.provider);
    expect('service_tier' in body).toBe(false);
  });

  it('clears the tier via an explicit null update (records-safe clear)', () => {
    const ctx = codexAgent();

    ctx.agent.config.update({ serviceTier: 'priority' });
    expect(ctx.agent.config.serviceTier).toBe('priority');
    ctx.agent.config.update({ serviceTier: null });
    expect(ctx.agent.config.serviceTier).toBeUndefined();
  });

  it('seeds the runtime tier from the persisted config.toml preference', async () => {
    const fast = codexAgent('fast');
    expect(fast.agent.config.serviceTier).toBe('priority');
    const body = await captureRequestBody(fast.agent.config.provider);
    expect(body['service_tier']).toBe('priority');

    const standard = codexAgent('default');
    expect(standard.agent.config.serviceTier).toBeUndefined();
  });

  it('is a no-op for non-OpenAI-Responses providers', () => {
    const ctx = testAgent({
      initialConfig: cloudCodeConfig,
      providerManager: new ProviderManager({ config: cloudCodeConfig }),
    });
    ctx.agent.config.update({ modelAlias: 'kimi-code/kimi-for-coding' });
    ctx.agent.config.setServiceTier('priority');

    const provider = ctx.agent.config.provider;
    expect(provider).not.toBeInstanceOf(OpenAIResponsesChatProvider);
    // The decoration chain returned the provider untouched — no kwarg leak.
    const params = (provider as unknown as { modelParameters?: Record<string, unknown> })
      .modelParameters;
    expect(params?.['service_tier']).toBeUndefined();
  });

  it('omits service_tier when the model catalog does not declare the priority tier', async () => {
    const ctx = testAgent({
      initialConfig: codexConfig,
      providerManager: new ProviderManager({ config: codexConfig }),
    });
    ctx.agent.config.update({ modelAlias: CODEX_SLOW_MODEL_ALIAS });
    ctx.agent.config.setServiceTier('priority');

    const provider = ctx.agent.config.provider;
    expect(provider).toBeInstanceOf(OpenAIResponsesChatProvider);
    const body = await captureRequestBody(provider);
    expect('service_tier' in body).toBe(false);
  });

  it('never sends service_tier to third-party endpoints, even when the alias declares the tier', async () => {
    const ctx = testAgent({
      initialConfig: thirdPartyConfig,
      providerManager: new ProviderManager({ config: thirdPartyConfig }),
    });
    ctx.agent.config.update({ modelAlias: 'gateway/gpt-5.2-codex' });
    ctx.agent.config.setServiceTier('priority');

    const provider = ctx.agent.config.provider;
    expect(provider).toBeInstanceOf(OpenAIResponsesChatProvider);
    const body = await captureRequestBody(provider);
    expect('service_tier' in body).toBe(false);
  });
});
