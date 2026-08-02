import {
  applyCustomRegistryEntries,
  fetchCustomRegistry,
  type CustomRegistrySource,
  type ManagedKimiConfigShape,
} from '@cloud-code/oauth';
import {
  applyCatalogProvider,
  catalogProviderModels,
  CatalogFetchError,
  DEFAULT_CATALOG_URL,
  resolveCatalogImport,
  type Catalog,
  type ThinkingEffort,
} from '@cloud-code/sdk';

import { createKimiCodeUserAgent } from '#/cli/version';
import { fetchCatalogOrBuiltIn } from '#/utils/catalog-fetch';
import { ChoicePickerComponent } from '../components/dialogs/choice-picker';
import {
  CustomRegistryImportDialogComponent,
  type CustomRegistryImportResult,
} from '../components/dialogs/custom-registry-import';
import {
  ProviderManagerComponent,
  type ProviderManagerOptions,
} from '../components/dialogs/provider-manager';
import { TabbedModelSelectorComponent } from '../components/dialogs/tabbed-model-selector';
import { DEFAULT_OAUTH_PROVIDER_NAME } from '../constant/cloud-code-tui';
import { t } from '../i18n';
import {
  isCustomProvider,
  providerModelAliases,
  revertActiveModelAfterRemoval,
} from '../utils/custom-entries';
import { formatErrorMessage } from '../utils/event-payload';
import { thinkingEffortToConfig } from '../utils/thinking-config';
import { effectiveModelForHost, showModelPicker } from './config';
import { runCustomModelWizard } from './custom-model-wizard';
import { runCustomProviderEditWizard, runCustomProviderWizard } from './custom-provider-wizard';
import {
  promptApiKey,
  promptBaseUrl,
  promptCatalogProviderSelection,
  promptChoice,
} from './prompts';
import type { SlashCommandHost } from './dispatch';

// ---------------------------------------------------------------------------
// /provider command
// ---------------------------------------------------------------------------

export async function handleProviderCommand(host: SlashCommandHost): Promise<void> {
  reopenProviderManager(host);
}

function buildProviderManagerOptions(
  host: SlashCommandHost,
  onClose: () => void,
): ProviderManagerOptions {
  const activeProviderId =
    host.state.appState.availableModels[host.state.appState.model]?.provider;
  return {
    providers: host.state.appState.availableProviders,
    models: host.state.appState.availableModels,
    activeProviderId,
    onAdd: () => {
      void handleProviderAdd(host).catch((error: unknown) => {
        host.showError(t('commands.provider.addFailed', { error: formatErrorMessage(error) }));
      });
    },
    onDeleteSource: (providerIds) => {
      void handleProviderManagerDeleteSource(host, providerIds).catch((error: unknown) => {
        host.showError(t('commands.provider.removeFailed', { error: formatErrorMessage(error) }));
      });
    },
    onEditProvider: (providerId) => {
      void handleCustomProviderEdit(host, providerId).catch((error: unknown) => {
        host.showError(
          t('commands.provider.custom.saveFailed', { error: formatErrorMessage(error) }),
        );
      });
    },
    onEditGuard: (label) => {
      host.showStatus(t('commands.provider.edit.guard', { id: label }), 'warning');
    },
    onClose,
  };
}

/**
 * E on a custom provider row: run the edit wizard (type → URL → key →
 * optional re-probe → persist), then reopen the manager either way — the
 * wizard already reported updated/unchanged/aborted through the status line.
 */
async function handleCustomProviderEdit(
  host: SlashCommandHost,
  providerId: string,
): Promise<void> {
  await runCustomProviderEditWizard(host, providerId);
  reopenProviderManager(host);
}

async function handleProviderManagerDeleteSource(
  host: SlashCommandHost,
  providerIds: readonly string[],
): Promise<void> {
  for (const providerId of providerIds) {
    try {
      await handleProviderDelete(host, providerId);
    } catch (error) {
      const msg = formatErrorMessage(error);
      host.showError(t('commands.provider.deleteFailed', { id: providerId, error: msg }));
    }
  }
  reopenProviderManager(host);
}

async function handleProviderDelete(host: SlashCommandHost, providerId: string): Promise<void> {
  if (providerId === DEFAULT_OAUTH_PROVIDER_NAME) {
    await host.harness.auth.logout(DEFAULT_OAUTH_PROVIDER_NAME);
    await host.authFlow.refreshConfigAfterLogout();
    await host.authFlow.clearActiveSessionAfterLogout();
    return;
  }

  // Custom (standalone) providers: the RPC cascades to their models; repair
  // the active model by switching to a surviving one (with a notice) instead
  // of tearing the session down.
  if (isCustomProvider(providerId, host.state.appState.availableProviders[providerId])) {
    const removedAliases = new Set(
      providerModelAliases(host.state.appState.availableModels, providerId),
    );
    await host.harness.removeProvider(providerId);
    await revertActiveModelAfterRemoval(host, removedAliases);
    return;
  }

  const activeProvider =
    host.state.appState.availableModels[host.state.appState.model]?.provider;
  const config = await host.harness.removeProvider(providerId);
  if (activeProvider === providerId) {
    await host.authFlow.refreshConfigAfterLogout();
    await host.authFlow.clearActiveSessionAfterLogout();
  } else {
    host.setAppState({
      availableProviders: config.providers ?? {},
      availableModels: config.models ?? {},
    });
  }
}

async function handleProviderAdd(host: SlashCommandHost): Promise<void> {
  const source = await promptProviderAddSource(host);
  if (source === undefined) {
    reopenProviderManager(host);
    return;
  }

  if (source === 'known') {
    await handleCatalogProviderAdd(host);
    return;
  }
  if (source === 'manual') {
    await handleManualProviderAdd(host);
    return;
  }
  const handled = await handleCustomRegistryAddViaDialog(host);
  if (!handled) {
    reopenProviderManager(host);
  }
}

/**
 * Manual custom-endpoint flow: run the wizard (API type → base URL → key →
 * id → optional connectivity check → persist), then offer to chain straight
 * into the custom model wizard so the provider is usable immediately.
 */
async function handleManualProviderAdd(host: SlashCommandHost): Promise<void> {
  const providerId = await runCustomProviderWizard(host);
  if (providerId === undefined) {
    reopenProviderManager(host);
    return;
  }
  const next = await promptChoice(host, {
    title: t('commands.provider.custom.addModelNowTitle', { id: providerId }),
    options: [
      { value: 'model', label: t('commands.provider.custom.addModelNowYes') },
      { value: 'done', label: t('commands.provider.custom.addModelNowNo') },
    ],
  });
  if (next === 'model') {
    const alias = await runCustomModelWizard(host, { initialProviderId: providerId });
    if (alias !== undefined) {
      showModelPicker(host, alias);
      return;
    }
  }
  reopenProviderManager(host);
}

function reopenProviderManager(host: SlashCommandHost): void {
  const onClose = (): void => {
    host.restoreEditor(editorSlotHandle);
  };
  const component = new ProviderManagerComponent(buildProviderManagerOptions(host, onClose));
  const editorSlotHandle = host.mountEditorReplacement(component, { onPreempt: onClose });
}

function promptProviderAddSource(
  host: SlashCommandHost,
): Promise<'known' | 'custom' | 'manual' | undefined> {
  return new Promise((resolve) => {
    const onCancel = (): void => {
      host.restoreEditor(editorSlotHandle);
      resolve(undefined);
    };
    const picker = new ChoicePickerComponent({
      title: t('commands.provider.addTitle'),
      options: [
        { value: 'known', label: t('commands.provider.knownOption') },
        { value: 'custom', label: t('commands.provider.customOption') },
        { value: 'manual', label: t('commands.provider.manualOption') },
      ],
      onSelect: (value) => {
        host.restoreEditor(editorSlotHandle);
        resolve(value === 'known' || value === 'custom' || value === 'manual' ? value : undefined);
      },
      onCancel,
    });
    const editorSlotHandle = host.mountEditorReplacement(picker, { onPreempt: onCancel });
  });
}

async function handleCatalogProviderAdd(host: SlashCommandHost): Promise<void> {
  const controller = new AbortController();
  const cancel = (): void => {
    controller.abort();
  };
  host.cancelInFlight = cancel;

  const spinner = host.showLoginProgressSpinner(
    t('commands.provider.fetchingCatalog', { url: DEFAULT_CATALOG_URL }),
  );
  let catalog: Catalog | undefined;
  try {
    const loaded = await fetchCatalogOrBuiltIn(DEFAULT_CATALOG_URL, {
      signal: controller.signal,
      userAgent: createKimiCodeUserAgent(),
    });
    catalog = loaded.catalog;
    spinner.stop({
      ok: true,
      label: loaded.fromBuiltIn
        ? t('commands.provider.catalogLoadedBuiltIn')
        : t('commands.provider.catalogLoaded'),
    });
  } catch (error) {
    if (controller.signal.aborted) {
      spinner.stop({ ok: false, label: t('commands.provider.catalogAborted') });
    } else {
      const hint =
        error instanceof CatalogFetchError
          ? t('commands.provider.catalogHttpHint', { status: error.status })
          : '';
      spinner.stop({ ok: false, label: t('commands.provider.catalogLoadFailed') });
      host.showError(
        t('commands.provider.catalogFetchFailed', { hint, error: formatErrorMessage(error) }),
      );
    }
  } finally {
    if (host.cancelInFlight === cancel) host.cancelInFlight = undefined;
  }

  if (catalog === undefined) return;

  const providerId = await promptCatalogProviderSelection(host, catalog);
  if (providerId === undefined) return;
  const entry = catalog[providerId];
  if (entry === undefined) return;

  const models = catalogProviderModels(entry);
  if (models.length === 0) {
    host.showError(t('commands.provider.noUsableModels', { id: providerId }));
    return;
  }

  let resolution = resolveCatalogImport(entry);
  if (resolution.kind === 'needs-base-url') {
    const entered = await promptBaseUrl(host, entry.name ?? providerId);
    if (entered === undefined) return;
    resolution = resolveCatalogImport(entry, entered);
  }
  if (resolution.kind !== 'ok') {
    if (resolution.kind === 'invalid') {
      if (resolution.reason === 'unknown-explicit-type') {
        host.showError(t('commands.provider.unknownExplicitType', { id: providerId, type: entry.type ?? 'unknown' }));
      } else if (resolution.reason === 'proprietary-sdk') {
        host.showError(t('commands.provider.proprietarySdk', { id: providerId }));
      } else {
        host.showError(t('commands.provider.baseUrlPlaceholder'));
      }
    }
    return;
  }
  const { wire, baseUrl } = resolution;

  const apiKey = await promptApiKey(host, entry.name ?? providerId);
  if (apiKey === undefined) return;

  // Persist the provider and all its models immediately after the api key is
  // entered. The model selector that follows is just a convenience to pick the
  // default model; ESC leaves the provider in place without a default selection.
  const existingConfig = await host.harness.getConfig();
  if (existingConfig.providers[providerId] !== undefined) {
    await host.harness.removeProvider(providerId);
  }

  const config = await host.harness.getConfig();
  applyCatalogProvider(config, {
    providerId,
    wire,
    baseUrl,
    apiKey,
    models,
    selectedModelId: '', // no default yet; user picks in the model selector
    thinking: false,    // will be resolved by the model selector
  });

  await host.harness.setConfig({
    providers: config.providers,
    models: config.models,
  });

  await host.authFlow.refreshConfigAfterLogin();
  host.showStatus(t('commands.provider.added', { name: entry.name ?? providerId }));
  if (resolution.guessed) {
    host.showStatus(t('commands.provider.protocolGuessed', { id: providerId }));
  }

  // Build a merged model dictionary that includes existing models plus the
  // newly-persisted provider's models, so the tabbed selector shows every
  // provider's tab (the new provider's tab starts active via initialTabId).
  const stateModels = await host.harness.getConfig().then((c) => c.models ?? {});
  const mergedModels = { ...stateModels };

  const onCancel = (): void => {
    host.restoreEditor(editorSlotHandle);
  };
  const selector = new TabbedModelSelectorComponent({
    models: mergedModels,
    currentValue: host.state.appState.model,
    selectedValue: Object.keys(mergedModels).find((a) => a.startsWith(`${providerId}/`)),
    currentThinkingEffort: host.state.appState.thinkingEffort,
    initialTabId: providerId,
    onSelect: ({ alias, thinking }) => {
      host.restoreEditor(editorSlotHandle);
      void setDefaultModel(host, alias, thinking).catch((error: unknown) => {
        host.showError(
          t('commands.provider.setDefaultFailed', { error: formatErrorMessage(error) }),
        );
      });
    },
    onCancel,
  });
  const editorSlotHandle = host.mountEditorReplacement(selector, { onPreempt: onCancel });
}

async function setDefaultModel(
  host: SlashCommandHost,
  alias: string,
  effort: ThinkingEffort,
): Promise<void> {
  // Resolve efforts the same way the /model path does (effectiveModelForHost
  // applies overrides and the protocol-profile inference): catalog entries for
  // e.g. Anthropic models declare no support_efforts on the alias, and without
  // the inference a top-tier pick would slip through as a persisted effort.
  const model = host.state.appState.availableModels[alias];
  await host.harness.setConfig({
    defaultModel: alias,
    thinking: thinkingEffortToConfig(
      effort,
      model === undefined ? undefined : effectiveModelForHost(host, model).supportEfforts,
    ),
  });
  await host.authFlow.refreshConfigAfterLogin();
  host.showStatus(t('commands.provider.defaultSet', { alias, effort }));
}

async function handleCustomRegistryAddViaDialog(host: SlashCommandHost): Promise<boolean> {
  const value = await promptCustomRegistryImport(host);
  if (value === undefined) return false;

  const source: CustomRegistrySource = {
    kind: 'apiJson',
    url: value.url,
    apiKey: value.apiKey,
  };

  let entries: Awaited<ReturnType<typeof fetchCustomRegistry>>;
  try {
    entries = await fetchCustomRegistry(source, { userAgent: createKimiCodeUserAgent() });
  } catch (error) {
    host.showError(t('commands.provider.importFailed', { error: formatErrorMessage(error) }));
    return false;
  }

  const addedProviderIds = Object.values(entries).map((entry) => entry.id);
  try {
    const config = await host.harness.getConfig();
    applyCustomRegistryEntries(
      config as unknown as ManagedKimiConfigShape,
      entries,
      source,
    );
    await host.harness.setConfig({
      providers: config.providers,
      models: config.models,
    });
    await host.authFlow.refreshConfigAfterLogin();
  } catch (error) {
    host.showError(t('commands.provider.applyFailed', { error: formatErrorMessage(error) }));
    return false;
  }

  const count = addedProviderIds.length;
  if (count === 0) {
    host.showStatus(t('commands.provider.registryEmpty'));
    return false;
  }
  host.showStatus(
    t(count === 1 ? 'commands.provider.imported.one' : 'commands.provider.imported.other', {
      count,
    }),
    'success',
  );

  // Offer the model selector so the user can pick a default, just like the
  // catalog (known-provider) flow.
  const stateModels = await host.harness.getConfig().then((c) => c.models ?? {});
  const firstNewAlias = Object.keys(stateModels).find((a) =>
    addedProviderIds.some((pid) => a.startsWith(`${pid}/`)),
  );
  const firstNewProvider = firstNewAlias
    ? stateModels[firstNewAlias]?.provider
    : addedProviderIds[0];
  const onCancel = (): void => {
    host.restoreEditor(editorSlotHandle);
  };
  const selector = new TabbedModelSelectorComponent({
    models: stateModels,
    currentValue: host.state.appState.model,
    selectedValue: firstNewAlias,
    currentThinkingEffort: host.state.appState.thinkingEffort,
    initialTabId: firstNewProvider,
    onSelect: ({ alias, thinking }) => {
      host.restoreEditor(editorSlotHandle);
      void setDefaultModel(host, alias, thinking).catch((error: unknown) => {
        host.showError(
          t('commands.provider.setDefaultFailed', { error: formatErrorMessage(error) }),
        );
      });
    },
    onCancel,
  });
  const editorSlotHandle = host.mountEditorReplacement(selector, { onPreempt: onCancel });
  return true;
}

function promptCustomRegistryImport(
  host: SlashCommandHost,
): Promise<{ readonly url: string; readonly apiKey: string } | undefined> {
  return new Promise((resolve) => {
    const dialog = new CustomRegistryImportDialogComponent(
      (result: CustomRegistryImportResult) => {
        host.restoreEditor(editorSlotHandle);
        resolve(result.kind === 'ok' ? result.value : undefined);
      },
    );
    const editorSlotHandle = host.mountEditorReplacement(dialog, {
      // Same unwind as the component's own cancel result: abort the pending
      // prompt and let the add flow fall back to the manager.
      onPreempt: () => {
        host.restoreEditor(editorSlotHandle);
        resolve(undefined);
      },
    });
  });
}
