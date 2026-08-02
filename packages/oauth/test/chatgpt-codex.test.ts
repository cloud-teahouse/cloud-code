/**
 * ChatGPT Codex provider tests — model discovery mapping, config
 * provisioning/logout, and the refreshProviderModels orchestrator branch.
 * All HTTP is mocked via injected fetchImpl / a stubbed global fetch.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  applyChatGptCodexConfig,
  applyChatGptCodexLogoutConfig,
  CHATGPT_CODEX_BASE_URL,
  CHATGPT_CODEX_OAUTH_KEY,
  CHATGPT_CODEX_PROVIDER_NAME,
  ChatGptCodexModelsAuthError,
  fetchChatGptCodexModels,
  provisionChatGptCodexConfig,
  type ChatGptCodexModelInfo,
} from '../src/chatgpt-codex';
import type { ManagedKimiConfigShape } from '../src/managed-kimi-code';
import { refreshProviderModels, type RefreshProviderHost } from '../src/refreshProviderModels';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const CATALOG_PAYLOAD = {
  models: [
    {
      slug: 'gpt-5.2-codex',
      display_name: 'GPT-5.2 Codex',
      context_window: 400000,
      // Real catalog shape: array of {effort, description} objects.
      // 'ultra' is advertised but rejected by the Responses API — filtered out.
      supported_reasoning_levels: [
        { effort: 'low', description: 'Fast responses with lighter reasoning' },
        { effort: 'medium', description: 'Balances speed and depth' },
        { effort: 'high', description: 'Greater reasoning depth' },
        { effort: 'ultra', description: 'Maximum reasoning with automatic task delegation' },
      ],
      default_reasoning_level: 'medium',
      priority: 1,
      // Real catalog shape: array of {id, name, description} objects; only the
      // ids are kept ('priority' = fast tier).
      service_tiers: [{ id: 'priority', name: 'Fast', description: 'Priority processing.' }],
    },
    {
      slug: 'gpt-5.1-codex-mini',
      context_window: 200000,
      supported_reasoning_levels: [
        { effort: 'medium', description: 'Balances speed and depth' },
        { effort: 'high', description: 'Greater reasoning depth' },
      ],
      default_reasoning_level: 'high',
      // No service_tiers: the model is not fast-capable.
    },
    // Malformed entry — skipped by the mapper.
    { display_name: 'no slug' },
  ],
};

describe('fetchChatGptCodexModels', () => {
  it('sends bearer + account-id headers and maps the {models:[…]} shape', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(200, CATALOG_PAYLOAD));
    const models = await fetchChatGptCodexModels({
      accessToken: 'access-1',
      accountId: 'acct-1',
      clientVersion: '1.2.3',
      fetchImpl,
    });

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(`${CHATGPT_CODEX_BASE_URL}/models?client_version=1.2.3`);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer access-1');
    expect(headers['ChatGPT-Account-ID']).toBe('acct-1');
    expect(headers['originator']).toBe('codex_cli_rs');

    expect(models).toHaveLength(2);
    expect(models[0]).toEqual({
      id: 'gpt-5.2-codex',
      displayName: 'GPT-5.2 Codex',
      contextLength: 400000,
      supportEfforts: ['low', 'medium', 'high'],
      defaultEffort: 'medium',
      serviceTiers: ['priority'],
    });
    expect(models[1]).toEqual({
      id: 'gpt-5.1-codex-mini',
      displayName: undefined,
      contextLength: 200000,
      supportEfforts: ['medium', 'high'],
      defaultEffort: 'high',
      serviceTiers: undefined,
    });
  });

  it('omits the account-id header when no account id is known', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(200, { models: [] }));
    await fetchChatGptCodexModels({ accessToken: 'a', fetchImpl });
    const headers = (fetchImpl.mock.calls[0]?.[1]?.headers ?? {}) as Record<string, string>;
    expect(headers['ChatGPT-Account-ID']).toBeUndefined();
  });

  it('defaults client_version to 0.0.0 (real version strings are gated to an empty catalog by the backend)', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(200, { models: [] }));
    await fetchChatGptCodexModels({ accessToken: 'a', fetchImpl });
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(`${CHATGPT_CODEX_BASE_URL}/models?client_version=0.0.0`);
  });

  it('skips visibility:hide and supported_in_api:false entries', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonResponse(200, {
        models: [
          { slug: 'gpt-5.6-sol', context_window: 400000, visibility: 'list', supported_in_api: true },
          { slug: 'codex-auto-review', context_window: 400000, visibility: 'hide', supported_in_api: true },
          { slug: 'gpt-legacy', context_window: 200000, visibility: 'list', supported_in_api: false },
        ],
      }),
    );
    const models = await fetchChatGptCodexModels({ accessToken: 'a', fetchImpl });
    expect(models.map((m) => m.id)).toEqual(['gpt-5.6-sol']);
  });

  it('maps 401/403 to ChatGptCodexModelsAuthError', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonResponse(403, { detail: 'Workspace is not authorized in this region.' }),
    );
    const error = await fetchChatGptCodexModels({
      accessToken: 'a',
      accountId: 'acct',
      fetchImpl,
    }).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(ChatGptCodexModelsAuthError);
    expect((error as Error).message).toContain('not authorized in this region');
  });

  it('rejects an unexpected response shape', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(200, { data: [] }));
    await expect(fetchChatGptCodexModels({ accessToken: 'a', fetchImpl })).rejects.toThrow(
      /Unexpected models response/,
    );
  });
});

function model(overrides: Partial<ChatGptCodexModelInfo> = {}): ChatGptCodexModelInfo {
  return {
    id: 'gpt-5.2-codex',
    contextLength: 400000,
    supportEfforts: ['low', 'medium', 'high'],
    defaultEffort: 'medium',
    displayName: 'GPT-5.2 Codex',
    serviceTiers: ['priority'],
    ...overrides,
  };
}

describe('applyChatGptCodexConfig', () => {
  it('writes the openai_responses provider, aliases, defaultModel and thinking', () => {
    const config: ManagedKimiConfigShape = { providers: {} };
    const result = applyChatGptCodexConfig(config, { models: [model()] });

    expect(config.providers[CHATGPT_CODEX_PROVIDER_NAME]).toEqual({
      type: 'openai_responses',
      baseUrl: CHATGPT_CODEX_BASE_URL,
      apiKey: '',
      oauth: { storage: 'file', key: CHATGPT_CODEX_OAUTH_KEY },
      omitMaxOutputTokens: true,
      customHeaders: { originator: 'codex_cli_rs' },
    });
    expect(config.models?.['chatgpt-codex/gpt-5.2-codex']).toEqual({
      provider: CHATGPT_CODEX_PROVIDER_NAME,
      model: 'gpt-5.2-codex',
      maxContextSize: 400000,
      capabilities: ['thinking', 'tool_use'],
      displayName: 'GPT-5.2 Codex',
      supportEfforts: ['low', 'medium', 'high'],
      defaultEffort: 'medium',
      serviceTiers: ['priority'],
    });
    expect(result.defaultModel).toBe('chatgpt-codex/gpt-5.2-codex');
    expect(config.defaultModel).toBe('chatgpt-codex/gpt-5.2-codex');
    // Reasoning-capable default model → thinking on.
    expect(result.defaultThinking).toBe(true);
    expect(config.thinking?.enabled).toBe(true);
  });

  it('defaults thinking off when the model declares no reasoning levels', () => {
    const config: ManagedKimiConfigShape = { providers: {} };
    const result = applyChatGptCodexConfig(config, {
      models: [model({ supportEfforts: undefined, defaultEffort: undefined })],
    });
    expect(result.defaultThinking).toBe(false);
    expect(config.models?.['chatgpt-codex/gpt-5.2-codex']?.['capabilities']).toEqual(['tool_use']);
  });

  it('removes stale managed aliases but preserves user extras and other providers', () => {
    const config: ManagedKimiConfigShape = {
      providers: { other: { type: 'openai', apiKey: 'k' } },
      models: {
        'chatgpt-codex/old-model': {
          provider: CHATGPT_CODEX_PROVIDER_NAME,
          model: 'old-model',
          maxContextSize: 100,
        },
        'chatgpt-codex/gpt-5.2-codex': {
          provider: CHATGPT_CODEX_PROVIDER_NAME,
          model: 'gpt-5.2-codex',
          maxContextSize: 1,
          customUserField: 'keep-me',
        },
        'other/alias': { provider: 'other', model: 'x', maxContextSize: 1 },
      },
      defaultModel: 'other/alias',
    };
    const result = applyChatGptCodexConfig(config, {
      models: [model()],
      preserveDefaultModel: true,
    });

    expect(config.models?.['chatgpt-codex/old-model']).toBeUndefined();
    expect(config.models?.['other/alias']).toBeDefined();
    // Hand-written extras survive the refresh; upstream-owned fields are overwritten.
    expect(config.models?.['chatgpt-codex/gpt-5.2-codex']?.['customUserField']).toBe('keep-me');
    expect(config.models?.['chatgpt-codex/gpt-5.2-codex']?.['maxContextSize']).toBe(400000);
    // Another provider owns the current default → preserved.
    expect(result.defaultModel).toBe('other/alias');
    expect(config.defaultModel).toBe('other/alias');
  });

  it('throws when the catalog is empty or a model lacks context_window', () => {
    expect(() => applyChatGptCodexConfig({ providers: {} }, { models: [] })).toThrow(/No models/);
    expect(() =>
      applyChatGptCodexConfig({ providers: {} }, { models: [model({ contextLength: undefined })] }),
    ).toThrow(/context_window/);
  });
});

describe('applyChatGptCodexLogoutConfig', () => {
  it('removes the provider, its aliases and a dangling defaultModel', () => {
    const config: ManagedKimiConfigShape = {
      providers: {
        [CHATGPT_CODEX_PROVIDER_NAME]: { type: 'openai_responses' },
        other: { type: 'openai' },
      },
      models: {
        'chatgpt-codex/gpt-5.2-codex': {
          provider: CHATGPT_CODEX_PROVIDER_NAME,
          model: 'gpt-5.2-codex',
          maxContextSize: 1,
        },
        'other/alias': { provider: 'other', model: 'x', maxContextSize: 1 },
      },
      defaultModel: 'chatgpt-codex/gpt-5.2-codex',
      defaultProvider: CHATGPT_CODEX_PROVIDER_NAME,
    };
    applyChatGptCodexLogoutConfig(config);

    expect(config.providers[CHATGPT_CODEX_PROVIDER_NAME]).toBeUndefined();
    expect(config.providers['other']).toBeDefined();
    expect(config.models?.['chatgpt-codex/gpt-5.2-codex']).toBeUndefined();
    expect(config.models?.['other/alias']).toBeDefined();
    expect(config.defaultModel).toBeUndefined();
    expect(config['defaultProvider']).toBeUndefined();
  });
});

describe('provisionChatGptCodexConfig', () => {
  it('fetches the catalog and applies it through the adapter', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(200, CATALOG_PAYLOAD));
    const stored: ManagedKimiConfigShape = { providers: {} };
    const writes: ManagedKimiConfigShape[] = [];
    const result = await provisionChatGptCodexConfig({
      accessToken: 'access-1',
      accountId: 'acct-1',
      clientVersion: '9.9.9',
      fetchImpl,
      adapter: {
        configPath: '/tmp/config.toml',
        read: () => stored,
        write: (config) => {
          writes.push(config);
        },
        apply: applyChatGptCodexConfig,
      },
    });

    expect(result.providerName).toBe(CHATGPT_CODEX_PROVIDER_NAME);
    expect(result.defaultModel).toBe('chatgpt-codex/gpt-5.2-codex');
    expect(result.models).toHaveLength(2);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.providers[CHATGPT_CODEX_PROVIDER_NAME]).toBeDefined();
    const headers = (fetchImpl.mock.calls[0]?.[1]?.headers ?? {}) as Record<string, string>;
    expect(headers['ChatGPT-Account-ID']).toBe('acct-1');
  });
});

describe('refreshProviderModels — chatgpt-codex branch', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function hostWithChatGptProvider(config: ManagedKimiConfigShape): RefreshProviderHost & {
    readonly written: ManagedKimiConfigShape[];
  } {
    const written: ManagedKimiConfigShape[] = [];
    return {
      written,
      getConfig: () => Promise.resolve(config),
      removeProvider: () => Promise.resolve(config),
      setConfig: (patch) => {
        Object.assign(config, patch);
        written.push(config);
        return Promise.resolve(config);
      },
      resolveOAuthToken: () => Promise.resolve('access-1'),
      resolveOAuthHeaders: () => Promise.resolve({ 'ChatGPT-Account-ID': 'acct-1' }),
    };
  }

  function chatGptConfig(): ManagedKimiConfigShape {
    return {
      providers: {
        [CHATGPT_CODEX_PROVIDER_NAME]: {
          type: 'openai_responses',
          baseUrl: CHATGPT_CODEX_BASE_URL,
          apiKey: '',
          oauth: { storage: 'file', key: CHATGPT_CODEX_OAUTH_KEY },
        },
      },
    };
  }

  it('refreshes the catalog through the oauth-backed branch', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse(200, CATALOG_PAYLOAD));
    vi.stubGlobal('fetch', fetchMock);
    const host = hostWithChatGptProvider(chatGptConfig());

    const result = await refreshProviderModels(host, { scope: 'oauth' });

    expect(result.failed).toEqual([]);
    expect(result.changed.map((c) => c.providerId)).toEqual([CHATGPT_CODEX_PROVIDER_NAME]);
    const headers = (fetchMock.mock.calls[0]?.[1]?.headers ?? {}) as Record<string, string>;
    expect(headers['ChatGPT-Account-ID']).toBe('acct-1');
    expect(headers['Authorization']).toBe('Bearer access-1');
    const config = host.written[0]!;
    expect(config.models?.['chatgpt-codex/gpt-5.2-codex']).toBeDefined();
    // Catalog-declared service tiers persist onto the alias (drives the /fast gate).
    expect(config.models?.['chatgpt-codex/gpt-5.2-codex']?.['serviceTiers']).toEqual(['priority']);
    expect(config.models?.['chatgpt-codex/gpt-5.1-codex-mini']?.['serviceTiers']).toBeUndefined();
    expect(config.defaultModel).toBe('chatgpt-codex/gpt-5.2-codex');
  });

  it('reports an explicit failure when the account id is unavailable', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse(200, CATALOG_PAYLOAD));
    vi.stubGlobal('fetch', fetchMock);
    const host = hostWithChatGptProvider(chatGptConfig());
    host.resolveOAuthHeaders = () => Promise.resolve(undefined);

    const result = await refreshProviderModels(host, { scope: 'oauth' });

    expect(result.changed).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.provider).toBe(CHATGPT_CODEX_PROVIDER_NAME);
    expect(result.failed[0]?.reason).toMatch(/account id/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('scopes to a single provider when providerId is given', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse(200, CATALOG_PAYLOAD));
    vi.stubGlobal('fetch', fetchMock);
    const host = hostWithChatGptProvider(chatGptConfig());

    const result = await refreshProviderModels(host, { providerId: 'some-other-provider' });

    expect(result.changed).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
