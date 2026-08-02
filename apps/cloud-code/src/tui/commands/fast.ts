import { effectiveModelAlias, isFastTierSupported, type ServiceTier } from '@cloud-code/sdk';

import { NO_ACTIVE_SESSION_MESSAGE } from '../constant/cloud-code-tui';
import { resolveDescription, t } from '../i18n';
import { formatErrorMessage } from '../utils/event-payload';
import type { SlashCommandHost } from './dispatch';

/**
 * `/fast` — codex-style fast-tier toggle (`service_tier: 'priority'`).
 *
 * Only meaningful for ChatGPT Codex models whose catalog metadata declares
 * the priority service tier (see `isFastTierSupported`); third-party
 * OpenAI-compatible endpoints are never eligible.
 */
export async function handleFastCommand(host: SlashCommandHost, _args: string): Promise<void> {
  const session = host.session;
  if (session === undefined) {
    host.showError(resolveDescription(NO_ACTIVE_SESSION_MESSAGE));
    return;
  }
  if (!isCurrentModelFastCapable(host)) {
    host.showError(t('commands.fast.unsupported'));
    return;
  }

  const next: ServiceTier | null =
    host.state.appState.serviceTier === 'priority' ? null : 'priority';
  try {
    await session.setServiceTier(next);
  } catch (error) {
    host.showError(t('commands.fast.failed', { error: formatErrorMessage(error) }));
    return;
  }
  host.setAppState({ serviceTier: next });

  try {
    await host.harness.setConfig({ serviceTier: next === 'priority' ? 'fast' : 'default' });
  } catch (error) {
    host.showError(t('commands.fast.persistFailed', { error: formatErrorMessage(error) }));
    return;
  }

  host.showStatus(next === 'priority' ? t('commands.fast.on') : t('commands.fast.off'), 'success');
}

function isCurrentModelFastCapable(host: SlashCommandHost): boolean {
  const model = host.state.appState.availableModels[host.state.appState.model];
  if (model === undefined) return false;
  // Model-level gate: official Codex backend plus a catalog-declared
  // 'priority' service tier. Third-party openai_responses endpoints share
  // the wire type but never qualify, so service_tier cannot leak to them.
  const provider = host.state.appState.availableProviders[model.provider];
  return isFastTierSupported(effectiveModelAlias(model), provider);
}
