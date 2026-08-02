/**
 * custom-entries store tests — classification (custom vs managed/built-in),
 * cascade/fallback helpers, and the active-model repair after deletions.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelAlias, ProviderConfig } from '@cloud-code/sdk';

import {
  isCustomModel,
  isCustomProvider,
  providerModelAliases,
  resolveModelFallback,
  revertActiveModelAfterRemoval,
} from '#/tui/utils/custom-entries';
import { setLocalePreference } from '#/tui/i18n';

function provider(overrides: Record<string, unknown> = {}): ProviderConfig {
  return { type: 'openai', apiKey: 'k', ...overrides } as unknown as ProviderConfig;
}

function model(providerId: string, modelId = 'm1'): ModelAlias {
  return { provider: providerId, model: modelId, maxContextSize: 1024 } as unknown as ModelAlias;
}

beforeEach(() => {
  vi.clearAllMocks();
  setLocalePreference('en');
});

describe('isCustomProvider', () => {
  it('accepts standalone providers (wizard-created and catalog-imported)', () => {
    expect(isCustomProvider('acme', provider())).toBe(true);
    expect(isCustomProvider('acme', provider({ baseUrl: 'https://x/v1' }))).toBe(true);
    // Catalog imports persist without apiKey/baseUrl markers too.
    expect(isCustomProvider('openai', { type: 'openai' } as unknown as ProviderConfig)).toBe(true);
  });

  it('rejects managed, open-platform, oauth, registry, and env providers', () => {
    expect(isCustomProvider('managed:kimi-code', provider())).toBe(false);
    expect(isCustomProvider('managed:chatgpt-codex', provider())).toBe(false);
    expect(isCustomProvider('moonshot-cn', provider())).toBe(false); // open platform
    expect(
      isCustomProvider('acme', provider({ oauth: { storage: 'file', key: 'k' } })),
    ).toBe(false);
    expect(
      isCustomProvider(
        'acme',
        provider({ source: { kind: 'apiJson', url: 'https://r/api.json', apiKey: 'k' } }),
      ),
    ).toBe(false);
    expect(isCustomProvider('__kimi_env__', provider())).toBe(false);
  });

  it('rejects a missing provider entry', () => {
    expect(isCustomProvider('ghost', undefined)).toBe(false);
  });
});

describe('isCustomModel', () => {
  it('is custom exactly when its provider is custom', () => {
    const providers = {
      acme: provider(),
      'managed:kimi-code': provider(),
    } as unknown as Record<string, ProviderConfig>;
    expect(isCustomModel(model('acme'), providers)).toBe(true);
    expect(isCustomModel(model('managed:kimi-code'), providers)).toBe(false);
    // Dangling provider reference — not editable through the custom flows.
    expect(isCustomModel(model('ghost'), providers)).toBe(false);
    expect(isCustomModel(undefined, providers)).toBe(false);
  });
});

describe('providerModelAliases', () => {
  it('lists every alias pointing at the provider, in config order', () => {
    const models = {
      'acme/a': model('acme', 'a'),
      'other/b': model('other', 'b'),
      'acme/c': model('acme', 'c'),
    } as unknown as Record<string, ModelAlias>;
    expect(providerModelAliases(models, 'acme')).toEqual(['acme/a', 'acme/c']);
    expect(providerModelAliases(models, 'nobody')).toEqual([]);
  });
});

describe('resolveModelFallback', () => {
  const models = {
    'acme/a': model('acme', 'a'),
    'acme/b': model('acme', 'b'),
  } as unknown as Record<string, ModelAlias>;

  it('prefers the surviving persisted default', () => {
    expect(
      resolveModelFallback({ models, defaultModel: 'acme/b' }, new Set(['acme/a'])),
    ).toBe('acme/b');
  });

  it('falls back to the first remaining alias when the default is gone', () => {
    expect(
      resolveModelFallback({ models, defaultModel: 'acme/a' }, new Set(['acme/a'])),
    ).toBe('acme/b');
    expect(resolveModelFallback({ models }, new Set(['acme/b']))).toBe('acme/a');
  });

  it('returns undefined when nothing remains', () => {
    expect(resolveModelFallback({ models }, new Set(['acme/a', 'acme/b']))).toBeUndefined();
    expect(resolveModelFallback({ models: {} }, new Set())).toBeUndefined();
  });
});

describe('revertActiveModelAfterRemoval', () => {
  interface FakeConfig {
    providers: Record<string, unknown>;
    models: Record<string, ModelAlias>;
    defaultModel?: string;
  }

  function makeHost(initial: FakeConfig, activeModel: string, withSession = true) {
    let persisted: FakeConfig = structuredClone(initial);
    const setConfigCalls: Array<Record<string, unknown>> = [];
    const session =
      withSession === false
        ? undefined
        : {
            setModel: vi.fn(async (alias: string) => {
              sessionState.model = alias;
            }),
            getStatus: vi.fn(async () => ({
              model: sessionState.model,
              thinkingEffort: 'high',
            })),
          };
    const sessionState = { model: activeModel };

    const host = {
      state: {
        appState: {
          model: activeModel,
          thinkingEffort: 'off',
          availableProviders: persisted.providers,
          availableModels: persisted.models,
        },
      },
      session,
      harness: {
        getConfig: vi.fn(async () => structuredClone(persisted)),
        setConfig: vi.fn(async (patch: Record<string, unknown>) => {
          setConfigCalls.push(structuredClone(patch));
          persisted = { ...persisted, ...patch } as FakeConfig;
          return structuredClone(persisted);
        }),
      },
      authFlow: {
        refreshAvailableModels: vi.fn(async () => {
          host.state.appState.availableProviders = persisted.providers;
          host.state.appState.availableModels = persisted.models;
        }),
        clearActiveSessionAfterLogout: vi.fn(async () => {
          host.state.appState.model = '';
        }),
      },
      setAppState: vi.fn((patch: Record<string, unknown>) => {
        Object.assign(host.state.appState, patch);
      }),
      showStatus: vi.fn(),
      showError: vi.fn(),
    };
    return { host, session, setConfigCalls };
  }

  it('only refreshes the lists when the active model survived', async () => {
    const ctx = makeHost(
      {
        providers: { acme: provider() },
        models: { 'acme/a': model('acme', 'a'), 'acme/b': model('acme', 'b') },
      },
      'acme/a',
    );
    await revertActiveModelAfterRemoval(ctx.host as never, new Set(['acme/b']));
    expect(ctx.host.authFlow.refreshAvailableModels).toHaveBeenCalledOnce();
    expect(ctx.session?.setModel).not.toHaveBeenCalled();
    expect(ctx.host.setAppState).not.toHaveBeenCalled();
    expect(ctx.setConfigCalls).toHaveLength(0);
  });

  it('switches the live session to the surviving default and keeps it as default', async () => {
    const ctx = makeHost(
      {
        providers: { acme: provider() },
        models: { 'acme/a': model('acme', 'a'), 'acme/b': model('acme', 'b') },
        defaultModel: 'acme/b',
      },
      'acme/a',
    );
    // Simulate the RPC having removed the alias before the repair runs.
    await revertActiveModelAfterRemoval(ctx.host as never, new Set(['acme/a']));

    expect(ctx.session?.setModel).toHaveBeenCalledWith('acme/b');
    expect(ctx.host.state.appState.model).toBe('acme/b');
    // Session status effort is adopted ('high' from the fake getStatus).
    expect(ctx.host.state.appState.thinkingEffort).toBe('high');
    // The default survived — no defaultModel rewrite.
    expect(ctx.setConfigCalls).toHaveLength(0);
    expect(ctx.host.showStatus).toHaveBeenCalledWith(
      expect.stringContaining('switched to'),
      'warning',
    );
  });

  it('persists the fallback as the new default when the old default was removed', async () => {
    const ctx = makeHost(
      {
        providers: { acme: provider() },
        models: { 'acme/a': model('acme', 'a'), 'acme/b': model('acme', 'b') },
        defaultModel: 'acme/a',
      },
      'acme/a',
      false,
    );
    await revertActiveModelAfterRemoval(ctx.host as never, new Set(['acme/a']));
    expect(ctx.setConfigCalls).toEqual([{ defaultModel: 'acme/b' }]);
    expect(ctx.host.state.appState.model).toBe('acme/b');
  });

  it('clears the active session and warns when no models remain', async () => {
    const ctx = makeHost(
      { providers: { acme: provider() }, models: { 'acme/a': model('acme', 'a') } },
      'acme/a',
    );
    await revertActiveModelAfterRemoval(ctx.host as never, new Set(['acme/a']));
    expect(ctx.host.authFlow.clearActiveSessionAfterLogout).toHaveBeenCalledOnce();
    expect(ctx.session?.setModel).not.toHaveBeenCalled();
    expect(ctx.host.showStatus).toHaveBeenCalledWith(
      expect.stringContaining('No models remain'),
      'warning',
    );
  });
});
