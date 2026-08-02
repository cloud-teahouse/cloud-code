/**
 * /model async refresh flow: the picker mounts on the cached model list
 * without waiting for the OAuth provider refresh, its rows live-update when
 * the refresh lands, and concurrent opens share one in-flight refresh.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelAlias } from '@cloud-code/sdk';

import { handleModelCommand } from '#/tui/commands/config';
import { setLocalePreference } from '#/tui/i18n';
import type { RefreshResult } from '#/tui/utils/refresh-providers';

const ANSI = /\[[0-9;]*m/g;
const strip = (s: string): string => s.replaceAll(ANSI, '');

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

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

function makeHost(initialModels: Record<string, ModelAlias>) {
  const panels: Array<{ handleInput: (data: string) => void; render: (width: number) => string[] }> =
    [];
  const host = {
    state: {
      transcriptEntries: [],
      appState: {
        model: 'k2',
        thinkingEffort: 'off',
        streamingPhase: 'idle',
        availableProviders: { 'managed:kimi-code': { type: 'kimi' } },
        availableModels: initialModels,
      },
      ui: { requestRender: vi.fn() },
    },
    session: undefined,
    harness: {
      getConfig: vi.fn(async () => ({ models: initialModels, defaultModel: 'k2' })),
    },
    authFlow: {
      refreshOAuthProviderModels: vi.fn<() => Promise<RefreshResult | undefined>>(
        async () => undefined,
      ),
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

describe('/model async refresh', () => {
  it('mounts the picker before the OAuth refresh resolves', async () => {
    const ctx = makeHost({ k2: model('managed:kimi-code', 'kimi-k2') });
    const gate = deferred<never>();
    ctx.host.authFlow.refreshOAuthProviderModels.mockReturnValue(gate.promise);

    await handleModelCommand(ctx.host as never, '');

    // The picker is up with the cached list while the network refresh is
    // still in flight.
    expect(ctx.panels).toHaveLength(1);
    expect(ctx.panelText()).toContain('kimi-k2');
    expect(ctx.host.authFlow.refreshOAuthProviderModels).toHaveBeenCalledOnce();
  });

  it('live-updates the picker rows when the refresh lands', async () => {
    const ctx = makeHost({ k2: model('managed:kimi-code', 'kimi-k2') });
    const gate = deferred<void>();
    ctx.host.authFlow.refreshOAuthProviderModels.mockImplementation(async () => {
      await gate.promise;
      ctx.host.state.appState.availableModels = {
        k2: model('managed:kimi-code', 'kimi-k2'),
        turbo: model('managed:kimi-code', 'kimi-turbo'),
      };
      return {
        changed: [{ providerId: 'managed:kimi-code', providerName: 'kimi', added: 1, removed: 0 }],
        unchanged: [],
        failed: [],
      };
    });

    await handleModelCommand(ctx.host as never, '');
    expect(ctx.panelText()).not.toContain('kimi-turbo');

    gate.resolve();
    await flush();

    expect(ctx.panelText()).toContain('kimi-turbo');
    expect(ctx.host.state.ui.requestRender).toHaveBeenCalled();
  });

  it('surfaces skipped-provider warnings when the refresh resolves', async () => {
    const ctx = makeHost({ k2: model('managed:kimi-code', 'kimi-k2') });
    ctx.host.authFlow.refreshOAuthProviderModels.mockResolvedValue({
      changed: [],
      unchanged: [],
      failed: [{ provider: 'managed:kimi-code', reason: 'HTTP 503' }],
    });

    await handleModelCommand(ctx.host as never, '');
    await flush();

    expect(ctx.host.showStatus).toHaveBeenCalledWith(
      expect.stringContaining('managed:kimi-code'),
      'warning',
    );
  });

  it('shares one in-flight refresh between concurrent opens', async () => {
    const ctx = makeHost({ k2: model('managed:kimi-code', 'kimi-k2') });
    const gate = deferred<void>();
    ctx.host.authFlow.refreshOAuthProviderModels.mockImplementation(async () => {
      await gate.promise;
      return undefined;
    });

    await handleModelCommand(ctx.host as never, '');
    await handleModelCommand(ctx.host as never, '');
    expect(ctx.host.authFlow.refreshOAuthProviderModels).toHaveBeenCalledOnce();

    // After the refresh settles, the next open refreshes again.
    gate.resolve();
    await flush();
    await handleModelCommand(ctx.host as never, '');
    expect(ctx.host.authFlow.refreshOAuthProviderModels).toHaveBeenCalledTimes(2);
  });

  it('opens instantly on a known alias and errors on an unknown one', async () => {
    const ctx = makeHost({ k2: model('managed:kimi-code', 'kimi-k2') });

    await handleModelCommand(ctx.host as never, 'k2');
    expect(ctx.panels).toHaveLength(1);
    expect(ctx.panelText()).toContain('kimi-k2');

    await handleModelCommand(ctx.host as never, 'nope');
    expect(ctx.panels).toHaveLength(1); // no second picker
    expect(ctx.host.showError).toHaveBeenCalledWith(expect.stringContaining('nope'));
  });

  it('waits for the refresh to introduce an alias before erroring', async () => {
    const ctx = makeHost({ k2: model('managed:kimi-code', 'kimi-k2') });
    const gate = deferred<void>();
    ctx.host.authFlow.refreshOAuthProviderModels.mockImplementation(async () => {
      await gate.promise;
      ctx.host.state.appState.availableModels = {
        ...ctx.host.state.appState.availableModels,
        turbo: model('managed:kimi-code', 'kimi-turbo'),
      };
      return {
        changed: [{ providerId: 'managed:kimi-code', providerName: 'kimi', added: 1, removed: 0 }],
        unchanged: [],
        failed: [],
      };
    });

    const done = handleModelCommand(ctx.host as never, 'turbo');
    await flush();
    // Still waiting on the refresh — no picker, no error yet.
    expect(ctx.panels).toHaveLength(0);
    expect(ctx.host.showError).not.toHaveBeenCalled();

    gate.resolve();
    await done;
    expect(ctx.panels).toHaveLength(1);
    expect(ctx.panelText()).toContain('kimi-turbo');
  });
});
