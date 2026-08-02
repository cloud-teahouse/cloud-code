import {
  applyOpenPlatformConfig,
  CHATGPT_CODEX_PLATFORM_ID,
  CHATGPT_CODEX_PROVIDER_NAME,
  fetchOpenPlatformModels,
  filterModelsByPrefix,
  getOpenPlatformById,
  OpenPlatformApiError,
  type ManagedKimiCodeModelInfo,
  type ManagedKimiConfigShape,
  type OpenPlatformDefinition,
} from '@cloud-code/oauth';
import { log } from '@cloud-code/sdk';

import { openUrl } from '#/utils/open-url';

import type { ChoiceOption } from '../components/dialogs/choice-picker';
import { DEFAULT_OAUTH_PROVIDER_NAME, PRODUCT_NAME } from '../constant/cloud-code-tui';
import { padEndVisible, t } from '../i18n';
import { formatErrorMessage } from '../utils/event-payload';
import type { LoginProgressSpinnerHandle } from '../types';
import {
  promptApiKey,
  promptLogoutProviderSelection,
  promptModelSelectionForOpenPlatform,
  promptPlatformSelection,
} from './prompts';
import type { SlashCommandHost } from './dispatch';

const CHATGPT_CODEX_PLATFORM_LABEL = 'ChatGPT Codex';

// ---------------------------------------------------------------------------
// Auth: login / logout
// ---------------------------------------------------------------------------

export async function handleLoginCommand(host: SlashCommandHost): Promise<void> {
  const platformId = await promptPlatformSelection(host);
  if (platformId === undefined) return;

  if (platformId === 'kimi-code') {
    await handleKimiCodeOAuthLogin(host);
    return;
  }

  if (platformId === CHATGPT_CODEX_PLATFORM_ID) {
    await handleChatGptCodexLogin(host);
    return;
  }

  const platform = getOpenPlatformById(platformId);
  if (platform === undefined) return;
  await handleOpenPlatformLogin(host, platform);
}

async function handleKimiCodeOAuthLogin(host: SlashCommandHost): Promise<void> {
  const status = await host.harness.auth.status(DEFAULT_OAUTH_PROVIDER_NAME);
  const alreadyLoggedIn = status.providers.some(
    (provider) => provider.providerName === DEFAULT_OAUTH_PROVIDER_NAME && provider.hasToken,
  );

  let spinner: LoginProgressSpinnerHandle | undefined;
  const controller = new AbortController();
  const cancelLogin = (): void => {
    controller.abort();
  };
  host.cancelInFlight = cancelLogin;
  try {
    await host.harness.auth.login(DEFAULT_OAUTH_PROVIDER_NAME, {
      signal: controller.signal,
      onDeviceCode: (data) => {
        spinner = host.showLoginAuthorizationPrompt(data);
      },
    });
    spinner?.stop({ ok: true, label: t('commands.login.loggedIn') });
    spinner = undefined;
    try {
      await host.authFlow.refreshConfigAfterLogin();
    } catch (refreshError) {
      const message = formatErrorMessage(refreshError);
      host.showError(t('commands.login.refreshFailed', { error: message }));
      return;
    }
    if (alreadyLoggedIn) {
      host.showStatus(t('commands.login.alreadyLoggedIn'));
    }
  } catch (error) {
    const cancelled = controller.signal.aborted;
    spinner?.stop({
      ok: false,
      label: cancelled ? t('commands.login.cancelled') : t('commands.login.failedSpinner'),
    });
    spinner = undefined;
    if (cancelled) return;
    log.warn('login failed', {
      providerName: DEFAULT_OAUTH_PROVIDER_NAME,
      alreadyLoggedIn,
      sessionId: host.session?.id,
      error,
    });
    const message = formatErrorMessage(error);
    host.showError(t('commands.login.failed', { error: message }));
  } finally {
    if (host.cancelInFlight === cancelLogin) {
      host.cancelInFlight = undefined;
    }
  }
}

/**
 * ChatGPT Codex (OAuth) login: authorization-code + PKCE against
 * auth.openai.com. Unlike the Kimi device-code flow there is no user code to
 * show — the CLI opens the browser at the authorize URL and waits for the
 * localhost callback server (allow-listed ports 1455/1457) to receive the
 * redirect. The notice keeps the URL visible for browsers that do not open
 * automatically, and the success page is rendered browser-side by that
 * callback server.
 */
async function handleChatGptCodexLogin(host: SlashCommandHost): Promise<void> {
  const status = await host.harness.auth.status(CHATGPT_CODEX_PROVIDER_NAME);
  const alreadyLoggedIn = status.providers.some(
    (provider) => provider.providerName === CHATGPT_CODEX_PROVIDER_NAME && provider.hasToken,
  );

  let spinner: LoginProgressSpinnerHandle | undefined;
  const controller = new AbortController();
  const cancelLogin = (): void => {
    controller.abort();
  };
  host.cancelInFlight = cancelLogin;
  try {
    await host.harness.auth.login(CHATGPT_CODEX_PROVIDER_NAME, {
      signal: controller.signal,
      onAuthorizeUrl: (url) => {
        try {
          openUrl(url);
        } catch {
          // Best effort only: the URL is also shown in the notice below.
        }
        // The authorize URL is actionable (the browser open above is
        // best-effort) — keep it in the transcript so a later transient
        // notice can't replace it before the user clicks it.
        host.showNotice(t('commands.login.chatgptCodexNotice'), url, { transcript: true });
        spinner = host.showLoginProgressSpinner(t('status.login.waiting'));
      },
    });
    spinner?.stop({ ok: true, label: t('commands.login.loggedIn') });
    spinner = undefined;
    try {
      await host.authFlow.refreshConfigAfterLogin();
    } catch (refreshError) {
      const message = formatErrorMessage(refreshError);
      host.showError(t('commands.login.refreshFailed', { error: message }));
      return;
    }
    if (alreadyLoggedIn) {
      host.showStatus(t('commands.login.alreadyLoggedIn'));
    }
  } catch (error) {
    const cancelled = controller.signal.aborted;
    spinner?.stop({
      ok: false,
      label: cancelled ? t('commands.login.cancelled') : t('commands.login.failedSpinner'),
    });
    spinner = undefined;
    if (cancelled) return;
    log.warn('login failed', {
      providerName: CHATGPT_CODEX_PROVIDER_NAME,
      alreadyLoggedIn,
      sessionId: host.session?.id,
      error,
    });
    const message = formatErrorMessage(error);
    host.showError(t('commands.login.failed', { error: message }));
  } finally {
    if (host.cancelInFlight === cancelLogin) {
      host.cancelInFlight = undefined;
    }
  }
}

async function handleOpenPlatformLogin(
  host: SlashCommandHost,
  platform: OpenPlatformDefinition,
): Promise<void> {
  const consoleHost = platform.consoleUrl?.replace(/^https?:\/\//, '') ?? '';
  const platformName = consoleHost.length > 0 ? `Kimi Platform (${consoleHost})` : 'Kimi Platform';
  const subtitleLines = [
    `${padEndVisible('base_url', 12)}${platform.baseUrl}`,
    `${padEndVisible(t('commands.login.savedTo'), 12)}~/.cloud-code/config.toml`,
  ];
  const apiKey = await promptApiKey(host, platformName, subtitleLines);
  if (apiKey === undefined) return;

  const controller = new AbortController();
  const cancelLogin = (): void => {
    controller.abort();
  };
  host.cancelInFlight = cancelLogin;

  let models: ManagedKimiCodeModelInfo[];
  try {
    models = await fetchOpenPlatformModels(platform, apiKey, fetch, controller.signal);
    models = filterModelsByPrefix(models, platform);
  } catch (error) {
    if (controller.signal.aborted) return;
    const msg = formatErrorMessage(error);
    host.showError(t('commands.login.verifyKeyFailed', { error: msg }));
    if (
      error instanceof OpenPlatformApiError &&
      error.status === 401
    ) {
      host.showStatus(t('commands.login.cloudCodeKeyHint'));
    }
    return;
  } finally {
    if (host.cancelInFlight === cancelLogin) {
      host.cancelInFlight = undefined;
    }
  }

  if (models.length === 0) {
    host.showError(t('commands.login.noModels'));
    return;
  }

  const selection = await promptModelSelectionForOpenPlatform(host, models, platform);
  if (selection === undefined) return;

  const existingConfig = await host.harness.getConfig();
  if (existingConfig.providers[platform.id] !== undefined) {
    await host.harness.removeProvider(platform.id);
  }

  const config = await host.harness.getConfig();
  applyOpenPlatformConfig(config as ManagedKimiConfigShape, {
    platform,
    models,
    selectedModel: selection.model,
    thinking: selection.thinking !== 'off',
    effort:
      selection.thinking !== 'off' && selection.thinking !== 'on'
        ? selection.thinking
        : undefined,
    apiKey,
  });

  await host.harness.setConfig({
    providers: config.providers,
    models: config.models,
    defaultModel: config.defaultModel,
    thinking: config.thinking,
  });

  await host.authFlow.refreshConfigAfterLogin();
  host.showStatus(
    t('commands.login.setupComplete', { platform: platform.name, model: selection.model.id }),
  );
}

export async function handleLogoutCommand(host: SlashCommandHost): Promise<void> {
  const oauthStatus = await host.harness.auth.status(DEFAULT_OAUTH_PROVIDER_NAME);
  const hasOAuthToken = oauthStatus.providers.some(
    (p) => p.providerName === DEFAULT_OAUTH_PROVIDER_NAME && p.hasToken,
  );
  const chatGptStatus = await host.harness.auth.status(CHATGPT_CODEX_PROVIDER_NAME);
  const hasChatGptToken = chatGptStatus.providers.some(
    (p) => p.providerName === CHATGPT_CODEX_PROVIDER_NAME && p.hasToken,
  );
  const config = await host.harness.getConfig();
  const hasManagedRemnant =
    hasOAuthToken || config.providers[DEFAULT_OAUTH_PROVIDER_NAME] !== undefined;
  const hasChatGptRemnant =
    hasChatGptToken || config.providers[CHATGPT_CODEX_PROVIDER_NAME] !== undefined;
  const apiKeyProviderIds = Object.keys(config.providers ?? {})
    .filter((id) => id !== DEFAULT_OAUTH_PROVIDER_NAME && id !== CHATGPT_CODEX_PROVIDER_NAME)
    .toSorted();

  const options: ChoiceOption[] = [];
  if (hasManagedRemnant) {
    options.push({
      value: DEFAULT_OAUTH_PROVIDER_NAME,
      label: PRODUCT_NAME,
      description: t('commands.logout.oauthDescription'),
    });
  }
  if (hasChatGptRemnant) {
    options.push({
      value: CHATGPT_CODEX_PROVIDER_NAME,
      label: CHATGPT_CODEX_PLATFORM_LABEL,
      description: t('commands.logout.oauthDescription'),
    });
  }
  for (const id of apiKeyProviderIds) {
    const baseUrl = config.providers[id]?.baseUrl;
    options.push({
      value: id,
      label: id,
      description: typeof baseUrl === 'string' && baseUrl.length > 0 ? baseUrl : undefined,
    });
  }

  if (options.length === 0) {
    host.showStatus(t('commands.logout.nothing'));
    return;
  }

  const currentModel = host.state.appState.model.trim();
  const currentProvider = host.state.appState.availableModels[currentModel]?.provider;

  const target = await promptLogoutProviderSelection(host, options, currentProvider);
  if (target === undefined) return;

  if (target === DEFAULT_OAUTH_PROVIDER_NAME || target === CHATGPT_CODEX_PROVIDER_NAME) {
    await host.harness.auth.logout(target);
  } else {
    await host.harness.removeProvider(target);
  }

  if (target === currentProvider) {
    await host.authFlow.refreshConfigAfterLogout();
    await host.authFlow.clearActiveSessionAfterLogout();
  } else {
    const updated = await host.harness.getConfig({ reload: true });
    host.setAppState({
      availableModels: updated.models ?? {},
      availableProviders: updated.providers ?? {},
    });
  }

  const label =
    target === DEFAULT_OAUTH_PROVIDER_NAME
      ? PRODUCT_NAME
      : target === CHATGPT_CODEX_PROVIDER_NAME
        ? CHATGPT_CODEX_PLATFORM_LABEL
        : target;
  host.showStatus(t('commands.logout.done', { label }));
}
