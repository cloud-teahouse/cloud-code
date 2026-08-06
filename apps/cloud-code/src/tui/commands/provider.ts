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
  type ProviderType,
  type ThinkingEffort,
} from '@cloud-code/sdk';

import { createCloudCodeUserAgent } from '#/cli/version';
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

/**
 * Where the manager's close should land next — set by every entry through
 * {@link handleProviderCommand} (undefined = the editor, the /provider
 * default; /settings passes a reopen of its own menu). Internal sub-flows
 * reopen the manager without touching it, so the destination survives the
 * whole add/edit/delete flow, and onClose consumes it so nothing goes stale
 * when the manager is torn down without closing.
 */
let providerManagerReturnTo: (() => void) | undefined;

export async function handleProviderCommand(
  host: SlashCommandHost,
  returnTo?: () => void,
): Promise<void> {
  providerManagerReturnTo = returnTo;
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
    onViewModels: (providerId) => {
      openProviderModelsTab(host, providerId);
    },
    onAddModel: (providerId) => {
      void runCustomModelWizard(host, { initialProviderId: providerId })
        .catch((error: unknown) => {
          host.showError(
            t('commands.model.add.saveFailed', { error: formatErrorMessage(error) }),
          );
          return undefined;
        })
        .then((alias) => {
          // A created alias opens the model picker on it (same unwind as the
          // manual provider flow); an abort returns to the manager.
          if (alias === undefined) reopenProviderManager(host);
          else showModelPicker(host, alias);
        });
    },
    onAddModelGuard: (label) => {
      host.showStatus(t('commands.provider.addModel.guard', { id: label }), 'warning');
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
 * Enter on a source row: the tabbed model picker opened on that provider's
 * tab — browse its models, pick one to make it the default. Cancel returns
 * to the provider manager.
 */
function openProviderModelsTab(host: SlashCommandHost, providerId: string): void {
  const onCancel = (): void => {
    host.restoreEditor(editorSlotHandle);
    reopenProviderManager(host);
  };
  const selector = new TabbedModelSelectorComponent({
    models: host.state.appState.availableModels,
    currentValue: host.state.appState.model,
    selectedValue: Object.keys(host.state.appState.availableModels).find((a) =>
      a.startsWith(`${providerId}/`),
    ),
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
  let failed = 0;
  for (const providerId of providerIds) {
    try {
      await handleProviderDelete(host, providerId);
    } catch (error) {
      failed += 1;
      const msg = formatErrorMessage(error);
      host.showError(t('commands.provider.deleteFailed', { id: providerId, error: msg }));
    }
  }
  const deleted = providerIds.length - failed;
  if (deleted > 0) {
    host.showStatus(
      t(deleted === 1 ? 'commands.provider.deleted.one' : 'commands.provider.deleted.other', {
        id: providerIds[0] ?? '',
        count: deleted,
      }),
      'success',
    );
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
    const returnTo = providerManagerReturnTo;
    providerManagerReturnTo = undefined;
    returnTo?.();
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
      userAgent: createCloudCodeUserAgent(),
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

  // Step loop: Esc at the base-URL / API-key steps goes back one step; Esc at
  // the provider picker returns to the provider manager. Only the post-persist
  // default-model pick aborts without unwinding (the provider stays, by design).
  let step = 0;
  let providerId: string | undefined;
  let baseUrl: string | undefined;
  let wire: ProviderType | undefined;
  let guessed = false;
  let needsBaseUrl = false;

  for (;;) {
    if (step === 0) {
      const picked = await promptCatalogProviderSelection(host, catalog);
      if (picked === undefined) {
        reopenProviderManager(host);
        return;
      }
      const entry = catalog[picked];
      if (entry === undefined) {
        reopenProviderManager(host);
        return;
      }
      const models = catalogProviderModels(entry);
      if (models.length === 0) {
        host.showError(t('commands.provider.noUsableModels', { id: picked }));
        continue;
      }
      const resolution = resolveCatalogImport(entry);
      if (resolution.kind === 'invalid') {
        if (resolution.reason === 'unknown-explicit-type') {
          host.showError(t('commands.provider.unknownExplicitType', { id: picked, type: entry.type ?? 'unknown' }));
        } else if (resolution.reason === 'proprietary-sdk') {
          host.showError(t('commands.provider.proprietarySdk', { id: picked }));
        } else {
          host.showError(t('commands.provider.baseUrlPlaceholder'));
        }
        continue;
      }
      providerId = picked;
      wire = resolution.wire;
      guessed = resolution.guessed;
      needsBaseUrl = resolution.kind === 'needs-base-url';
      baseUrl = resolution.kind === 'ok' ? resolution.baseUrl : undefined;
      step = needsBaseUrl ? 1 : 2;
      continue;
    }
    if (step === 1) {
      const entry = catalog[providerId!]!;
      const entered = await promptBaseUrl(host, entry.name ?? providerId!, true);
      if (entered === undefined) {
        step = 0;
        continue;
      }
      const resolution = resolveCatalogImport(entry, entered);
      if (resolution.kind !== 'ok') {
        host.showError(t('commands.provider.baseUrlPlaceholder'));
        step = 0;
        continue;
      }
      wire = resolution.wire;
      guessed = resolution.guessed;
      baseUrl = resolution.baseUrl;
      step = 2;
      continue;
    }
    const entry = catalog[providerId!]!;
    const apiKey = await promptApiKey(host, entry.name ?? providerId!, undefined, true);
    if (apiKey === undefined) {
      step = needsBaseUrl ? 1 : 0;
      continue;
    }

    // Persist the provider and all its models immediately after the api key is
    // entered. The model selector that follows is just a convenience to pick the
    // default model; ESC leaves the provider in place without a default selection.
    const existingConfig = await host.harness.getConfig();
    if (existingConfig.providers[providerId!] !== undefined) {
      await host.harness.removeProvider(providerId!);
    }

    const config = await host.harness.getConfig();
    applyCatalogProvider(config, {
      providerId: providerId!,
      wire: wire!,
      baseUrl,
      apiKey,
      models: catalogProviderModels(entry),
      selectedModelId: '', // no default yet; user picks in the model selector
      thinking: false,    // will be resolved by the model selector
    });

    await host.harness.setConfig({
      providers: config.providers,
      models: config.models,
    });

    await host.authFlow.refreshConfigAfterLogin();
    host.showStatus(t('commands.provider.added', { name: entry.name ?? providerId! }));
    if (guessed) {
      host.showStatus(t('commands.provider.protocolGuessed', { id: providerId! }));
    }
    break;
  }

  // Build a merged model dictionary that includes existing models plus the
  // newly-persisted provider's models, so the tabbed selector shows every
  // provider's tab (the new provider's tab starts active via initialTabId).
  const stateModels = await host.harness.getConfig().then((c) => c.models ?? {});
  const mergedModels = { ...stateModels };

  const onCancel = (): void => {
    host.restoreEditor(editorSlotHandle);
    reopenProviderManager(host);
  };
  const selector = new TabbedModelSelectorComponent({
    models: mergedModels,
    currentValue: host.state.appState.model,
    selectedValue: Object.keys(mergedModels).find((a) => a.startsWith(`${providerId!}/`)),
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
    entries = await fetchCustomRegistry(source, { userAgent: createCloudCodeUserAgent() });
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
