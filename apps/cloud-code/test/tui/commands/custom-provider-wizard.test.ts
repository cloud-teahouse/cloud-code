/**
 * Custom provider wizard tests — drives the mounted components through
 * handleInput exactly like a user would: API type picker → base URL dialog →
 * API key dialog → provider id dialog → optional connectivity check →
 * setConfig. Assertions cover the persisted config shape (mirrors
 * ProviderConfigSchema), validation failures, and Esc aborts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { handleProviderCommand } from '#/tui/commands/provider';
import {
  buildCustomProviderEntry,
  deriveProviderIdSuggestion,
  runCustomProviderEditWizard,
  runCustomProviderWizard,
} from '#/tui/commands/custom-provider-wizard';
import { setLocalePreference } from '#/tui/i18n';

const ANSI = /\[[0-9;]*m/g;
const strip = (s: string): string => s.replaceAll(ANSI, '');

const ESC = String.fromCodePoint(27);
const KEY_ENTER = '\r';
const KEY_DOWN = `${ESC}[B`;
const KEY_BACKSPACE = '\x7f';
const KEY_ESC = ESC;

interface FakeConfig {
  providers: Record<string, unknown>;
  models: Record<string, unknown>;
}

function makeHost(initial: Partial<FakeConfig> = {}) {
  let persisted: FakeConfig = {
    providers: structuredClone(initial.providers ?? {}),
    models: structuredClone(initial.models ?? {}),
  };
  const setConfigCalls: Array<Record<string, unknown>> = [];
  const panels: Array<{ handleInput: (data: string) => void; render: (width: number) => string[] }> =
    [];
  const spinner = { stop: vi.fn(), setLabel: vi.fn() };

  const host = {
    state: {
      appState: {
        model: '',
        thinkingEffort: 'off',
        streamingPhase: 'idle',
        availableProviders: persisted.providers,
        availableModels: persisted.models,
      },
    },
    session: undefined,
    harness: {
      getConfig: vi.fn(async () => structuredClone(persisted)),
      setConfig: vi.fn(async (patch: Record<string, unknown>) => {
        setConfigCalls.push(structuredClone(patch));
        persisted = { ...persisted, ...patch } as FakeConfig;
        return structuredClone(persisted);
      }),
      // Wholesale single-entry write used by the edit wizard.
      setProvider: vi.fn(async (providerId: string, entry: unknown) => {
        persisted.providers[providerId] = structuredClone(entry);
        return structuredClone(persisted);
      }),
    },
    authFlow: {
      refreshConfigAfterLogin: vi.fn(async () => {
        host.state.appState.availableProviders = persisted.providers;
        host.state.appState.availableModels = persisted.models;
      }),
      refreshAvailableModels: vi.fn(async () => {
        host.state.appState.availableProviders = persisted.providers;
        host.state.appState.availableModels = persisted.models;
      }),
    },
    mountEditorReplacement: vi.fn((panel: (typeof panels)[number]) => {
      panels.push(panel);
      return { id: panels.length };
    }),
    restoreEditor: vi.fn(),
    setAppState: vi.fn(),
    showStatus: vi.fn(),
    showError: vi.fn(),
    showNotice: vi.fn(),
    showProgressSpinner: vi.fn(() => spinner),
    showLoginProgressSpinner: vi.fn(() => spinner),
  };

  return {
    host,
    panels,
    spinner,
    setConfigCalls,
    current: () => persisted,
    lastPanel: () => panels[panels.length - 1]!,
    panelText: () => strip(panels[panels.length - 1]!.render(100).join('\n')),
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 30; i++) {
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
  }
}

function typeText(panel: { handleInput: (data: string) => void }, text: string): void {
  for (const ch of text) panel.handleInput(ch);
}

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  vi.clearAllMocks();
  setLocalePreference('en');
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('runCustomProviderWizard', () => {
  it('walks the full openai flow and persists a schema-shaped provider', async () => {
    const ctx = makeHost({ providers: { existing: { type: 'kimi', apiKey: 'k' } } });
    const result = runCustomProviderWizard(ctx.host as never);

    // 1. API type — down ×2 to openai, Enter.
    ctx.lastPanel().handleInput(KEY_DOWN);
    ctx.lastPanel().handleInput(KEY_DOWN);
    ctx.lastPanel().handleInput(KEY_ENTER);
    await flush();

    // 2. Base URL.
    typeText(ctx.lastPanel(), 'https://api.example.com/v1');
    ctx.lastPanel().handleInput(KEY_ENTER);
    await flush();

    // 3. API key.
    typeText(ctx.lastPanel(), 'sk-test');
    ctx.lastPanel().handleInput(KEY_ENTER);
    await flush();

    // 4. Provider id — prefilled with the hostname-derived suggestion.
    expect(ctx.panelText()).toContain('example');
    ctx.lastPanel().handleInput(KEY_ENTER);
    await flush();

    // 5. Connectivity — skip.
    ctx.lastPanel().handleInput(KEY_DOWN);
    ctx.lastPanel().handleInput(KEY_ENTER);

    await expect(result).resolves.toBe('example');

    // The persisted patch preserves the existing provider and adds the new
    // one with exactly the ProviderConfigSchema fields for a manual entry.
    expect(ctx.setConfigCalls).toHaveLength(1);
    expect(ctx.setConfigCalls[0]).toEqual({
      providers: {
        existing: { type: 'kimi', apiKey: 'k' },
        example: {
          type: 'openai',
          baseUrl: 'https://api.example.com/v1',
          apiKey: 'sk-test',
        },
      },
    });
    expect(ctx.host.authFlow.refreshConfigAfterLogin).toHaveBeenCalledOnce();
    expect(ctx.host.showError).not.toHaveBeenCalled();
  });

  it('lets anthropic leave the base URL empty (official default) and stores no baseUrl', async () => {
    const ctx = makeHost();
    const result = runCustomProviderWizard(ctx.host as never);

    // API type — anthropic is second.
    ctx.lastPanel().handleInput(KEY_DOWN);
    ctx.lastPanel().handleInput(KEY_ENTER);
    await flush();

    // Base URL — empty submit is allowed for anthropic.
    ctx.lastPanel().handleInput(KEY_ENTER);
    await flush();

    // API key.
    typeText(ctx.lastPanel(), 'sk-ant');
    ctx.lastPanel().handleInput(KEY_ENTER);
    await flush();

    // Provider id — suggestion falls back to the type name.
    expect(ctx.panelText()).toContain('anthropic');
    ctx.lastPanel().handleInput(KEY_ENTER);
    await flush();

    // Skip connectivity.
    ctx.lastPanel().handleInput(KEY_DOWN);
    ctx.lastPanel().handleInput(KEY_ENTER);

    await expect(result).resolves.toBe('anthropic');
    expect(ctx.current().providers['anthropic']).toEqual({ type: 'anthropic', apiKey: 'sk-ant' });
  });

  it('strips a trailing /v1 from the anthropic base URL', async () => {
    const ctx = makeHost();
    const result = runCustomProviderWizard(ctx.host as never);

    ctx.lastPanel().handleInput(KEY_DOWN);
    ctx.lastPanel().handleInput(KEY_ENTER);
    await flush();
    typeText(ctx.lastPanel(), 'https://claude-gateway.test/v1');
    ctx.lastPanel().handleInput(KEY_ENTER);
    await flush();
    typeText(ctx.lastPanel(), 'sk-gw');
    ctx.lastPanel().handleInput(KEY_ENTER);
    await flush();
    ctx.lastPanel().handleInput(KEY_ENTER); // accept suggested id "claude-gateway"
    await flush();
    ctx.lastPanel().handleInput(KEY_DOWN); // skip connectivity
    ctx.lastPanel().handleInput(KEY_ENTER);

    await expect(result).resolves.toBe('claude-gateway');
    expect(ctx.current().providers['claude-gateway']).toEqual({
      type: 'anthropic',
      baseUrl: 'https://claude-gateway.test',
      apiKey: 'sk-gw',
    });
  });

  it('probes the models endpoint when asked and reports the model count', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ data: [{ id: 'm1' }, { id: 'm2' }] }), { status: 200 }),
    );
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const ctx = makeHost();
    const result = runCustomProviderWizard(ctx.host as never);

    ctx.lastPanel().handleInput(KEY_ENTER); // kimi (first option)
    await flush();
    typeText(ctx.lastPanel(), 'https://kimi.test/v1');
    ctx.lastPanel().handleInput(KEY_ENTER);
    await flush();
    typeText(ctx.lastPanel(), 'sk-kimi');
    ctx.lastPanel().handleInput(KEY_ENTER);
    await flush();
    ctx.lastPanel().handleInput(KEY_ENTER); // accept suggested id
    await flush();
    ctx.lastPanel().handleInput(KEY_ENTER); // "Test connection"
    await flush();

    await expect(result).resolves.toBe('kimi');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://kimi.test/v1/models',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer sk-kimi' }),
      }),
    );
    expect(ctx.host.showStatus).toHaveBeenCalledWith(
      expect.stringContaining('2'),
      'success',
    );
    expect(ctx.current().providers['kimi']).toBeDefined();
  });

  it('warns on a failed probe but saves the provider anyway', async () => {
    globalThis.fetch = vi.fn(async () => new Response('nope', { status: 401 })) as unknown as typeof globalThis.fetch;

    const ctx = makeHost();
    const result = runCustomProviderWizard(ctx.host as never);

    ctx.lastPanel().handleInput(KEY_ENTER); // kimi
    await flush();
    typeText(ctx.lastPanel(), 'https://kimi.test/v1');
    ctx.lastPanel().handleInput(KEY_ENTER);
    await flush();
    typeText(ctx.lastPanel(), 'sk-bad');
    ctx.lastPanel().handleInput(KEY_ENTER);
    await flush();
    ctx.lastPanel().handleInput(KEY_ENTER); // accept id
    await flush();
    ctx.lastPanel().handleInput(KEY_ENTER); // test connection
    await flush();

    await expect(result).resolves.toBe('kimi');
    expect(ctx.host.showStatus).toHaveBeenCalledWith(
      expect.stringContaining('HTTP 401'),
      'warning',
    );
    expect(ctx.current().providers['kimi']).toEqual({
      type: 'kimi',
      baseUrl: 'https://kimi.test/v1',
      apiKey: 'sk-bad',
    });
  });

  it('rejects a non-http(s) base URL and continues after the value is fixed', async () => {
    const ctx = makeHost();
    const result = runCustomProviderWizard(ctx.host as never);

    ctx.lastPanel().handleInput(KEY_ENTER); // kimi
    await flush();

    // Invalid URL: submit is rejected inline (no new panel is mounted).
    const panelsBefore = ctx.panels.length;
    typeText(ctx.lastPanel(), 'ftp://nope');
    ctx.lastPanel().handleInput(KEY_ENTER);
    await flush();
    expect(ctx.panels.length).toBe(panelsBefore);
    expect(ctx.panelText()).toContain('http://');

    // Fix the typo in place: backspace ×8 removes "ftp://no"… actually just
    // clear the whole value and retype.
    for (let i = 0; i < 10; i++) ctx.lastPanel().handleInput(KEY_BACKSPACE);
    typeText(ctx.lastPanel(), 'https://ok.test/v1');
    ctx.lastPanel().handleInput(KEY_ENTER);
    await flush();

    // API key step reached.
    typeText(ctx.lastPanel(), 'sk-1');
    ctx.lastPanel().handleInput(KEY_ENTER);
    await flush();
    ctx.lastPanel().handleInput(KEY_ENTER); // id
    await flush();
    ctx.lastPanel().handleInput(KEY_DOWN); // skip verify
    ctx.lastPanel().handleInput(KEY_ENTER);

    await expect(result).resolves.toBe('ok');
    expect(ctx.current().providers['ok']?.['baseUrl' as never]).toBe('https://ok.test/v1');
  });

  it('aborts on Esc at the URL step without writing config', async () => {
    const ctx = makeHost();
    const result = runCustomProviderWizard(ctx.host as never);

    ctx.lastPanel().handleInput(KEY_ENTER); // kimi
    await flush();
    ctx.lastPanel().handleInput(KEY_ESC);

    await expect(result).resolves.toBeUndefined();
    expect(ctx.setConfigCalls).toHaveLength(0);
  });

  it('aborts on Esc at the API type step without writing config', async () => {
    const ctx = makeHost();
    const result = runCustomProviderWizard(ctx.host as never);
    ctx.lastPanel().handleInput(KEY_ESC);
    await expect(result).resolves.toBeUndefined();
    expect(ctx.setConfigCalls).toHaveLength(0);
  });

  it('suffixes the suggested id on conflict and rejects a taken id typed by hand', async () => {
    const ctx = makeHost({
      providers: { example: { type: 'openai', apiKey: 'old' } },
    });
    const result = runCustomProviderWizard(ctx.host as never);

    ctx.lastPanel().handleInput(KEY_DOWN); // anthropic
    ctx.lastPanel().handleInput(KEY_DOWN); // openai
    ctx.lastPanel().handleInput(KEY_ENTER);
    await flush();
    typeText(ctx.lastPanel(), 'https://api.example.com/v1');
    ctx.lastPanel().handleInput(KEY_ENTER);
    await flush();
    typeText(ctx.lastPanel(), 'sk-new');
    ctx.lastPanel().handleInput(KEY_ENTER);
    await flush();

    // Suggestion must be "example-2" — the base id is taken.
    expect(ctx.panelText()).toContain('example-2');

    // Typing a taken id by hand is rejected: clear the prefill, type "example".
    for (let i = 0; i < 10; i++) ctx.lastPanel().handleInput(KEY_BACKSPACE);
    typeText(ctx.lastPanel(), 'example');
    const panelsBefore = ctx.panels.length;
    ctx.lastPanel().handleInput(KEY_ENTER);
    await flush();
    expect(ctx.panels.length).toBe(panelsBefore);
    expect(ctx.panelText()).toContain('already exists');

    // Fix: accept a free id.
    for (let i = 0; i < 10; i++) ctx.lastPanel().handleInput(KEY_BACKSPACE);
    typeText(ctx.lastPanel(), 'example-2');
    ctx.lastPanel().handleInput(KEY_ENTER);
    await flush();
    ctx.lastPanel().handleInput(KEY_DOWN); // skip verify
    ctx.lastPanel().handleInput(KEY_ENTER);

    await expect(result).resolves.toBe('example-2');
    // The existing provider must not be overwritten.
    expect(ctx.current().providers['example']).toEqual({ type: 'openai', apiKey: 'old' });
    expect(ctx.current().providers['example-2']).toBeDefined();
  });

  it('rejects malformed provider ids', async () => {
    const ctx = makeHost();
    const result = runCustomProviderWizard(ctx.host as never);

    ctx.lastPanel().handleInput(KEY_ENTER); // kimi
    await flush();
    typeText(ctx.lastPanel(), 'https://k.example.test/v1');
    ctx.lastPanel().handleInput(KEY_ENTER);
    await flush();
    typeText(ctx.lastPanel(), 'sk-1');
    ctx.lastPanel().handleInput(KEY_ENTER);
    await flush();

    for (let i = 0; i < 10; i++) ctx.lastPanel().handleInput(KEY_BACKSPACE);
    typeText(ctx.lastPanel(), 'Bad Id!');
    const panelsBefore = ctx.panels.length;
    ctx.lastPanel().handleInput(KEY_ENTER);
    await flush();
    expect(ctx.panels.length).toBe(panelsBefore);

    ctx.lastPanel().handleInput(KEY_ESC);
    await expect(result).resolves.toBeUndefined();
  });
});

describe('deriveProviderIdSuggestion', () => {
  it('derives from the hostname second-level label', () => {
    expect(deriveProviderIdSuggestion('openai', 'https://api.example.com/v1', [])).toBe('example');
    expect(deriveProviderIdSuggestion('openai', 'https://example.com/v1', [])).toBe('example');
    expect(deriveProviderIdSuggestion('openai', 'https://localhost:8080/v1', [])).toBe('localhost');
  });

  it('falls back to the type name and then to "custom"', () => {
    expect(deriveProviderIdSuggestion('anthropic', undefined, [])).toBe('anthropic');
    expect(deriveProviderIdSuggestion('openai', 'not a url', [])).toBe('openai');
  });

  it('sanitizes odd hostnames and suffixes conflicts', () => {
    expect(deriveProviderIdSuggestion('openai', 'https://my_host.example.com/v1', [])).toBe(
      'example',
    );
    expect(
      deriveProviderIdSuggestion('openai', 'https://api.example.com/v1', ['example', 'example-2']),
    ).toBe('example-3');
  });
});

describe('/provider manual add integration', () => {
  it('offers the manual source in the add picker and starts the wizard', async () => {
    const ctx = makeHost();
    await handleProviderCommand(ctx.host as never);

    // The manager lists only the synthetic add row; Enter starts the add flow.
    ctx.lastPanel().handleInput(KEY_ENTER);
    await flush();

    const sourceText = ctx.panelText();
    expect(sourceText).toContain('Known third-party provider');
    expect(sourceText).toContain('Custom registry (api.json)');
    expect(sourceText).toContain('Custom endpoint (API type, base URL, key)');

    // Pick the manual source — the wizard's API type picker opens.
    ctx.lastPanel().handleInput(KEY_DOWN);
    ctx.lastPanel().handleInput(KEY_DOWN);
    ctx.lastPanel().handleInput(KEY_ENTER);
    await flush();

    const typeText_ = ctx.panelText();
    expect(typeText_).toContain('Select API type');
    expect(typeText_).toContain('OpenAI Responses');
  });
});

const KEY_UP = `${ESC}[A`;

describe('runCustomProviderEditWizard', () => {
  const existing = {
    type: 'openai',
    baseUrl: 'https://api.acme.test/v1',
    apiKey: 'sk-old',
    customHeaders: { 'x-trace': '1' },
  };

  it('prefills every step and persists only the changed base URL (extra fields preserved)', async () => {
    const ctx = makeHost({ providers: { acme: existing } });
    const result = runCustomProviderEditWizard(ctx.host as never, 'acme');
    await flush();

    // 1. API type — prefilled with openai; Enter accepts.
    ctx.lastPanel().handleInput(KEY_ENTER);
    await flush();

    // 2. Base URL — prefilled with the current one; retype it.
    for (let i = 0; i < 30; i++) ctx.lastPanel().handleInput(KEY_BACKSPACE);
    typeText(ctx.lastPanel(), 'https://gateway.acme.test/v2');
    ctx.lastPanel().handleInput(KEY_ENTER);
    await flush();

    // 3. API key — empty keeps the current key.
    ctx.lastPanel().handleInput(KEY_ENTER);
    await flush();

    // 4. Connectivity — skip.
    ctx.lastPanel().handleInput(KEY_DOWN);
    ctx.lastPanel().handleInput(KEY_ENTER);

    await expect(result).resolves.toBe('updated');
    expect(ctx.host.harness.setProvider).toHaveBeenCalledWith('acme', {
      type: 'openai',
      baseUrl: 'https://gateway.acme.test/v2',
      apiKey: 'sk-old',
      customHeaders: { 'x-trace': '1' },
    });
    expect(ctx.host.authFlow.refreshAvailableModels).toHaveBeenCalledOnce();
    expect(ctx.host.showStatus).toHaveBeenCalledWith(
      expect.stringContaining('updated'),
      'success',
    );
    expect(ctx.setConfigCalls).toHaveLength(0);
  });

  it('reports "unchanged" and writes nothing when every prefill is accepted', async () => {
    const ctx = makeHost({ providers: { acme: existing } });
    const result = runCustomProviderEditWizard(ctx.host as never, 'acme');
    await flush();

    ctx.lastPanel().handleInput(KEY_ENTER); // type
    await flush();
    ctx.lastPanel().handleInput(KEY_ENTER); // base URL
    await flush();
    ctx.lastPanel().handleInput(KEY_ENTER); // API key — keep

    await expect(result).resolves.toBe('unchanged');
    expect(ctx.host.harness.setProvider).not.toHaveBeenCalled();
    expect(ctx.host.showStatus).toHaveBeenCalledWith(expect.stringContaining('unchanged'));
    // No connectivity prompt is shown when nothing changed.
    expect(ctx.panels).toHaveLength(3);
  });

  it('replaces the API key only when a new one is typed', async () => {
    const ctx = makeHost({ providers: { acme: existing } });
    const result = runCustomProviderEditWizard(ctx.host as never, 'acme');
    await flush();

    ctx.lastPanel().handleInput(KEY_ENTER); // type
    await flush();
    ctx.lastPanel().handleInput(KEY_ENTER); // base URL
    await flush();
    typeText(ctx.lastPanel(), 'sk-new');
    ctx.lastPanel().handleInput(KEY_ENTER);
    await flush();
    ctx.lastPanel().handleInput(KEY_DOWN); // skip verify
    ctx.lastPanel().handleInput(KEY_ENTER);

    await expect(result).resolves.toBe('updated');
    expect(ctx.host.harness.setProvider).toHaveBeenCalledWith(
      'acme',
      expect.objectContaining({ apiKey: 'sk-new', baseUrl: 'https://api.acme.test/v1' }),
    );
  });

  it('clears the base URL when the type changes to anthropic and the field is emptied', async () => {
    const ctx = makeHost({ providers: { acme: existing } });
    const result = runCustomProviderEditWizard(ctx.host as never, 'acme');
    await flush();

    // Type step: openai is prefilled (index 2) — Up once lands on anthropic.
    ctx.lastPanel().handleInput(KEY_UP);
    ctx.lastPanel().handleInput(KEY_ENTER);
    await flush();

    // Anthropic allows an empty URL (= official default); clear the prefill.
    for (let i = 0; i < 30; i++) ctx.lastPanel().handleInput(KEY_BACKSPACE);
    ctx.lastPanel().handleInput(KEY_ENTER);
    await flush();

    ctx.lastPanel().handleInput(KEY_ENTER); // API key — keep
    await flush();
    ctx.lastPanel().handleInput(KEY_DOWN); // skip verify
    ctx.lastPanel().handleInput(KEY_ENTER);

    await expect(result).resolves.toBe('updated');
    const entry = (ctx.host.harness.setProvider as ReturnType<typeof vi.fn>).mock
      .calls[0]![1] as Record<string, unknown>;
    expect(entry).toEqual({
      type: 'anthropic',
      apiKey: 'sk-old',
      customHeaders: { 'x-trace': '1' },
    });
    expect('baseUrl' in entry).toBe(false);
  });

  it('guards managed providers without mounting any panel', async () => {
    const ctx = makeHost({
      providers: { 'managed:kimi-code': { type: 'kimi', oauth: { storage: 'file', key: 'k' } } },
    });
    const result = runCustomProviderEditWizard(ctx.host as never, 'managed:kimi-code');
    await expect(result).resolves.toBeUndefined();
    expect(ctx.host.showError).toHaveBeenCalledWith(
      expect.stringContaining('only custom providers'),
    );
    expect(ctx.panels).toHaveLength(0);
  });

  it('guards providers whose API type the wizard cannot represent', async () => {
    const ctx = makeHost({ providers: { acme: { type: 'google-genai', apiKey: 'k' } } });
    const result = runCustomProviderEditWizard(ctx.host as never, 'acme');
    await expect(result).resolves.toBeUndefined();
    expect(ctx.host.showError).toHaveBeenCalledWith(expect.stringContaining('google-genai'));
    expect(ctx.panels).toHaveLength(0);
  });

  it('reports a vanished provider', async () => {
    const ctx = makeHost();
    const result = runCustomProviderEditWizard(ctx.host as never, 'ghost');
    await expect(result).resolves.toBeUndefined();
    expect(ctx.host.showError).toHaveBeenCalledWith(expect.stringContaining('no longer exists'));
  });

  it('aborts on Esc at the type step without writing', async () => {
    const ctx = makeHost({ providers: { acme: existing } });
    const result = runCustomProviderEditWizard(ctx.host as never, 'acme');
    await flush();
    ctx.lastPanel().handleInput(KEY_ESC);
    await expect(result).resolves.toBeUndefined();
    expect(ctx.host.harness.setProvider).not.toHaveBeenCalled();
  });
});

describe('buildCustomProviderEntry', () => {
  it('builds a fresh entry without optional fields', () => {
    expect(buildCustomProviderEntry(undefined, { type: 'anthropic', apiKey: 'k' })).toEqual({
      type: 'anthropic',
      apiKey: 'k',
    });
  });

  it('carries over unknown base fields and drops cleared ones', () => {
    const base = {
      type: 'openai',
      baseUrl: 'https://old/v1',
      apiKey: 'old',
      customHeaders: { a: 'b' },
    } as const;
    expect(
      buildCustomProviderEntry(base as never, { type: 'anthropic', apiKey: 'old' }),
    ).toEqual({ type: 'anthropic', apiKey: 'old', customHeaders: { a: 'b' } });
  });
});

describe('/provider edit integration', () => {
  it('opens the edit wizard from the manager via E and returns to the manager on abort', async () => {
    const ctx = makeHost({
      providers: { acme: { type: 'openai', baseUrl: 'https://x/v1', apiKey: 'k' } },
    });
    await handleProviderCommand(ctx.host as never);

    // The manager marks the custom provider with a badge; E opens the wizard.
    expect(ctx.panelText()).toContain('[custom]');
    ctx.lastPanel().handleInput('e');
    await flush();
    expect(ctx.panelText()).toContain('Select API type');

    // Esc aborts the wizard; the provider manager is reopened.
    ctx.lastPanel().handleInput(KEY_ESC);
    await flush();
    expect(ctx.panelText()).toContain('Providers');
    expect(ctx.panelText()).toContain('[custom]');
  });
});
