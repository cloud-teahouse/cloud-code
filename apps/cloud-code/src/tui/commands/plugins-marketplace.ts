import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  MarketplaceRemoveConfirmComponent,
  MarketplaceTrustConfirmComponent,
} from '../components/dialogs/plugins-selector';
import { UsagePanelComponent } from '../components/messages/usage-panel';
import { t } from '../i18n';
import { formatErrorMessage } from '../utils/event-payload';
import { isOfficialPluginSource } from '../utils/plugin-source-label';
import {
  loadPluginMarketplace,
  type PluginMarketplaceEntry,
} from '#/utils/plugin-marketplace';
import {
  addMarketplace,
  getMarketplace,
  isValidMarketplaceName,
  listMarketplaces,
  removeMarketplace,
  type PluginMarketplaceRegistration,
} from '#/utils/plugin-marketplace-registry';
import {
  loadCatalogForRegistration,
  materializeMarketplaceSource,
  parseMarketplaceSourceInput,
  refreshMarketplaceCatalog,
  removeMarketplaceClone,
  suggestMarketplaceName,
  type ParsedMarketplaceSource,
} from '#/utils/plugin-marketplace-sources';
import type { SlashCommandHost } from './dispatch';
import { installMarketplaceEntry, truncateForStatus } from './plugins-install';
import { promptChoice, promptInput } from './prompts';

/**
 * `/plugins marketplace …` flows: register (wizard or args), remove, list,
 * refresh, plus installs that name a marketplace (`plugin@marketplace` or a
 * bare plugin name searched across all registered catalogs).
 *
 * The registry lives in utils/plugin-marketplace-registry.ts, source parsing
 * and git materialization in utils/plugin-marketplace-sources.ts; this module
 * owns the user-facing flow (trust prompt, spinners, confirmations).
 */

const ADD_SOURCE_TYPES = ['github', 'git', 'url', 'local'] as const;
type AddSourceType = (typeof ADD_SOURCE_TYPES)[number];

/** `/plugins marketplace add` — no args runs the wizard; `<name> <source>` validates and registers directly. */
export async function handleMarketplaceAdd(
  host: SlashCommandHost,
  name: string | undefined,
  source: string,
): Promise<void> {
  if (name === undefined && source.length === 0) {
    await runMarketplaceAddWizard(host);
    return;
  }
  if (name === undefined || source.length === 0) {
    host.showError(t('plugins.command.usageMarketplaceAdd'));
    return;
  }
  const parsed = parseMarketplaceSourceInput(source, host.state.appState.workDir);
  if (!(await confirmMarketplaceTrust(host, parsed.source))) {
    host.showStatus(t('plugins.command.marketplaceAddCancelled'));
    return;
  }
  await validateAndRegisterMarketplace(host, name, parsed);
}

/**
 * The guided add flow: source type → source → name → trust → validate →
 * register. Esc at any prompt aborts. The manifest is fetched (git sources:
 * cloned) only after the trust opt-in, and its declared plugin count is
 * reported on success.
 */
async function runMarketplaceAddWizard(host: SlashCommandHost): Promise<void> {
  const workDir = host.state.appState.workDir;
  const kind = await promptChoice(host, {
    title: t('plugins.marketplaceAdd.typeTitle'),
    options: ADD_SOURCE_TYPES.map((value) => ({
      value,
      label: t(`plugins.marketplaceAdd.type.${value}.label`),
      description: t(`plugins.marketplaceAdd.type.${value}.description`),
    })),
  });
  if (!ADD_SOURCE_TYPES.includes(kind as AddSourceType)) return;
  const sourceType = kind as AddSourceType;

  const input = await promptInput(host, {
    title: t('plugins.marketplaceAdd.sourceTitle', {
      type: t(`plugins.marketplaceAdd.type.${sourceType}.label`),
    }),
    subtitleLines: [t(`plugins.marketplaceAdd.sourceSubtitle.${sourceType}`)],
    validate: (value) => {
      try {
        const parsed = parseMarketplaceSourceInput(value, workDir);
        return parsed.kind === sourceType
          ? undefined
          : t('plugins.marketplaceAdd.sourceKindMismatch', {
              type: t(`plugins.marketplaceAdd.type.${sourceType}.label`),
            });
      } catch (error) {
        return formatErrorMessage(error);
      }
    },
  });
  if (input === undefined) return;
  const parsed = parseMarketplaceSourceInput(input, workDir);

  const taken = new Set((await listMarketplaces()).map((entry) => entry.name));
  const name = await promptInput(host, {
    title: t('plugins.marketplaceAdd.nameTitle'),
    subtitleLines: [t('plugins.marketplaceAdd.nameSubtitle')],
    initialValue: suggestMarketplaceName(parsed),
    validate: (value) => {
      if (!isValidMarketplaceName(value)) {
        return t('plugins.marketplaceAdd.nameInvalid');
      }
      return taken.has(value) ? t('plugins.marketplaceAdd.nameTaken', { name: value }) : undefined;
    },
  });
  if (name === undefined) return;

  if (!(await confirmMarketplaceTrust(host, parsed.source))) {
    host.showStatus(t('plugins.command.marketplaceAddCancelled'));
    return;
  }
  await validateAndRegisterMarketplace(host, name, parsed);
}

/** Fetch/clone + parse the manifest, then register. On validation failure a
 * freshly created clone is discarded so a retry starts clean. */
async function validateAndRegisterMarketplace(
  host: SlashCommandHost,
  name: string,
  parsed: ParsedMarketplaceSource,
): Promise<void> {
  const spinner = host.showProgressSpinner(
    t('plugins.command.marketplaceValidating', { source: truncateForStatus(parsed.source) }),
  );
  try {
    const catalog = await materializeMarketplaceSource(name, parsed, {
      workDir: host.state.appState.workDir,
    });
    const entry = await addMarketplace(name, {
      source: parsed.source,
      sourceKind: parsed.kind,
      ...(parsed.ref !== undefined ? { ref: parsed.ref } : {}),
    });
    spinner.stop({ ok: true, label: t('plugins.command.marketplaceValidated') });
    host.showStatus(
      t('plugins.command.marketplaceAdded', {
        name: entry.name,
        source: entry.source,
        count: catalog.plugins.length,
      }),
    );
  } catch (error) {
    await removeMarketplaceClone(name, parsed.kind);
    spinner.stop({
      ok: false,
      label: t('plugins.command.marketplaceValidateFailed', { error: formatErrorMessage(error) }),
    });
    throw error;
  }
}

/** Third-party marketplaces get the same trust precedent as third-party
 * plugin installs: cancel-first, explicit opt-in before any fetch/clone. */
async function confirmMarketplaceTrust(host: SlashCommandHost, label: string): Promise<boolean> {
  return new Promise((resolveConfirmed) => {
    const editorSlotHandle = host.mountEditorReplacement(
      new MarketplaceTrustConfirmComponent({
        label,
        onDone: (result) => {
          host.restoreEditor(editorSlotHandle);
          resolveConfirmed(result.kind === 'confirm');
        },
      }),
      {
        onPreempt: () => {
          host.restoreEditor(editorSlotHandle);
          resolveConfirmed(false);
        },
      },
    );
  });
}

/**
 * `/plugins marketplace remove <name>`: confirm first, listing the installed
 * plugins traced back to this marketplace. Removal only drops the
 * registration (and the cached clone); installed plugins stay — the confirm
 * dialog says so explicitly.
 */
export async function removeMarketplaceFlow(host: SlashCommandHost, name: string): Promise<void> {
  const registration = await getMarketplace(name);
  if (registration === undefined) {
    await removeMarketplace(name); // throws the canonical "not registered" error
    return;
  }
  if (registration.builtin === true) {
    await removeMarketplace(name); // throws the canonical "reserved" error
    return;
  }
  const affectedPlugins = await findAffectedPlugins(host, registration);
  const confirmed = await new Promise<boolean>((resolveConfirmed) => {
    const editorSlotHandle = host.mountEditorReplacement(
      new MarketplaceRemoveConfirmComponent({
        name,
        ...(affectedPlugins !== undefined ? { affectedPlugins } : {}),
        onDone: (result) => {
          host.restoreEditor(editorSlotHandle);
          resolveConfirmed(result.kind === 'confirm');
        },
      }),
      {
        onPreempt: () => {
          host.restoreEditor(editorSlotHandle);
          resolveConfirmed(false);
        },
      },
    );
  });
  if (!confirmed) {
    host.showStatus(t('plugins.command.marketplaceRemoveCancelled', { name }));
    return;
  }
  await removeMarketplace(name);
  await removeMarketplaceClone(name, registration.sourceKind);
  host.showStatus(t('plugins.command.marketplaceRemoved', { name }));
}

/**
 * Installed plugins whose recorded install source matches a catalog entry of
 * this marketplace — a best-effort provenance check for the remove confirm.
 * Undefined when the catalog cannot be loaded (the dialog says so).
 */
async function findAffectedPlugins(
  host: SlashCommandHost,
  registration: PluginMarketplaceRegistration,
): Promise<readonly string[] | undefined> {
  let catalogSources: Set<string>;
  try {
    const catalog = await loadCatalogForRegistration(registration, {
      workDir: host.state.appState.workDir,
    });
    catalogSources = new Set(catalog.plugins.map((entry) => entry.source));
  } catch {
    return undefined;
  }
  const installed = await host.requireSession().listPlugins();
  return installed
    .filter((plugin) => plugin.originalSource !== undefined && catalogSources.has(plugin.originalSource))
    .map((plugin) => plugin.displayName);
}

/** `/plugins marketplace list`: every registered marketplace with its plugin
 * count (catalogs load in parallel; failures degrade to an error marker). */
export async function renderMarketplaceList(host: SlashCommandHost): Promise<void> {
  const marketplaces = await listMarketplaces();
  const rows = await Promise.all(
    marketplaces.map(async (registration) => {
      let count: string;
      try {
        const catalog = await loadCatalogForRegistration(registration, {
          workDir: host.state.appState.workDir,
        });
        count = t('plugins.command.marketplacePluginCount', { count: catalog.plugins.length });
      } catch {
        count = t('plugins.command.marketplaceUnavailable');
      }
      return { registration, count };
    }),
  );
  const title = t('plugins.command.marketplaceListTitle', { count: marketplaces.length });
  const panel = new UsagePanelComponent(
    () =>
      rows.map(({ registration, count }) =>
        registration.builtin === true
          ? ` ${registration.name}  ${registration.source}  ${count} (${t('plugins.command.marketplaceDefault')})`
          : ` ${registration.name}  ${registration.source}  ${count}`,
      ),
    'primary',
    title,
  );
  host.state.transcriptContainer.addChild(panel);
  host.state.ui.requestRender();
}

/** `/plugins marketplace refresh [name]`: re-fetch/re-clone catalogs and
 * report the fresh plugin counts. Without a name every marketplace (official
 * included) is refreshed. */
export async function refreshMarketplaces(
  host: SlashCommandHost,
  name: string | undefined,
): Promise<void> {
  const targets =
    name === undefined
      ? await listMarketplaces()
      : [await getMarketplace(name)].filter(
          (entry): entry is PluginMarketplaceRegistration => entry !== undefined,
        );
  if (targets.length === 0) {
    host.showError(t('plugins.command.marketplaceNotRegistered', { name: name ?? '' }));
    return;
  }
  for (const target of targets) {
    const spinner = host.showProgressSpinner(
      t('plugins.command.marketplaceRefreshing', { name: target.name }),
    );
    try {
      const catalog = await refreshMarketplaceCatalog(target, {
        workDir: host.state.appState.workDir,
      });
      spinner.stop({
        ok: true,
        label: t('plugins.command.marketplaceRefreshed', {
          name: target.name,
          count: catalog.plugins.length,
        }),
      });
    } catch (error) {
      spinner.stop({
        ok: false,
        label: t('plugins.command.marketplaceRefreshFailed', {
          name: target.name,
          error: formatErrorMessage(error),
        }),
      });
    }
  }
}

/**
 * Intercept `/plugins install <arg>` forms that name a marketplace:
 * `plugin@marketplace` installs that entry from the named marketplace; a bare
 * plugin name (that is not an existing local directory) is searched across
 * the official catalog and every registered marketplace, with a picker when
 * several carry it. Returns false when the arg is an ordinary source and the
 * caller should run the regular install flow.
 */
export async function tryInstallFromMarketplace(
  host: SlashCommandHost,
  source: string,
): Promise<boolean> {
  const workDir = host.state.appState.workDir;
  const qualified = /^([a-zA-Z0-9][a-zA-Z0-9._-]*)@([a-z0-9][a-z0-9_-]{0,63})$/.exec(source);
  if (qualified !== null) {
    const registration = await getMarketplace(qualified[2]!);
    // Not a registered marketplace — fall through to the raw source flow so
    // paths containing "@" keep working.
    if (registration === undefined) return false;
    const catalog = await loadCatalogForRegistration(registration, { workDir });
    const entry = catalog.plugins.find((candidate) => candidate.id === qualified[1]);
    if (entry === undefined) {
      host.showError(
        t('plugins.command.marketplaceEntryNotFound', {
          id: qualified[1]!,
          marketplace: registration.name,
          available: summarizeEntryIds(catalog.plugins),
        }),
      );
      return true;
    }
    await installMarketplaceEntry(host, entry, isOfficialPluginSource(entry.source));
    return true;
  }

  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(source)) return false;
  // A bare name that exists as a directory in the cwd stays a local install.
  if ((await stat(resolve(workDir, source)).catch(() => undefined))?.isDirectory() === true) {
    return false;
  }
  await searchAndInstallMarketplaceEntry(host, source);
  return true;
}

/** Bare-name install: collect matches from the official catalog and every
 * registered marketplace, then install directly (one match) or via a
 * marketplace picker (several). */
async function searchAndInstallMarketplaceEntry(host: SlashCommandHost, id: string): Promise<void> {
  const workDir = host.state.appState.workDir;
  const registrations = await listMarketplaces();
  const matches: { registration: PluginMarketplaceRegistration; entry: PluginMarketplaceEntry }[] =
    [];

  // The official catalog is env-override aware, so load it through the plain
  // loader rather than the registration's URL.
  const officialCatalog = await loadPluginMarketplace({ workDir }).catch(() => undefined);
  const officialEntry = officialCatalog?.plugins.find((candidate) => candidate.id === id);
  if (officialCatalog !== undefined && officialEntry !== undefined) {
    matches.push({ registration: registrations[0]!, entry: officialEntry });
  }

  await Promise.all(
    registrations
      .filter((registration) => registration.builtin !== true)
      .map(async (registration) => {
        try {
          const catalog = await loadCatalogForRegistration(registration, { workDir });
          const entry = catalog.plugins.find((candidate) => candidate.id === id);
          if (entry !== undefined) matches.push({ registration, entry });
        } catch {
          // An unreachable marketplace simply contributes no match.
        }
      }),
  );

  if (matches.length === 0) {
    host.showError(t('plugins.command.installNotFound', { id }));
    return;
  }
  const chosen =
    matches.length === 1
      ? matches[0]!
      : await promptMarketplacePick(host, id, matches);
  if (chosen === undefined) {
    host.showStatus(t('plugins.command.installCancelled'));
    return;
  }
  await installMarketplaceEntry(host, chosen.entry, isOfficialPluginSource(chosen.entry.source));
}

async function promptMarketplacePick(
  host: SlashCommandHost,
  id: string,
  matches: readonly { registration: PluginMarketplaceRegistration; entry: PluginMarketplaceEntry }[],
): Promise<{ registration: PluginMarketplaceRegistration; entry: PluginMarketplaceEntry } | undefined> {
  const value = await promptChoice(host, {
    title: t('plugins.command.installPickMarketplace', { id }),
    options: matches.map((match, index) => ({
      value: String(index),
      label: match.registration.name,
      description: match.registration.source,
    })),
  });
  if (value === undefined) return undefined;
  return matches[Number(value)];
}

function summarizeEntryIds(entries: readonly PluginMarketplaceEntry[]): string {
  const limit = 10;
  const ids = entries.slice(0, limit).map((entry) => entry.id);
  const suffix = entries.length > limit ? ', …' : '';
  return ids.join(', ') + suffix;
}
