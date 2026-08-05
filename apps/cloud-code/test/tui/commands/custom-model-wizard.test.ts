/**
 * Custom model wizard tests — drives the mounted components through
 * handleInput: provider picker (with a "new provider…" chain into the custom
 * provider wizard) → model id → display name → context window → thinking
 * efforts multi-select → capabilities multi-select → setConfig.
 *
 * The persisted alias shape is asserted exhaustively (toEqual) against the
 * fields of ModelAliasBaseSchema — the same shape catalog imports produce, so
 * custom models work for sub-agents (profile.model / secondary_model)
 * without any extra wiring.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { handleModelCommand } from '#/tui/commands/config';
import {
  buildCustomModelEntry,
  runCustomModelEditWizard,
  runCustomModelWizard,
} from '#/tui/commands/custom-model-wizard';
import { setLocalePreference } from '#/tui/i18n';

const ANSI = /\[[0-9;]*m/g;
const strip = (s: string): string => s.replaceAll(ANSI, '');

const ESC = String.fromCodePoint(27);
const KEY_ENTER = '\r';
const KEY_DOWN = `${ESC}[B`;
const KEY_BACKSPACE = '\x7f';
const KEY_ESC = ESC;
const KEY_SPACE = ' ';

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
      transcriptEntries: [],
      appState: {
        model: '',
        thinkingEffort: 'off',
        streamingPhase: 'idle',
        availableProviders: persisted.providers,
        availableModels: persisted.models,
      },
      ui: { requestRender: vi.fn() },
    },
    session: undefined,
    harness: {
      getConfig: vi.fn(async () => structuredClone(persisted)),
      setConfig: vi.fn(async (patch: Record<string, unknown>) => {
        setConfigCalls.push(structuredClone(patch));
        persisted = { ...persisted, ...patch } as FakeConfig;
        return structuredClone(persisted);
      }),
      // Wholesale single-alias write used by the edit wizard.
      setModelAlias: vi.fn(async (alias: string, entry: unknown) => {
        persisted.models[alias] = structuredClone(entry);
        return structuredClone(persisted);
      }),
    },
    authFlow: {
      // Mirrors the real controller: pushes the freshly persisted config into
      // appState, so the post-wizard model picker sees the new alias.
      refreshConfigAfterLogin: vi.fn(async () => {
        host.state.appState.availableProviders = persisted.providers;
        host.state.appState.availableModels = persisted.models;
      }),
      refreshAvailableModels: vi.fn(async () => {
        host.state.appState.availableProviders = persisted.providers;
        host.state.appState.availableModels = persisted.models;
      }),
      refreshOAuthProviderModels: vi.fn(async () => undefined),
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

function typeText(panel: { handleInput: (data: string) => void }, text: string): void {
  for (const ch of text) panel.handleInput(ch);
}

/** Drives the model wizard from the model-id step onward, accepting all
 * prefills/defaults except where overridden. */
async function finishWizardFromModelId(
  ctx: ReturnType<typeof makeHost>,
  modelId: string,
): Promise<void> {
  typeText(ctx.lastPanel(), modelId);
  ctx.lastPanel().handleInput(KEY_ENTER);
  await flush();
  ctx.lastPanel().handleInput(KEY_ENTER); // display name — accept model id
  await flush();
  ctx.lastPanel().handleInput(KEY_ENTER); // context window — accept prefill
  await flush();
  ctx.lastPanel().handleInput(KEY_ENTER); // efforts — accept defaults
  await flush();
  ctx.lastPanel().handleInput(KEY_ENTER); // capabilities — accept defaults
  await flush();
}

beforeEach(() => {
  vi.clearAllMocks();
  setLocalePreference('en');
});

describe('runCustomModelWizard', () => {
  it('walks the full flow and persists a ModelAliasBaseSchema-shaped alias', async () => {
    const ctx = makeHost({
      providers: { myprov: { type: 'openai_responses', baseUrl: 'https://x/v1', apiKey: 'k' } },
    });
    const result = runCustomModelWizard(ctx.host as never);
    await flush();

    // a. Provider — first option is the only existing provider.
    ctx.lastPanel().handleInput(KEY_ENTER);
    await flush();

    // b–f. Model id, then defaults.
    typeText(ctx.lastPanel(), 'gpt-5.5-custom');
    ctx.lastPanel().handleInput(KEY_ENTER);
    await flush();
    ctx.lastPanel().handleInput(KEY_ENTER); // display name
    await flush();
    ctx.lastPanel().handleInput(KEY_ENTER); // context window (400k prefill)
    await flush();
    ctx.lastPanel().handleInput(KEY_ENTER); // efforts (low/medium/high)
    await flush();
    // capabilities: add image_in (second row) to the default tool_use.
    ctx.lastPanel().handleInput(KEY_DOWN);
    ctx.lastPanel().handleInput(KEY_SPACE);
    ctx.lastPanel().handleInput(KEY_ENTER);
    await flush();

    await expect(result).resolves.toBe('myprov/gpt-5.5-custom');

    // Exact shape — every field of ModelAliasBaseSchema the wizard writes,
    // nothing else.
    expect(ctx.setConfigCalls).toHaveLength(1);
    expect(ctx.setConfigCalls[0]).toEqual({
      models: {
        'myprov/gpt-5.5-custom': {
          provider: 'myprov',
          model: 'gpt-5.5-custom',
          maxContextSize: 400_000,
          displayName: 'gpt-5.5-custom',
          capabilities: ['tool_use', 'image_in', 'thinking'],
          supportEfforts: ['low', 'medium', 'high'],
        },
      },
    });
    expect(ctx.host.authFlow.refreshConfigAfterLogin).toHaveBeenCalledOnce();
    expect(ctx.host.showStatus).toHaveBeenCalledWith(
      expect.stringContaining('myprov/gpt-5.5-custom'),
      'success',
    );
  });

  it('defaults kimi-type models to all effort levels and maps "none" to offEffort', async () => {
    const ctx = makeHost({
      providers: { moonshot: { type: 'kimi', baseUrl: 'https://x/v1', apiKey: 'k' } },
    });
    const result = runCustomModelWizard(ctx.host as never);
    await flush();

    ctx.lastPanel().handleInput(KEY_ENTER); // provider
    await flush();
    await finishWizardFromModelId(ctx, 'k2-custom');

    await expect(result).resolves.toBe('moonshot/k2-custom');
    expect(ctx.current().models['moonshot/k2-custom']).toEqual({
      provider: 'moonshot',
      model: 'k2-custom',
      maxContextSize: 262_144,
      displayName: 'k2-custom',
      capabilities: ['tool_use', 'thinking'],
      supportEfforts: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
      offEffort: 'none',
    });
  });

  it('appends custom effort names (deduped, lowercase) via the in-picker custom row', async () => {
    const ctx = makeHost({
      providers: { myprov: { type: 'openai', baseUrl: 'https://x/v1', apiKey: 'k' } },
    });
    const result = runCustomModelWizard(ctx.host as never);
    await flush();

    ctx.lastPanel().handleInput(KEY_ENTER); // provider
    await flush();
    typeText(ctx.lastPanel(), 'gpt-x');
    ctx.lastPanel().handleInput(KEY_ENTER);
    await flush();
    ctx.lastPanel().handleInput(KEY_ENTER); // display name
    await flush();
    ctx.lastPanel().handleInput(KEY_ENTER); // context
    await flush();
    // The custom action row sits right below the 7 preset effort rows.
    for (let i = 0; i < 7; i++) ctx.lastPanel().handleInput(KEY_DOWN);
    expect(ctx.panelText()).toContain('Custom effort names');
    ctx.lastPanel().handleInput(KEY_ENTER); // fire the custom row
    await flush();
    typeText(ctx.lastPanel(), 'Deep, turbo, deep, low');
    ctx.lastPanel().handleInput(KEY_ENTER);
    await flush();
    // Back in the picker: built-ins still checked, new names injected + checked.
    expect(ctx.panelText()).toContain('deep');
    expect(ctx.panelText()).toContain('turbo');
    ctx.lastPanel().handleInput(KEY_ENTER); // submit efforts
    await flush();
    ctx.lastPanel().handleInput(KEY_ENTER); // capabilities
    await flush();

    await expect(result).resolves.toBe('myprov/gpt-x');
    expect(ctx.current().models['myprov/gpt-x']?.['supportEfforts' as never]).toEqual([
      'low',
      'medium',
      'high',
      'deep',
      'turbo',
    ]);
  });

  it('rejects invalid custom effort names until corrected', async () => {
    const ctx = makeHost({
      providers: { myprov: { type: 'openai', baseUrl: 'https://x/v1', apiKey: 'k' } },
    });
    const result = runCustomModelWizard(ctx.host as never);
    await flush();

    ctx.lastPanel().handleInput(KEY_ENTER); // provider
    await flush();
    typeText(ctx.lastPanel(), 'gpt-x');
    ctx.lastPanel().handleInput(KEY_ENTER);
    await flush();
    ctx.lastPanel().handleInput(KEY_ENTER); // display name
    await flush();
    ctx.lastPanel().handleInput(KEY_ENTER); // context
    await flush();
    for (let i = 0; i < 7; i++) ctx.lastPanel().handleInput(KEY_DOWN);
    ctx.lastPanel().handleInput(KEY_ENTER); // fire the custom row
    await flush();
    typeText(ctx.lastPanel(), 'bad name!');
    ctx.lastPanel().handleInput(KEY_ENTER);
    await flush();
    expect(ctx.panelText()).toContain('Lowercase letters, digits, - and _ only');
    for (let i = 0; i < 9; i++) ctx.lastPanel().handleInput(KEY_BACKSPACE);
    typeText(ctx.lastPanel(), 'ok_name');
    ctx.lastPanel().handleInput(KEY_ENTER);
    await flush();
    ctx.lastPanel().handleInput(KEY_ENTER); // submit efforts
    await flush();
    ctx.lastPanel().handleInput(KEY_ENTER); // capabilities
    await flush();

    await expect(result).resolves.toBe('myprov/gpt-x');
    expect(ctx.current().models['myprov/gpt-x']?.['supportEfforts' as never]).toContain('ok_name');
  });

  it('writes no thinking fields when every effort level is deselected', async () => {
    const ctx = makeHost({
      providers: { gw: { type: 'openai', baseUrl: 'https://x/v1', apiKey: 'k' } },
    });
    const result = runCustomModelWizard(ctx.host as never);
    await flush();

    ctx.lastPanel().handleInput(KEY_ENTER); // provider
    await flush();
    typeText(ctx.lastPanel(), 'plain-model');
    ctx.lastPanel().handleInput(KEY_ENTER);
    await flush();
    ctx.lastPanel().handleInput(KEY_ENTER); // display name
    await flush();
    ctx.lastPanel().handleInput(KEY_ENTER); // context
    await flush();
    // Deselect the three preselected efforts (low/medium/high at rows 2–4):
    // toggle rows 2, 3, 4 off (row 0 = none, row 1 = minimal — not selected).
    ctx.lastPanel().handleInput(KEY_DOWN);
    ctx.lastPanel().handleInput(KEY_DOWN);
    ctx.lastPanel().handleInput(KEY_SPACE); // low off
    ctx.lastPanel().handleInput(KEY_DOWN);
    ctx.lastPanel().handleInput(KEY_SPACE); // medium off
    ctx.lastPanel().handleInput(KEY_DOWN);
    ctx.lastPanel().handleInput(KEY_SPACE); // high off
    ctx.lastPanel().handleInput(KEY_ENTER);
    await flush();
    ctx.lastPanel().handleInput(KEY_ENTER); // efforts — submit
    await flush();
    ctx.lastPanel().handleInput(KEY_ENTER); // capabilities default tool_use
    await flush();

    await expect(result).resolves.toBe('gw/plain-model');
    expect(ctx.current().models['gw/plain-model']).toEqual({
      provider: 'gw',
      model: 'plain-model',
      maxContextSize: 128_000,
      displayName: 'plain-model',
      capabilities: ['tool_use'],
    });
  });

  it('rejects a duplicate alias and aborts on Esc', async () => {
    const ctx = makeHost({
      providers: { myprov: { type: 'openai', apiKey: 'k' } },
      models: {
        'myprov/taken': {
          provider: 'myprov',
          model: 'taken',
          maxContextSize: 1024,
        },
      },
    });
    const result = runCustomModelWizard(ctx.host as never);
    await flush();

    ctx.lastPanel().handleInput(KEY_ENTER); // provider
    await flush();

    typeText(ctx.lastPanel(), 'taken');
    const panelsBefore = ctx.panels.length;
    ctx.lastPanel().handleInput(KEY_ENTER);
    await flush();
    expect(ctx.panels.length).toBe(panelsBefore);
    expect(ctx.panelText()).toContain('already exists');

    ctx.lastPanel().handleInput(KEY_ESC); // back to the provider step
    await flush();
    ctx.lastPanel().handleInput(KEY_ESC); // abort at the first step
    await expect(result).resolves.toBeUndefined();
    expect(ctx.setConfigCalls).toHaveLength(0);
  });

  it('rejects a non-numeric context window and accepts the corrected value', async () => {
    const ctx = makeHost({
      providers: { myprov: { type: 'openai', apiKey: 'k' } },
    });
    const result = runCustomModelWizard(ctx.host as never);
    await flush();

    ctx.lastPanel().handleInput(KEY_ENTER); // provider
    await flush();
    typeText(ctx.lastPanel(), 'm1');
    ctx.lastPanel().handleInput(KEY_ENTER);
    await flush();
    ctx.lastPanel().handleInput(KEY_ENTER); // display name
    await flush();

    // Corrupt the prefilled context window: append "abc" → invalid.
    typeText(ctx.lastPanel(), 'abc');
    const panelsBefore = ctx.panels.length;
    ctx.lastPanel().handleInput(KEY_ENTER);
    await flush();
    expect(ctx.panels.length).toBe(panelsBefore);
    expect(ctx.panelText()).toContain('positive integer');

    // Fix it: backspace ×3 removes "abc", then enter a custom window.
    ctx.lastPanel().handleInput(KEY_BACKSPACE);
    ctx.lastPanel().handleInput(KEY_BACKSPACE);
    ctx.lastPanel().handleInput(KEY_BACKSPACE);
    for (let i = 0; i < 6; i++) ctx.lastPanel().handleInput(KEY_BACKSPACE);
    typeText(ctx.lastPanel(), '64000');
    ctx.lastPanel().handleInput(KEY_ENTER);
    await flush();
    ctx.lastPanel().handleInput(KEY_ENTER); // efforts
    await flush();
    ctx.lastPanel().handleInput(KEY_ENTER); // efforts — submit
    await flush();
    ctx.lastPanel().handleInput(KEY_ENTER); // capabilities
    await flush();

    await expect(result).resolves.toBe('myprov/m1');
    expect(ctx.current().models['myprov/m1']?.['maxContextSize' as never]).toBe(64_000);
  });

  it('uses a custom display name when one is typed over the prefill', async () => {
    const ctx = makeHost({
      providers: { myprov: { type: 'openai', apiKey: 'k' } },
    });
    const result = runCustomModelWizard(ctx.host as never);
    await flush();

    ctx.lastPanel().handleInput(KEY_ENTER); // provider
    await flush();
    typeText(ctx.lastPanel(), 'm1');
    ctx.lastPanel().handleInput(KEY_ENTER);
    await flush();
    // Display name prefill is the model id ("m1"); clear it, type a name.
    ctx.lastPanel().handleInput(KEY_BACKSPACE);
    ctx.lastPanel().handleInput(KEY_BACKSPACE);
    typeText(ctx.lastPanel(), 'My Model');
    ctx.lastPanel().handleInput(KEY_ENTER);
    await flush();
    await finishRest(ctx);
    await expect(result).resolves.toBe('myprov/m1');
    expect(ctx.current().models['myprov/m1']?.['displayName' as never]).toBe('My Model');
  });

  it('chains into the provider wizard via "new provider…" and returns with it preselected', async () => {
    const ctx = makeHost(); // no providers configured
    const result = runCustomModelWizard(ctx.host as never);
    await flush();

    // The provider step offers only the new-provider entry.
    expect(ctx.panelText()).toContain('New provider');
    ctx.lastPanel().handleInput(KEY_ENTER);
    await flush();

    // Custom provider wizard: kimi → url → key → id → skip verify.
    ctx.lastPanel().handleInput(KEY_ENTER); // kimi
    await flush();
    typeText(ctx.lastPanel(), 'https://kimi.test/v1');
    ctx.lastPanel().handleInput(KEY_ENTER);
    await flush();
    typeText(ctx.lastPanel(), 'sk-kimi');
    ctx.lastPanel().handleInput(KEY_ENTER);
    await flush();
    ctx.lastPanel().handleInput(KEY_ENTER); // id (kimi.test → reserved, suggests kimi-custom)
    await flush();
    ctx.lastPanel().handleInput(KEY_DOWN); // skip connectivity
    ctx.lastPanel().handleInput(KEY_ENTER);
    await flush();

    // Back in the model wizard at the model-id step (provider preselected).
    await finishWizardFromModelId(ctx, 'k2');
    await expect(result).resolves.toBe('kimi-custom/k2');
    expect(ctx.current().providers['kimi-custom']).toEqual({
      type: 'kimi',
      baseUrl: 'https://kimi.test/v1',
      apiKey: 'sk-kimi',
    });
    expect(ctx.current().models['kimi-custom/k2']).toBeDefined();
  });

  it('aborts on Esc at the provider step without writing config', async () => {
    const ctx = makeHost({
      providers: { myprov: { type: 'openai', apiKey: 'k' } },
    });
    const result = runCustomModelWizard(ctx.host as never);
    await flush();

    ctx.lastPanel().handleInput(KEY_ESC);
    await expect(result).resolves.toBeUndefined();
    expect(ctx.setConfigCalls).toHaveLength(0);
  });
});

async function finishRest(ctx: ReturnType<typeof makeHost>): Promise<void> {
  ctx.lastPanel().handleInput(KEY_ENTER); // context
  await flush();
  ctx.lastPanel().handleInput(KEY_ENTER); // efforts
  await flush();
  ctx.lastPanel().handleInput(KEY_ENTER); // capabilities
  await flush();
}

describe('/model add', () => {
  it('starts the wizard on the direct argument and reopens the picker on the new alias', async () => {
    const ctx = makeHost({
      providers: { myprov: { type: 'openai', apiKey: 'k' } },
    });
    const done = handleModelCommand(ctx.host as never, 'add');
    await flush();

    // The provider step is the first mounted panel.
    expect(ctx.panelText()).toContain('Select a provider for the new model');
    ctx.lastPanel().handleInput(KEY_ENTER);
    await flush();
    await finishWizardFromModelId(ctx, 'm1');
    await done;
    await flush();

    // After the wizard, the model picker reopened with the new alias visible.
    const pickerText = ctx.panelText();
    expect(pickerText).toContain('m1');
    expect(pickerText).toContain('myprov');
    expect(ctx.host.state.appState.availableModels['myprov/m1']).toBeDefined();
  });

  it('offers an "Add custom model" row in the picker that starts the wizard', async () => {
    const ctx = makeHost({
      providers: { myprov: { type: 'openai', apiKey: 'k' } },
      models: {
        'myprov/m0': { provider: 'myprov', model: 'm0', maxContextSize: 1024 },
      },
    });
    ctx.host.state.appState.model = 'myprov/m0';
    const done = handleModelCommand(ctx.host as never, '');
    await flush();

    // The picker is up; the add row is the last row of the "All" tab.
    const pickerText = ctx.panelText();
    expect(pickerText).toContain('Add custom model');

    // Move past the single model row onto the add row, Enter.
    ctx.lastPanel().handleInput(KEY_DOWN);
    ctx.lastPanel().handleInput(KEY_ENTER);
    await flush();

    // The wizard's provider step opened.
    expect(ctx.panelText()).toContain('Select a provider for the new model');
    ctx.lastPanel().handleInput(KEY_ESC);
    await done;
    await flush();
  });
});

describe('runCustomModelEditWizard', () => {
  const customProviders = { myprov: { type: 'openai', baseUrl: 'https://x/v1', apiKey: 'k' } };
  const existingModel = {
    provider: 'myprov',
    model: 'm1',
    maxContextSize: 128_000,
    displayName: 'Old Name',
    capabilities: ['tool_use', 'thinking'],
    supportEfforts: ['low', 'high'],
    maxInputSize: 64_000,
  };

  function editHost(modelEntry: Record<string, unknown> = existingModel) {
    return makeHost({
      providers: structuredClone(customProviders),
      models: { 'myprov/m1': structuredClone(modelEntry) },
    });
  }

  it('prefills every step, persists changed fields, and keeps fields the wizard does not own', async () => {
    const ctx = editHost();
    ctx.host.state.appState.model = 'myprov/m1';
    const result = runCustomModelEditWizard(ctx.host as never, 'myprov/m1');
    await flush();

    // Display name — prefilled with "Old Name"; retype.
    for (let i = 0; i < 12; i++) ctx.lastPanel().handleInput(KEY_BACKSPACE);
    typeText(ctx.lastPanel(), 'New Name');
    ctx.lastPanel().handleInput(KEY_ENTER);
    await flush();

    // Context window — prefilled with 128000; retype.
    for (let i = 0; i < 8; i++) ctx.lastPanel().handleInput(KEY_BACKSPACE);
    typeText(ctx.lastPanel(), '64000');
    ctx.lastPanel().handleInput(KEY_ENTER);
    await flush();

    ctx.lastPanel().handleInput(KEY_ENTER); // efforts — accept prefilled low+high
    await flush();
    ctx.lastPanel().handleInput(KEY_ENTER); // capabilities — accept prefilled tool_use
    await flush();

    await expect(result).resolves.toBe('updated');
    expect(ctx.host.harness.setModelAlias).toHaveBeenCalledWith('myprov/m1', {
      provider: 'myprov',
      model: 'm1',
      maxContextSize: 64_000,
      displayName: 'New Name',
      capabilities: ['tool_use', 'thinking'],
      supportEfforts: ['low', 'high'],
      maxInputSize: 64_000,
    });
    expect(ctx.host.authFlow.refreshAvailableModels).toHaveBeenCalledOnce();
    // The edited model is the active one — the context budget is refreshed.
    expect(ctx.host.setAppState).toHaveBeenCalledWith({ maxContextTokens: 64_000 });
    expect(ctx.host.showStatus).toHaveBeenCalledWith(expect.stringContaining('updated'), 'success');
  });

  it('reports "unchanged" and writes nothing when every prefill is accepted', async () => {
    const ctx = editHost();
    const result = runCustomModelEditWizard(ctx.host as never, 'myprov/m1');
    await flush();

    ctx.lastPanel().handleInput(KEY_ENTER); // display name
    await flush();
    ctx.lastPanel().handleInput(KEY_ENTER); // context window
    await flush();
    ctx.lastPanel().handleInput(KEY_ENTER); // efforts
    await flush();
    ctx.lastPanel().handleInput(KEY_ENTER); // capabilities
    await flush();

    await expect(result).resolves.toBe('unchanged');
    expect(ctx.host.harness.setModelAlias).not.toHaveBeenCalled();
    expect(ctx.host.showStatus).toHaveBeenCalledWith(expect.stringContaining('unchanged'));
  });

  it('drops the effort fields and the derived thinking capability when all efforts are deselected', async () => {
    const ctx = editHost({
      provider: 'myprov',
      model: 'm1',
      maxContextSize: 128_000,
      displayName: 'm1',
      capabilities: ['tool_use', 'thinking'],
      supportEfforts: ['low'],
    });
    const result = runCustomModelEditWizard(ctx.host as never, 'myprov/m1');
    await flush();

    ctx.lastPanel().handleInput(KEY_ENTER); // display name
    await flush();
    ctx.lastPanel().handleInput(KEY_ENTER); // context
    await flush();
    // Efforts: only "low" (row 2) is checked — toggle it off, then submit.
    ctx.lastPanel().handleInput(KEY_DOWN);
    ctx.lastPanel().handleInput(KEY_DOWN);
    ctx.lastPanel().handleInput(KEY_SPACE);
    ctx.lastPanel().handleInput(KEY_ENTER);
    await flush();
    ctx.lastPanel().handleInput(KEY_ENTER); // capabilities
    await flush();

    await expect(result).resolves.toBe('updated');
    const entry = (ctx.host.harness.setModelAlias as ReturnType<typeof vi.fn>).mock
      .calls[0]![1] as Record<string, unknown>;
    expect(entry).toEqual({
      provider: 'myprov',
      model: 'm1',
      maxContextSize: 128_000,
      displayName: 'm1',
      capabilities: ['tool_use'],
    });
    expect('supportEfforts' in entry).toBe(false);
    expect('offEffort' in entry).toBe(false);
  });

  it('prefills custom effort names as checked options and preserves them', async () => {
    const ctx = editHost({
      provider: 'myprov',
      model: 'm1',
      maxContextSize: 128_000,
      displayName: 'm1',
      capabilities: ['tool_use', 'thinking'],
      supportEfforts: ['low', 'deep'],
    });
    const result = runCustomModelEditWizard(ctx.host as never, 'myprov/m1');
    await flush();

    ctx.lastPanel().handleInput(KEY_ENTER); // display name
    await flush();
    ctx.lastPanel().handleInput(KEY_ENTER); // context
    await flush();
    // The custom name rides along as an extra checked option.
    expect(ctx.panelText()).toContain('deep');
    ctx.lastPanel().handleInput(KEY_ENTER); // efforts — accept
    await flush();
    ctx.lastPanel().handleInput(KEY_ENTER); // capabilities
    await flush();

    // Nothing changed (displayName falls back to the model id, as persisted).
    await expect(result).resolves.toBe('unchanged');
    expect(ctx.host.harness.setModelAlias).not.toHaveBeenCalled();
  });

  it('preserves a custom offEffort wire value across the edit', async () => {
    const ctx = editHost({
      provider: 'myprov',
      model: 'm1',
      maxContextSize: 128_000,
      displayName: 'm1',
      capabilities: ['tool_use', 'thinking'],
      supportEfforts: ['low'],
      offEffort: 'nil',
    });
    const result = runCustomModelEditWizard(ctx.host as never, 'myprov/m1');
    await flush();

    // Rename to force a write; everything else stays prefilled.
    typeText(ctx.lastPanel(), 'X');
    ctx.lastPanel().handleInput(KEY_ENTER);
    await flush();
    ctx.lastPanel().handleInput(KEY_ENTER); // context
    await flush();
    ctx.lastPanel().handleInput(KEY_ENTER); // efforts (low + none checked)
    await flush();
    ctx.lastPanel().handleInput(KEY_ENTER); // capabilities
    await flush();

    await expect(result).resolves.toBe('updated');
    expect(ctx.host.harness.setModelAlias).toHaveBeenCalledWith(
      'myprov/m1',
      expect.objectContaining({ offEffort: 'nil', supportEfforts: ['low'] }),
    );
  });

  it('drops a default effort the edited model no longer supports', async () => {
    const ctx = editHost({
      provider: 'myprov',
      model: 'm1',
      maxContextSize: 128_000,
      displayName: 'm1',
      capabilities: ['tool_use', 'thinking'],
      supportEfforts: ['low', 'high'],
      defaultEffort: 'low',
    });
    const result = runCustomModelEditWizard(ctx.host as never, 'myprov/m1');
    await flush();

    ctx.lastPanel().handleInput(KEY_ENTER); // display name
    await flush();
    ctx.lastPanel().handleInput(KEY_ENTER); // context
    await flush();
    // Uncheck "low" (row 2), keep "high".
    ctx.lastPanel().handleInput(KEY_DOWN);
    ctx.lastPanel().handleInput(KEY_DOWN);
    ctx.lastPanel().handleInput(KEY_SPACE);
    ctx.lastPanel().handleInput(KEY_ENTER);
    await flush();
    ctx.lastPanel().handleInput(KEY_ENTER); // capabilities
    await flush();

    await expect(result).resolves.toBe('updated');
    const entry = (ctx.host.harness.setModelAlias as ReturnType<typeof vi.fn>).mock
      .calls[0]![1] as Record<string, unknown>;
    expect(entry['supportEfforts']).toEqual(['high']);
    expect('defaultEffort' in entry).toBe(false);
  });

  it('guards managed and dangling-provider models without mounting any panel', async () => {
    const managed = makeHost({
      providers: { 'managed:kimi-code': { type: 'kimi' } },
      models: {
        'managed:kimi-code/k2': { provider: 'managed:kimi-code', model: 'k2', maxContextSize: 1024 },
      },
    });
    const r1 = runCustomModelEditWizard(managed.host as never, 'managed:kimi-code/k2');
    await expect(r1).resolves.toBeUndefined();
    expect(managed.host.showError).toHaveBeenCalledWith(
      expect.stringContaining('only custom models'),
    );
    expect(managed.panels).toHaveLength(0);

    const dangling = makeHost({
      providers: {},
      models: { 'ghost/m1': { provider: 'ghost', model: 'm1', maxContextSize: 1024 } },
    });
    const r2 = runCustomModelEditWizard(dangling.host as never, 'ghost/m1');
    await expect(r2).resolves.toBeUndefined();
    expect(dangling.host.showError).toHaveBeenCalledWith(
      expect.stringContaining('only custom models'),
    );
  });

  it('rejects an invalid context window until corrected', async () => {
    const ctx = editHost();
    const result = runCustomModelEditWizard(ctx.host as never, 'myprov/m1');
    await flush();

    ctx.lastPanel().handleInput(KEY_ENTER); // display name
    await flush();
    // Corrupt the prefilled context window.
    typeText(ctx.lastPanel(), 'abc');
    const panelsBefore = ctx.panels.length;
    ctx.lastPanel().handleInput(KEY_ENTER);
    await flush();
    expect(ctx.panels.length).toBe(panelsBefore);
    expect(ctx.panelText()).toContain('positive integer');

    ctx.lastPanel().handleInput(KEY_ESC); // back to the display-name step
    await flush();
    ctx.lastPanel().handleInput(KEY_ESC); // abort at the first step
    await expect(result).resolves.toBeUndefined();
    expect(ctx.host.harness.setModelAlias).not.toHaveBeenCalled();
  });
});

describe('buildCustomModelEntry', () => {
  it('matches the add-wizard shape exactly (ModelAliasBaseSchema fields only)', () => {
    expect(
      buildCustomModelEntry('p', 'm', {
        displayName: 'M',
        maxContextSize: 1000,
        efforts: ['low', 'none'],
        capabilities: ['tool_use'],
      }),
    ).toEqual({
      provider: 'p',
      model: 'm',
      maxContextSize: 1000,
      displayName: 'M',
      capabilities: ['tool_use', 'thinking'],
      supportEfforts: ['low'],
      offEffort: 'none',
    });
  });

  it('writes no thinking fields when no efforts are selected', () => {
    expect(
      buildCustomModelEntry('p', 'm', {
        displayName: 'M',
        maxContextSize: 1000,
        efforts: [],
        capabilities: ['tool_use'],
      }),
    ).toEqual({ provider: 'p', model: 'm', maxContextSize: 1000, displayName: 'M', capabilities: ['tool_use'] });
  });

  it('preserves unknown base fields and hand-written capabilities on edit', () => {
    const base = {
      provider: 'p',
      model: 'm',
      maxContextSize: 1000,
      displayName: 'Old',
      capabilities: ['tool_use', 'thinking', 'always_thinking'],
      supportEfforts: ['low'],
      reasoningKey: 'reasoning',
      maxInputSize: 500,
    };
    expect(
      buildCustomModelEntry(
        'p',
        'm',
        { displayName: 'New', maxContextSize: 2000, efforts: [], capabilities: ['image_in'] },
        base as never,
      ),
    ).toEqual({
      provider: 'p',
      model: 'm',
      maxContextSize: 2000,
      displayName: 'New',
      capabilities: ['image_in', 'always_thinking'],
      reasoningKey: 'reasoning',
      maxInputSize: 500,
    });
  });
});
