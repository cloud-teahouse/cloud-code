/**
 * Custom model manage flows through the /model picker: Alt+E opens the edit
 * wizard, Alt+D arms the inline delete confirmation (with impact lines), the
 * built-in/managed guard fires on non-custom rows, and deleting the active
 * model switches the session to a surviving fallback.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelAlias } from '@cloud-code/sdk';

import { handleModelCommand } from '#/tui/commands/config';
import { setLocalePreference } from '#/tui/i18n';

const ANSI = /\[[0-9;]*m/g;
const strip = (s: string): string => s.replaceAll(ANSI, '');

const ESC = String.fromCodePoint(27);
const KEY_ENTER = '\r';
const KEY_DOWN = `${ESC}[B`;
const KEY_ESC = ESC;
const KEY_ALT_E = `${ESC}e`;
const KEY_ALT_D = `${ESC}d`;

interface FakeConfig {
  providers: Record<string, unknown>;
  models: Record<string, unknown>;
  defaultModel?: string;
}

function makeHost(initial: FakeConfig, options: { activeModel?: string; withSession?: boolean } = {}) {
  let persisted: FakeConfig = structuredClone(initial);
  const panels: Array<{ handleInput: (data: string) => void; render: (width: number) => string[] }> =
    [];
  const sessionState = { model: options.activeModel ?? '' };
  const session =
    options.withSession === false
      ? undefined
      : {
          setModel: vi.fn(async (alias: string) => {
            sessionState.model = alias;
          }),
          getStatus: vi.fn(async () => ({
            model: sessionState.model,
            thinkingEffort: 'off' as const,
          })),
        };

  const host = {
    state: {
      transcriptEntries: [],
      appState: {
        model: options.activeModel ?? '',
        thinkingEffort: 'off',
        streamingPhase: 'idle',
        availableProviders: persisted.providers,
        availableModels: persisted.models,
      },
      ui: { requestRender: vi.fn() },
    },
    session,
    harness: {
      getConfig: vi.fn(async () => structuredClone(persisted)),
      setConfig: vi.fn(async (patch: Record<string, unknown>) => {
        persisted = { ...persisted, ...patch } as FakeConfig;
        return structuredClone(persisted);
      }),
      removeModel: vi.fn(async (alias: string) => {
        delete persisted.models[alias];
        if (persisted.defaultModel === alias) persisted.defaultModel = undefined;
        return structuredClone(persisted);
      }),
      setModelAlias: vi.fn(async (alias: string, entry: unknown) => {
        persisted.models[alias] = structuredClone(entry);
        return structuredClone(persisted);
      }),
    },
    authFlow: {
      refreshOAuthProviderModels: vi.fn(async () => undefined),
      refreshAvailableModels: vi.fn(async () => {
        host.state.appState.availableProviders = persisted.providers;
        host.state.appState.availableModels = persisted.models;
      }),
      clearActiveSessionAfterLogout: vi.fn(async () => {
        host.state.appState.model = '';
      }),
    },
    mountEditorReplacement: vi.fn((panel: (typeof panels)[number]) => {
      panels.push(panel);
      return { id: panels.length };
    }),
    restoreEditor: vi.fn(),
    setAppState: vi.fn((patch: Record<string, unknown>) => {
      Object.assign(host.state.appState, patch);
    }),
    showStatus: vi.fn(),
    showError: vi.fn(),
    showNotice: vi.fn(),
  };

  return {
    host,
    panels,
    session,
    current: () => persisted,
    lastPanel: () => panels[panels.length - 1]!,
    panelText: () => strip(panels[panels.length - 1]!.render(110).join('\n')),
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 30; i++) {
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
  }
}

const customProviders = { myprov: { type: 'openai', baseUrl: 'https://x/v1', apiKey: 'k' } };

function customModel(providerId: string, modelId: string, extra: Record<string, unknown> = {}) {
  return {
    provider: providerId,
    model: modelId,
    maxContextSize: 128_000,
    displayName: modelId,
    capabilities: ['tool_use'],
    ...extra,
  } as unknown as ModelAlias;
}

beforeEach(() => {
  vi.clearAllMocks();
  setLocalePreference('en');
});

describe('/model picker manage keys', () => {
  it('badges custom models and shows the manage hints', async () => {
    const ctx = makeHost(
      {
        providers: { ...customProviders, 'managed:kimi-code': { type: 'kimi' } },
        models: {
          'myprov/m1': customModel('myprov', 'm1'),
          'managed:kimi-code/k2': customModel('managed:kimi-code', 'k2'),
        },
      },
      { activeModel: 'myprov/m1' },
    );
    const done = handleModelCommand(ctx.host as never, '');
    await flush();

    const text = ctx.panelText();
    expect(text).toContain('[custom]');
    expect(text).toContain('Alt+E edit');
    expect(text).toContain('Alt+D delete');
    // The managed model row itself carries no badge.
    const k2Line = text.split('\n').find((line) => line.includes('k2'));
    expect(k2Line).toBeDefined();
    expect(k2Line).not.toContain('[custom]');
    ctx.lastPanel().handleInput(KEY_ESC);
    await done;
  });

  it('deletes a custom model via Alt+D + y, showing the impact in the confirm', async () => {
    const ctx = makeHost(
      {
        providers: structuredClone(customProviders),
        models: { 'myprov/m1': customModel('myprov', 'm1'), 'myprov/m2': customModel('myprov', 'm2') },
        defaultModel: 'myprov/m1',
      },
      { activeModel: 'myprov/m1', withSession: false },
    );
    const done = handleModelCommand(ctx.host as never, '');
    await flush();

    // The current model row is selected; Alt+D arms the inline confirm.
    ctx.lastPanel().handleInput(KEY_ALT_D);
    const confirmText = ctx.panelText();
    expect(confirmText).toContain('Delete model "myprov/m1"?');
    expect(confirmText).toContain('current model');
    expect(confirmText).toContain('m2'); // fallback named in the impact
    expect(confirmText).toContain('default model');

    ctx.lastPanel().handleInput('y');
    await flush();

    expect(ctx.host.harness.removeModel).toHaveBeenCalledWith('myprov/m1');
    expect(ctx.current().models['myprov/m1']).toBeUndefined();
    // The active model was repaired onto the fallback, persisted as default.
    expect(ctx.host.state.appState.model).toBe('myprov/m2');
    expect(ctx.current().defaultModel).toBe('myprov/m2');
    expect(ctx.host.showStatus).toHaveBeenCalledWith(
      expect.stringContaining('deleted'),
      'success',
    );
    // The picker reopened on the fallback row (display names, not aliases).
    expect(ctx.panelText()).toContain('m2');
    expect(ctx.panelText()).not.toContain('m1');
    ctx.lastPanel().handleInput(KEY_ESC);
    await done;
  });

  it('switches the live session to the fallback when the active model is deleted', async () => {
    const ctx = makeHost(
      {
        providers: structuredClone(customProviders),
        models: { 'myprov/m1': customModel('myprov', 'm1'), 'myprov/m2': customModel('myprov', 'm2') },
      },
      { activeModel: 'myprov/m1' },
    );
    const done = handleModelCommand(ctx.host as never, '');
    await flush();

    ctx.lastPanel().handleInput(KEY_ALT_D);
    ctx.lastPanel().handleInput('y');
    await flush();

    expect(ctx.session?.setModel).toHaveBeenCalledWith('myprov/m2');
    expect(ctx.host.showStatus).toHaveBeenCalledWith(
      expect.stringContaining('switched to'),
      'warning',
    );
    ctx.lastPanel().handleInput(KEY_ESC);
    await done;
  });

  it('disarms the confirm on n without deleting', async () => {
    const ctx = makeHost(
      {
        providers: structuredClone(customProviders),
        models: { 'myprov/m1': customModel('myprov', 'm1') },
      },
      { activeModel: 'myprov/m1' },
    );
    const done = handleModelCommand(ctx.host as never, '');
    await flush();

    ctx.lastPanel().handleInput(KEY_ALT_D);
    expect(ctx.panelText()).toContain('Delete model');
    ctx.lastPanel().handleInput('n');
    expect(ctx.panelText()).not.toContain('Delete model');
    expect(ctx.host.harness.removeModel).not.toHaveBeenCalled();
    ctx.lastPanel().handleInput(KEY_ESC);
    await done;
  });

  it('guards Alt+D and Alt+E on managed models (picker stays open, nothing is written)', async () => {
    const ctx = makeHost(
      {
        providers: { 'managed:kimi-code': { type: 'kimi' } },
        models: { 'managed:kimi-code/k2': customModel('managed:kimi-code', 'k2') },
      },
      { activeModel: 'managed:kimi-code/k2' },
    );
    const done = handleModelCommand(ctx.host as never, '');
    await flush();

    const panelsBefore = ctx.panels.length;
    ctx.lastPanel().handleInput(KEY_ALT_D);
    await flush();
    expect(ctx.host.showStatus).toHaveBeenCalledWith(
      expect.stringContaining('only custom models'),
      'warning',
    );
    expect(ctx.host.harness.removeModel).not.toHaveBeenCalled();
    expect(ctx.panels.length).toBe(panelsBefore);

    ctx.lastPanel().handleInput(KEY_ALT_E);
    await flush();
    expect(ctx.panels.length).toBe(panelsBefore);
    expect(ctx.host.showStatus).toHaveBeenCalledTimes(2);
    ctx.lastPanel().handleInput(KEY_ESC);
    await done;
  });

  it('opens the edit wizard via Alt+E and returns to the picker on abort', async () => {
    const ctx = makeHost(
      {
        providers: structuredClone(customProviders),
        models: { 'myprov/m1': customModel('myprov', 'm1') },
      },
      { activeModel: 'myprov/m1' },
    );
    const done = handleModelCommand(ctx.host as never, '');
    await flush();

    ctx.lastPanel().handleInput(KEY_ALT_E);
    await flush();
    expect(ctx.panelText()).toContain('Display name');

    ctx.lastPanel().handleInput(KEY_ESC);
    await flush();
    // Aborted — the picker is back on the same model, nothing was written.
    expect(ctx.panelText()).toContain('Select a model');
    expect(ctx.panelText()).toContain('m1');
    expect(ctx.host.harness.setModelAlias).not.toHaveBeenCalled();
    ctx.lastPanel().handleInput(KEY_ESC);
    await done;
  });

  it('moves the selection with arrows before acting on another row', async () => {
    const ctx = makeHost(
      {
        providers: structuredClone(customProviders),
        models: { 'myprov/m1': customModel('myprov', 'm1'), 'myprov/m2': customModel('myprov', 'm2') },
      },
      { activeModel: 'myprov/m1' },
    );
    const done = handleModelCommand(ctx.host as never, '');
    await flush();

    // m1 is selected (current); move down to m2 and delete that instead.
    ctx.lastPanel().handleInput(KEY_DOWN);
    ctx.lastPanel().handleInput(KEY_ALT_D);
    expect(ctx.panelText()).toContain('Delete model "myprov/m2"?');
    ctx.lastPanel().handleInput('y');
    await flush();

    expect(ctx.host.harness.removeModel).toHaveBeenCalledWith('myprov/m2');
    // The active model was NOT the deleted one — no fallback switch.
    expect(ctx.host.state.appState.model).toBe('myprov/m1');
    expect(ctx.session?.setModel).not.toHaveBeenCalled();
    ctx.lastPanel().handleInput(KEY_ESC);
    await done;
  });
});
