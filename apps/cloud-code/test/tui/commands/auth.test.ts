import { beforeEach, describe, expect, it, vi } from 'vitest';

import { handleLoginCommand, handleLogoutCommand } from '#/tui/commands/auth';
import { setLocalePreference } from '#/tui/i18n';

const mocks = vi.hoisted(() => ({
  openUrl: vi.fn(),
  promptPlatformSelection: vi.fn(),
  promptLogoutProviderSelection: vi.fn(),
  status: vi.fn(),
  login: vi.fn(),
  logout: vi.fn(),
  getConfig: vi.fn(),
  removeProvider: vi.fn(),
}));

vi.mock('../../../src/utils/open-url', () => ({
  openUrl: mocks.openUrl,
}));

vi.mock('../../../src/tui/commands/prompts', () => ({
  promptPlatformSelection: mocks.promptPlatformSelection,
  promptLogoutProviderSelection: mocks.promptLogoutProviderSelection,
  promptApiKey: vi.fn(),
  promptModelSelectionForOpenPlatform: vi.fn(),
}));

beforeEach(() => {
  setLocalePreference('en');
  vi.clearAllMocks();
});

interface SpinnerHandle {
  stop: ReturnType<typeof vi.fn>;
  setLabel: ReturnType<typeof vi.fn>;
}

function makeSpinner(): SpinnerHandle {
  return { stop: vi.fn(), setLabel: vi.fn() };
}

function makeHost(overrides: Record<string, unknown> = {}) {
  const spinner = makeSpinner();
  const host = {
    state: { appState: { model: '', availableModels: {} } },
    session: undefined,
    cancelInFlight: undefined as undefined | (() => void),
    harness: {
      auth: {
        status: mocks.status,
        login: mocks.login,
        logout: mocks.logout,
      },
      getConfig: mocks.getConfig,
      removeProvider: mocks.removeProvider,
    },
    authFlow: {
      refreshConfigAfterLogin: vi.fn().mockResolvedValue(undefined),
      refreshConfigAfterLogout: vi.fn().mockResolvedValue(undefined),
      clearActiveSessionAfterLogout: vi.fn().mockResolvedValue(undefined),
    },
    showNotice: vi.fn(),
    showStatus: vi.fn(),
    showError: vi.fn(),
    showLoginProgressSpinner: vi.fn(() => spinner),
    setAppState: vi.fn(),
    ...overrides,
  };
  return { host, spinner };
}

const CHATGPT_PROVIDER = 'managed:chatgpt-codex';

describe('/login — ChatGPT Codex (OAuth)', () => {
  it('opens the browser, waits for the callback and refreshes config on success', async () => {
    mocks.promptPlatformSelection.mockResolvedValue('chatgpt-codex');
    mocks.status.mockResolvedValue({
      providers: [{ providerName: CHATGPT_PROVIDER, hasToken: false }],
    });
    mocks.login.mockImplementation(async (_name: string, options: {
      onAuthorizeUrl?: (url: string) => void;
    }) => {
      options.onAuthorizeUrl?.('https://auth.openai.com/oauth/authorize?state=xyz');
      return { providerName: CHATGPT_PROVIDER, ok: true };
    });
    const { host, spinner } = makeHost();

    await handleLoginCommand(host as never);

    expect(mocks.status).toHaveBeenCalledWith(CHATGPT_PROVIDER);
    expect(mocks.login).toHaveBeenCalledWith(
      CHATGPT_PROVIDER,
      expect.objectContaining({ onAuthorizeUrl: expect.any(Function) }),
    );
    // Browser opened + URL surfaced + spinner shown while waiting.
    expect(mocks.openUrl).toHaveBeenCalledWith(
      'https://auth.openai.com/oauth/authorize?state=xyz',
    );
    expect(host.showNotice).toHaveBeenCalledWith(
      expect.stringContaining('ChatGPT'),
      'https://auth.openai.com/oauth/authorize?state=xyz',
      // The authorize URL is actionable, so it stays in the transcript.
      { transcript: true },
    );
    expect(spinner.stop).toHaveBeenCalledWith({ ok: true, label: 'Logged in.' });
    expect(host.authFlow.refreshConfigAfterLogin).toHaveBeenCalledOnce();
    expect(host.showError).not.toHaveBeenCalled();
    expect(host.cancelInFlight).toBeUndefined();
  });

  it('surfaces login failures through the error path', async () => {
    mocks.promptPlatformSelection.mockResolvedValue('chatgpt-codex');
    mocks.status.mockResolvedValue({ providers: [] });
    mocks.login.mockRejectedValue(new Error('state mismatch'));
    const { host, spinner } = makeHost();

    await handleLoginCommand(host as never);

    expect(spinner.stop).not.toHaveBeenCalled();
    expect(host.showError).toHaveBeenCalledWith('Login failed: state mismatch');
    expect(host.authFlow.refreshConfigAfterLogin).not.toHaveBeenCalled();
    expect(host.cancelInFlight).toBeUndefined();
  });

  it('treats an in-flight cancel as a silent cancellation', async () => {
    mocks.promptPlatformSelection.mockResolvedValue('chatgpt-codex');
    mocks.status.mockResolvedValue({ providers: [] });
    const { host } = makeHost();
    mocks.login.mockImplementation(async () => {
      host.cancelInFlight?.();
      throw new Error('aborted');
    });

    await handleLoginCommand(host as never);

    expect(host.showError).not.toHaveBeenCalled();
    expect(host.authFlow.refreshConfigAfterLogin).not.toHaveBeenCalled();
  });
});

describe('/logout — ChatGPT Codex (OAuth)', () => {
  it('offers the ChatGPT Codex provider and logs it out via the auth facade', async () => {
    mocks.status.mockImplementation(async (name: string) => ({
      providers: [{ providerName: name, hasToken: name === CHATGPT_PROVIDER }],
    }));
    mocks.getConfig.mockResolvedValue({
      providers: {
        [CHATGPT_PROVIDER]: {
          type: 'openai_responses',
          baseUrl: 'https://chatgpt.com/backend-api/codex',
        },
      },
      models: {},
    });
    mocks.promptLogoutProviderSelection.mockResolvedValue(CHATGPT_PROVIDER);
    const { host } = makeHost();

    await handleLogoutCommand(host as never);

    // Both the kimi status and the chatgpt status were probed.
    expect(mocks.status).toHaveBeenCalledWith('managed:kimi-code');
    expect(mocks.status).toHaveBeenCalledWith(CHATGPT_PROVIDER);
    // The picker included the ChatGPT Codex OAuth entry.
    const options = mocks.promptLogoutProviderSelection.mock.calls[0]?.[1] as Array<{
      value: string;
      label: string;
    }>;
    expect(options.map((o) => o.value)).toContain(CHATGPT_PROVIDER);
    expect(options.find((o) => o.value === CHATGPT_PROVIDER)?.label).toBe('ChatGPT Codex');

    expect(mocks.logout).toHaveBeenCalledWith(CHATGPT_PROVIDER);
    expect(mocks.removeProvider).not.toHaveBeenCalled();
    expect(host.showStatus).toHaveBeenCalledWith('Logged out from ChatGPT Codex.');
  });
});
