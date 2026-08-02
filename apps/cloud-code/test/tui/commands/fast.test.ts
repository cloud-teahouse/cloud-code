import { beforeEach, describe, expect, it, vi } from 'vitest';

import { dispatchInput } from '#/tui/commands/dispatch';
import { handleFastCommand } from '#/tui/commands/fast';
import { NO_ACTIVE_SESSION_MESSAGE } from '#/tui/constant/cloud-code-tui';
import { resolveDescription, setLocalePreference, t } from '#/tui/i18n';

const CODEX_ALIAS = 'chatgpt-codex/gpt-5.2-codex';
const KIMI_ALIAS = 'kimi-code/kimi-for-coding';

function makeHost(appState: Record<string, unknown> = {}) {
  const session = {
    setServiceTier: vi.fn().mockResolvedValue(undefined),
  };
  const host = {
    state: {
      appState: {
        streamingPhase: 'idle',
        isCompacting: false,
        model: CODEX_ALIAS,
        serviceTier: null,
        availableModels: {
          [CODEX_ALIAS]: {
            provider: 'managed:chatgpt-codex',
            model: 'gpt-5.2-codex',
            maxContextSize: 400_000,
            serviceTiers: ['priority'],
          },
          [KIMI_ALIAS]: {
            provider: 'kimi',
            model: 'kimi-for-coding',
            maxContextSize: 1_000_000,
          },
        },
        availableProviders: {
          'managed:chatgpt-codex': { type: 'openai_responses', baseUrl: 'https://chatgpt.com/backend-api/codex' },
          kimi: { type: 'kimi' },
        },
        ...appState,
      },
    },
    session,
    harness: {
      setConfig: vi.fn().mockResolvedValue({}),
    },
    skillCommandMap: new Map<string, string>(),
    pluginCommandMap: new Map<string, string>(),
    setAppState: vi.fn(),
    showStatus: vi.fn(),
    showError: vi.fn(),
    showNotice: vi.fn(),
  };
  return { host, session };
}

beforeEach(() => {
  setLocalePreference('en');
});

describe('/fast command', () => {
  it('requires an active session', async () => {
    const { host, session } = makeHost();
    await handleFastCommand({ ...host, session: undefined } as never, '');

    expect(host.showError).toHaveBeenCalledWith(resolveDescription(NO_ACTIVE_SESSION_MESSAGE));
    expect(session.setServiceTier).not.toHaveBeenCalled();
    expect(host.harness.setConfig).not.toHaveBeenCalled();
  });

  it('toggles fast on: runtime, persistence, and status', async () => {
    const { host, session } = makeHost();
    await handleFastCommand(host as never, '');

    expect(session.setServiceTier).toHaveBeenCalledWith('priority');
    expect(host.setAppState).toHaveBeenCalledWith({ serviceTier: 'priority' });
    expect(host.harness.setConfig).toHaveBeenCalledWith({ serviceTier: 'fast' });
    expect(host.showStatus).toHaveBeenCalledWith(t('commands.fast.on'), 'success');
    expect(host.showError).not.toHaveBeenCalled();
  });

  it('toggles fast off again (round trip) and persists "default"', async () => {
    const { host, session } = makeHost({ serviceTier: 'priority' });
    await handleFastCommand(host as never, '');

    expect(session.setServiceTier).toHaveBeenCalledWith(null);
    expect(host.setAppState).toHaveBeenCalledWith({ serviceTier: null });
    expect(host.harness.setConfig).toHaveBeenCalledWith({ serviceTier: 'default' });
    expect(host.showStatus).toHaveBeenCalledWith(t('commands.fast.off'), 'success');
  });

  it('refuses non-Codex providers without touching runtime or config', async () => {
    const { host, session } = makeHost({ model: KIMI_ALIAS });
    await handleFastCommand(host as never, '');

    expect(host.showError).toHaveBeenCalledWith(t('commands.fast.unsupported'));
    expect(session.setServiceTier).not.toHaveBeenCalled();
    expect(host.setAppState).not.toHaveBeenCalled();
    expect(host.harness.setConfig).not.toHaveBeenCalled();
    expect(host.showStatus).not.toHaveBeenCalled();
  });

  it('refuses a Codex-backend model whose catalog does not declare the priority tier', async () => {
    const { host, session } = makeHost({
      availableModels: {
        [CODEX_ALIAS]: {
          provider: 'managed:chatgpt-codex',
          model: 'gpt-5.1-codex-mini',
          maxContextSize: 200_000,
          serviceTiers: ['flex'],
        },
      },
    });
    await handleFastCommand(host as never, '');

    expect(host.showError).toHaveBeenCalledWith(t('commands.fast.unsupported'));
    expect(session.setServiceTier).not.toHaveBeenCalled();
    expect(host.harness.setConfig).not.toHaveBeenCalled();
  });

  it('refuses a Codex-backend model with no serviceTiers declaration at all', async () => {
    const { host, session } = makeHost({
      availableModels: {
        [CODEX_ALIAS]: {
          provider: 'managed:chatgpt-codex',
          model: 'gpt-5.2-codex',
          maxContextSize: 400_000,
        },
      },
    });
    await handleFastCommand(host as never, '');

    expect(host.showError).toHaveBeenCalledWith(t('commands.fast.unsupported'));
    expect(session.setServiceTier).not.toHaveBeenCalled();
  });

  it('allows a third-party endpoint when the provider declares priority', async () => {
    const { host, session } = makeHost({
      model: 'gateway',
      availableModels: {
        gateway: {
          provider: 'gateway',
          model: 'gpt-5.2-codex',
          maxContextSize: 400_000,
        },
      },
      availableProviders: {
        gateway: {
          type: 'openai_responses',
          baseUrl: 'https://openai-proxy.example.com/v1',
          serviceTiers: ['priority'],
        },
      },
    });
    await handleFastCommand(host as never, '');

    expect(session.setServiceTier).toHaveBeenCalledWith('priority');
    expect(host.harness.setConfig).toHaveBeenCalledWith({ serviceTier: 'fast' });
    expect(host.showStatus).toHaveBeenCalledWith(t('commands.fast.on'), 'success');
    expect(host.showError).not.toHaveBeenCalled();
  });

  it('refuses third-party openai_responses endpoints even when the alias declares the tier', async () => {
    const { host, session } = makeHost({
      availableModels: {
        gateway: {
          provider: 'gateway',
          model: 'gpt-5.2-codex',
          maxContextSize: 400_000,
          serviceTiers: ['priority'],
        },
      },
      availableProviders: {
        gateway: { type: 'openai_responses', baseUrl: 'https://openai-proxy.example.com/v1' },
      },
      model: 'gateway',
    });
    await handleFastCommand(host as never, '');

    expect(host.showError).toHaveBeenCalledWith(t('commands.fast.unsupported'));
    expect(session.setServiceTier).not.toHaveBeenCalled();
    expect(host.harness.setConfig).not.toHaveBeenCalled();
  });

  it('refuses when no model is selected', async () => {
    const { host, session } = makeHost({ model: '' });
    await handleFastCommand(host as never, '');

    expect(host.showError).toHaveBeenCalledWith(t('commands.fast.unsupported'));
    expect(session.setServiceTier).not.toHaveBeenCalled();
  });

  it('reports a persistence failure after applying the runtime toggle', async () => {
    const { host, session } = makeHost();
    host.harness.setConfig.mockRejectedValue(new Error('disk full'));
    await handleFastCommand(host as never, '');

    expect(session.setServiceTier).toHaveBeenCalledWith('priority');
    expect(host.setAppState).toHaveBeenCalledWith({ serviceTier: 'priority' });
    expect(host.showError).toHaveBeenCalledWith(
      t('commands.fast.persistFailed', { error: 'disk full' }),
    );
    expect(host.showStatus).not.toHaveBeenCalled();
  });

  it('dispatches /fast from raw slash input', async () => {
    const { host, session } = makeHost();
    dispatchInput(host as never, '/fast');
    await vi.waitFor(() => {
      expect(session.setServiceTier).toHaveBeenCalledWith('priority');
    });
  });
});
