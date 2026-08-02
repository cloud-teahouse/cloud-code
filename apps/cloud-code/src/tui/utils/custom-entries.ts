/**
 * Custom provider/model classification and shared CRUD helpers.
 *
 * "Custom" entries are the ones the user maintains by hand — created via the
 * /provider custom-endpoint wizard, the /model custom-model wizard, a "known
 * provider" catalog import, or written directly into config.toml. Everything
 * else is *managed* by an external source and must not be edited or deleted
 * through the custom CRUD flows:
 *   - `managed:*` providers (Cloud Code OAuth, ChatGPT Codex) — /login, /logout
 *   - Open Platform logins (`isOpenPlatformId`, OAuth-backed)
 *   - providers with an `oauth` ref or a `source` (custom-registry api.json
 *     imports refresh from their registry; manual edits would be lost)
 *   - the env-model provider (`__kimi_env__`, agent-core env-model.ts) which
 *     only exists as an in-memory overlay
 *
 * Because managed sources never overlap with standalone entries, a model is
 * custom exactly when its provider is custom.
 */

import { isOpenPlatformId } from '@cloud-code/oauth';
import type { ModelAlias, ProviderConfig } from '@cloud-code/sdk';

import { t } from '../i18n';
import type { SlashCommandHost } from '../commands/dispatch';

/** agent-core `ENV_MODEL_PROVIDER_KEY` — in-memory env overlay, never user-managed. */
const ENV_MODEL_PROVIDER_ID = '__kimi_env__';

export function isCustomProvider(
  providerId: string,
  provider: ProviderConfig | undefined,
): boolean {
  if (provider === undefined) return false;
  if (providerId === ENV_MODEL_PROVIDER_ID) return false;
  if (providerId.startsWith('managed:')) return false;
  if (isOpenPlatformId(providerId)) return false;
  if (provider.oauth !== undefined) return false;
  if (provider.source !== undefined) return false;
  return true;
}

export function isCustomModel(
  model: ModelAlias | undefined,
  providers: Record<string, ProviderConfig>,
): boolean {
  if (model === undefined) return false;
  return isCustomProvider(model.provider, providers[model.provider]);
}

/** Aliases of every model entry pointing at `providerId`, in config order. */
export function providerModelAliases(
  models: Record<string, ModelAlias>,
  providerId: string,
): string[] {
  return Object.entries(models)
    .filter(([, model]) => model.provider === providerId)
    .map(([alias]) => alias);
}

/**
 * Sane default to fall back to after entries were removed: the persisted
 * default model when it survives, otherwise the first remaining alias, or
 * `undefined` when no models are left at all.
 */
export function resolveModelFallback(
  config: {
    readonly models?: Record<string, ModelAlias> | undefined;
    readonly defaultModel?: string | undefined;
  },
  removedAliases: ReadonlySet<string>,
): string | undefined {
  const models = config.models ?? {};
  const defaultModel = config.defaultModel;
  if (
    defaultModel !== undefined &&
    !removedAliases.has(defaultModel) &&
    models[defaultModel] !== undefined
  ) {
    return defaultModel;
  }
  return Object.keys(models).find((alias) => !removedAliases.has(alias));
}

/**
 * Active-model repair after custom entries were deleted or replaced.
 *
 * Always refreshes the available model/provider lists from the freshly
 * persisted config. When the *current* model was among the removed aliases:
 *   - a surviving model exists → switch the session (when one is live) and
 *     the UI onto {@link resolveModelFallback}, persist it as the new default
 *     when the old default went away, and notify;
 *   - nothing is left → clear the active session (same shape as the logout
 *     path) and notify.
 */
export async function revertActiveModelAfterRemoval(
  host: SlashCommandHost,
  removedAliases: ReadonlySet<string>,
): Promise<void> {
  await host.authFlow.refreshAvailableModels();
  const active = host.state.appState.model;
  if (active.length === 0 || !removedAliases.has(active)) return;

  const config = await host.harness.getConfig({ reload: true });
  const fallback = resolveModelFallback(config, removedAliases);
  if (fallback === undefined) {
    await host.authFlow.clearActiveSessionAfterLogout();
    host.showStatus(t('commands.model.manage.noneLeft'), 'warning');
    return;
  }

  if (config.defaultModel === undefined || removedAliases.has(config.defaultModel)) {
    await host.harness.setConfig({ defaultModel: fallback });
  }

  const model = config.models?.[fallback];
  const name = model?.displayName ?? model?.model ?? fallback;
  const session = host.session;
  if (session !== undefined) {
    await session.setModel(fallback);
    const status = await session.getStatus();
    host.setAppState({
      model: status.model ?? fallback,
      thinkingEffort: status.thinkingEffort,
      ...(model !== undefined ? { maxContextTokens: model.maxContextSize } : {}),
    });
  } else {
    host.setAppState({
      model: fallback,
      ...(model !== undefined ? { maxContextTokens: model.maxContextSize } : {}),
    });
  }
  host.showStatus(t('commands.model.manage.activeReverted', { name }), 'warning');
}
