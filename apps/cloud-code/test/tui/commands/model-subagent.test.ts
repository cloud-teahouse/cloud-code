/**
 * /model subagent-default flow: Alt+A assigns the highlighted model (with its
 * draft thinking effort) as the `[secondary_model]` default, Alt+A on the
 * assigned row clears it, the picker badges the assigned row, and deleting an
 * assigned custom model reports the core-side scrub.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelAlias } from '@cloud-code/sdk';

import { handleModelCommand } from '#/tui/commands/config';
import { setLocalePreference } from '#/tui/i18n';
import type { RefreshResult } from '#/tui/utils/refresh-providers';

const ANSI = /\[[0-9;]*m/g;
const strip = (s: string): string => s.replaceAll(ANSI, '');
const ESC = String.fromCodePoint(27);
const DOWN = `${ESC}[B`;
const ALT_A = `${ESC}a`;
const ALT_D = `${ESC}d`;

async function flush(): Promise<void> {
  for (let i = 0; i < 30; i++) {
    await Promise.resolve();
  }
}

function model(providerId: string, modelId: string): ModelAlias {
  return {
    provider: providerId,
    model: modelId,
    maxContextSize: 128_000,
    displayName: modelId,
    capabilities: ['tool_use'],
  } as unknown as ModelAlias;
}

interface HostConfig {
  readonly models: Record<string, ModelAlias>;
  readonly defaultModel?: string;
  readonly secondaryModel?: { readonly model?: string; readonly effort?: string };
}

function makeHost(initialModels: Record<string, ModelAlias>, config: HostConfig) {
  const panels: Array<{ handleInput: (data: string) => void; render: (width: number) => string[] }> =
    [];
  const host = {
    state: {
      transcriptEntries: [],
      appState: {
        model: 'k2',
        thinkingEffort: 'off',
        streamingPhase: 'idle',
        availableProviders: {
          'managed:kimi-code': { type: 'kimi' },
          acme: { type: 'openai' },
        },
        availableModels: initialModels,
      },
      ui: { requestRender: vi.fn() },
    },
    session: undefined,
    harness: {
      getConfig: vi.fn(async () => config),
      setSecondaryModel: vi.fn(async () => config),
      removeModel: vi.fn(async () => config),
    },
    authFlow: {
      refreshOAuthProviderModels: vi.fn<() => Promise<RefreshResult | undefined>>(
        async () => undefined,
      ),
      refreshAvailableModels: vi.fn(async () => undefined),
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
    lastPanel: () => panels[panels.length - 1]!,
    panelText: () => strip(panels[panels.length - 1]!.render(110).join('\n')),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  setLocalePreference('en');
});

describe('/model subagent default', () => {
  const models = { k2: model('managed:kimi-code', 'k2'), k1: model('managed:kimi-code', 'k1') };

  it('Alt+A assigns the highlighted model as the subagent default and persists it', async () => {
    const { host, lastPanel } = makeHost(models, { models, defaultModel: 'k2' });
    await handleModelCommand(host as never, '');
    await flush();

    lastPanel().handleInput(DOWN); // k1
    lastPanel().handleInput(ALT_A);

    await flush();
    expect(host.harness.setSecondaryModel).toHaveBeenCalledWith({ model: 'k1', effort: 'off' });
    expect(host.restoreEditor).toHaveBeenCalled();
    expect(host.showStatus).toHaveBeenCalledWith(
      expect.stringContaining('Subagent model set to k1'),
      'success',
    );
    expect(host.showError).not.toHaveBeenCalled();
  });

  it('Alt+A on the assigned row clears the subagent default', async () => {
    const { host, lastPanel, panelText } = makeHost(models, {
      models,
      defaultModel: 'k2',
      secondaryModel: { model: 'k1', effort: 'high' },
    });
    await handleModelCommand(host as never, '');
    await flush();

    // The badge and the hint render once the lazy config read has landed.
    expect(panelText()).toContain('← subagent');
    expect(panelText()).toContain('Alt+A subagent');

    lastPanel().handleInput(DOWN); // k1 — the current subagent default
    lastPanel().handleInput(ALT_A);

    await flush();
    expect(host.harness.setSecondaryModel).toHaveBeenCalledWith({});
    expect(host.showStatus).toHaveBeenCalledWith(
      expect.stringContaining('Subagent model cleared'),
      'success',
    );
  });

  it('deleting the assigned custom model warns about the scrubbed subagent default', async () => {
    const customModels = { ...models, 'acme/m1': model('acme', 'm1') };
    const { host, lastPanel, panelText } = makeHost(customModels, {
      models: customModels,
      defaultModel: 'k2',
      secondaryModel: { model: 'acme/m1', effort: 'high' },
    });
    await handleModelCommand(host as never, '');
    await flush();

    lastPanel().handleInput(DOWN); // acme/m1 (insertion order: k2, k1, acme/m1)
    lastPanel().handleInput(DOWN);
    lastPanel().handleInput(ALT_D); // arms the inline delete confirmation
    expect(panelText()).toContain('It is saved as the subagent default model.');

    lastPanel().handleInput('y');
    await flush();
    expect(host.harness.removeModel).toHaveBeenCalledWith('acme/m1');
    expect(host.showStatus).toHaveBeenCalledWith(
      expect.stringContaining('subagent default'),
      'warning',
    );
  });

  it('renders the badge and hint in zh-CN', async () => {
    setLocalePreference('zh-CN');
    try {
      const { host, panelText } = makeHost(models, {
        models,
        defaultModel: 'k2',
        secondaryModel: { model: 'k1', effort: 'high' },
      });
      await handleModelCommand(host as never, '');
      await flush();
      expect(panelText()).toContain('← 子代理');
      expect(panelText()).toContain('Alt+A 子代理');
    } finally {
      setLocalePreference('en');
    }
  });
});
