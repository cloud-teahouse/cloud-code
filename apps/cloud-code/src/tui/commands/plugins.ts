import type { PluginInfo, PluginSummary } from '@cloud-code/sdk';

import {
  PluginMcpSelectorComponent,
  PluginRemoveConfirmComponent,
  PluginsPanelComponent,
  type PluginMcpSelection,
  type PluginRemoveConfirmResult,
  type PluginsPanelSelection,
  type PluginsPanelTabId,
} from '../components/dialogs/plugins-selector';
import {
  buildPluginsInfoLines,
  buildPluginsListLines,
} from '../components/messages/plugins-status-panel';
import { UsagePanelComponent } from '../components/messages/usage-panel';
import type { EditorSlotHandle } from '../editor-slot';
import { resolveDescription, t } from '../i18n';
import { formatErrorMessage } from '../utils/event-payload';
import { isOfficialPluginSource } from '../utils/plugin-source-label';
import { loadPluginMarketplace, type PluginMarketplaceEntry } from '#/utils/plugin-marketplace';
import {
  getMarketplace,
  listMarketplaces,
  type PluginMarketplaceRegistration,
} from '#/utils/plugin-marketplace-registry';
import {
  loadCatalogForRegistration,
  loadMarketplaceCatalogForSource,
  parseMarketplaceSourceInput,
} from '#/utils/plugin-marketplace-sources';
import { openUrl } from '#/utils/open-url';
import type { SlashCommandHost } from './dispatch';
import {
  confirmInstallTrust,
  installPluginFromSource,
  PLUGIN_RELOAD_HINT,
  truncateForStatus,
} from './plugins-install';
import {
  handleMarketplaceAdd,
  refreshMarketplaces,
  removeMarketplaceFlow,
  renderMarketplaceList,
  tryInstallFromMarketplace,
} from './plugins-marketplace';

interface ShowPluginsPickerOptions {
  readonly selectedId?: string;
  readonly pluginHint?: {
    readonly id: string;
    readonly text: string;
  };
  readonly initialTab?: PluginsPanelTabId;
  /** Browse one registered marketplace (its catalog comes from the typed
   * source — clone/fetch/read — not from a guessed URL). */
  readonly marketplace?: PluginMarketplaceRegistration;
  /** Ad-hoc marketplace source (URL or local path) for unregistered browse. */
  readonly marketplaceSource?: string;
}

interface PluginMcpServerHint {
  readonly server: string;
  readonly text: string;
}

interface ShowPluginMcpPickerOptions {
  readonly selectedServer?: string;
  readonly serverHint?: PluginMcpServerHint;
}

export async function handlePluginsCommand(host: SlashCommandHost, rawArgs: string): Promise<void> {
  const args = rawArgs.trim().split(/\s+/).filter((part) => part.length > 0);
  const sub = args[0];
  const rest = args.slice(1);
  const session = host.requireSession();

  try {
    if (sub === undefined) {
      await showPluginsPicker(host);
      return;
    }
    if (sub === 'list') {
      await renderPluginsList(host);
      return;
    }
    if (sub === 'install') {
      const source = rest.join(' ').trim();
      if (source.length === 0) {
        host.showError(t('plugins.command.usageInstall'));
        return;
      }
      // `plugin@marketplace` and bare plugin names resolve against the
      // registered marketplaces; anything else is an ordinary source.
      if (await tryInstallFromMarketplace(host, source)) {
        return;
      }
      if (!(await confirmInstallTrust(host, source, isOfficialPluginSource(source)))) {
        host.showStatus(t('plugins.command.installCancelled'));
        return;
      }
      const spinner = host.showProgressSpinner(
        t('plugins.command.installingFrom', { source: truncateForStatus(source) }),
      );
      try {
        await installPluginFromSource(host, source);
        spinner.stop({ ok: true, label: t('plugins.command.installFinished') });
      } catch (error) {
        spinner.stop({
          ok: false,
          label: t('plugins.command.installFailedSpinner', { error: formatErrorMessage(error) }),
        });
        throw error;
      }
      return;
    }
    if (sub === 'marketplace') {
      const action = rest[0];
      if (action === 'add') {
        await handleMarketplaceAdd(host, rest[1], rest.slice(2).join(' ').trim());
        return;
      }
      if (action === 'remove') {
        const name = rest[1];
        if (name === undefined) {
          host.showError(t('plugins.command.usageMarketplaceRemove'));
          return;
        }
        await removeMarketplaceFlow(host, name);
        return;
      }
      if (action === 'list') {
        await renderMarketplaceList(host);
        return;
      }
      if (action === 'refresh' || action === 'update') {
        await refreshMarketplaces(host, rest[1]);
        return;
      }
      const marketplaceArg = rest.join(' ').trim() || undefined;
      if (marketplaceArg === undefined) {
        await showPluginsPicker(host, { initialTab: 'official' });
        return;
      }
      const registration = await getMarketplace(marketplaceArg);
      if (registration !== undefined) {
        await showPluginsPicker(host, {
          // Custom marketplaces often omit `tier`, so their entries land on the
          // Third-party tab (entry.tier !== 'official'). Open there when a custom
          // source is supplied; otherwise the default catalog's official entries
          // make Official the right landing tab.
          initialTab: registration.builtin === true ? 'official' : 'third-party',
          marketplace: registration,
        });
        return;
      }
      // Unregistered argument: treat it as an ad-hoc marketplace source.
      await showPluginsPicker(host, {
        initialTab: 'third-party',
        marketplaceSource: marketplaceArg,
      });
      return;
    }
    if (sub === 'info') {
      const id = rest[0];
      if (id === undefined) {
        await showPluginsPicker(host);
        return;
      }
      await renderPluginInfo(host, id);
      return;
    }
    if (sub === 'mcp') {
      const action = rest[0];
      const id = rest[1];
      const server = rest[2];
      if ((action !== 'enable' && action !== 'disable') || id === undefined || server === undefined) {
        host.showError(t('plugins.command.usageMcp'));
        return;
      }
      await session.setPluginMcpServerEnabled(id, server, action === 'enable');
      host.showStatus(
        t(action === 'enable' ? 'plugins.command.mcpEnabled' : 'plugins.command.mcpDisabled', {
          server,
          id,
        }),
      );
      return;
    }
    if (sub === 'enable' || sub === 'disable') {
      const id = rest[0];
      if (id === undefined) {
        await showPluginsPicker(host);
        return;
      }
      const scope = parseEnableScopeFlag(rest.slice(1));
      if (scope === 'invalid') {
        host.showError(t('plugins.command.usageEnableScope', { action: sub }));
        return;
      }
      await applyPluginEnabled(host, id, sub === 'enable', true, scope);
      return;
    }
    if (sub === 'remove' || sub === 'uninstall') {
      const id = rest[0];
      if (id === undefined) {
        host.showError(t('plugins.command.usageRemove'));
        return;
      }
      if (!(await confirmRemovePlugin(host, id))) {
        host.showStatus(t('plugins.command.removeCancelled', { id }));
        return;
      }
      await removePlugin(host, id);
      return;
    }
    if (sub === 'reload') {
      await reloadPlugins(host);
      return;
    }
    const plugins = await session.listPlugins();
    if (plugins.some((plugin) => plugin.id === sub)) {
      await renderPluginInfo(host, sub);
      return;
    }
    host.showError(t('plugins.command.unknownAction', { action: sub }));
  } catch (error) {
    host.showError(
      t('plugins.command.failed', { action: sub ?? '', error: formatErrorMessage(error) }),
    );
  }
}

async function showPluginsPicker(
  host: SlashCommandHost,
  options?: ShowPluginsPickerOptions,
): Promise<void> {
  let plugins: readonly PluginSummary[];
  try {
    plugins = await host.requireSession().listPlugins();
  } catch (error) {
    host.showError(t('plugins.command.loadFailed', { error: formatErrorMessage(error) }));
    return;
  }

  const panel = new PluginsPanelComponent({
    installed: plugins,
    installedIds: new Set(plugins.map((plugin) => plugin.id)),
    initialTab: options?.initialTab,
    selectedId: options?.selectedId,
    pluginHint: options?.pluginHint,
    onSelect: (selection) => {
      // Each branch of the handler either mounts the next view or restores the
      // editor itself, so do not pre-restore here — that would flash the editor
      // for in-place actions like toggling a plugin.
      void handlePluginsPanelSelection(host, panel, selection, panelSlot).catch((error: unknown) => {
        host.showError(t('plugins.command.actionFailed', { error: formatErrorMessage(error) }));
      });
    },
    onCancel: () => {
      host.restoreEditor(panelSlot.current);
    },
    // Every tab except Custom needs the catalog: Official/Third-party list it,
    // and Installed uses it to show update badges. The Installed/Custom tabs
    // keep working even when the marketplace is unreachable (badges simply stay
    // hidden until data arrives).
    onRequestMarketplace: () => {
      void loadMarketplaceCatalog(host, panel, options);
    },
  });
  // Boxed handle: installFromPanel re-mounts this same panel after a failed
  // third-party install and writes the fresh handle back, so the callbacks
  // above always restore (or preempt-close) the live slot owner.
  const panelSlot = {
    current: host.mountEditorReplacement(panel, {
      onPreempt: () => {
        host.restoreEditor(panelSlot.current);
      },
    }),
  };
  // Kick off the catalog fetch for any tab that needs it: Installed uses it for
  // update badges, Official/Third-party list it. Custom never reads the catalog,
  // so skip the fetch there. Done here (after `panel` is initialized) rather
  // than inside the component constructor, because the callback above closes
  // over `panel`.
  if (options?.initialTab !== 'custom') {
    panel.setMarketplaceLoading();
    void loadMarketplaceCatalog(host, panel, options);
  }
}

async function loadMarketplaceCatalog(
  host: SlashCommandHost,
  panel: PluginsPanelComponent,
  options?: ShowPluginsPickerOptions,
): Promise<void> {
  const workDir = host.state.appState.workDir;
  try {
    if (options?.marketplace !== undefined) {
      const registration = options.marketplace;
      const catalog = await loadCatalogForRegistration(registration, { workDir });
      // Entries of a custom marketplace carry its name as an origin badge;
      // the official catalog stays badge-free.
      const entries =
        registration.builtin === true
          ? catalog.plugins
          : catalog.plugins.map((entry) => ({ ...entry, marketplace: registration.name }));
      panel.setMarketplace(entries, catalog.source);
    } else if (options?.marketplaceSource !== undefined) {
      const parsed = parseMarketplaceSourceInput(options.marketplaceSource, workDir);
      if (parsed.kind === 'git' || parsed.kind === 'github') {
        // Clones are keyed by registration name, so git sources can only be
        // browsed after `marketplace add` registers them.
        throw new Error(t('plugins.command.marketplaceGitNeedsRegistration'));
      }
      const catalog = await loadMarketplaceCatalogForSource(parsed, { workDir });
      panel.setMarketplace(catalog.plugins, catalog.source);
    } else {
      const merged = await loadMergedMarketplaceCatalog(host);
      panel.setMarketplace(merged.entries, merged.sourceLabel);
    }
  } catch (error) {
    panel.setMarketplaceError(formatErrorMessage(error));
  }
  host.state.ui.requestRender();
}

/**
 * The default panel view: the official catalog merged with every registered
 * custom marketplace. Official entries win id conflicts; custom entries carry
 * their marketplace name as the `@<name>` origin badge on the Third-party
 * tab. A failing custom marketplace is skipped with a warning instead of
 * breaking the whole view — the official catalog failing keeps the old
 * error-state behavior.
 */
async function loadMergedMarketplaceCatalog(
  host: SlashCommandHost,
): Promise<{ entries: readonly PluginMarketplaceEntry[]; sourceLabel: string }> {
  const workDir = host.state.appState.workDir;
  const official = await loadPluginMarketplace({ workDir });
  const customs = (await listMarketplaces()).filter(
    (registration) => registration.builtin !== true,
  );
  const entries = new Map<string, PluginMarketplaceEntry>(
    official.plugins.map((entry) => [entry.id, entry]),
  );
  const failed: string[] = [];
  await Promise.all(
    customs.map(async (registration) => {
      try {
        const catalog = await loadCatalogForRegistration(registration, { workDir });
        for (const entry of catalog.plugins) {
          if (!entries.has(entry.id)) {
            entries.set(entry.id, { ...entry, marketplace: registration.name });
          }
        }
      } catch {
        failed.push(registration.name);
      }
    }),
  );
  if (failed.length > 0) {
    host.showStatus(
      t('plugins.command.marketplacesSkipped', { names: failed.join(', ') }),
      'warning',
    );
  }
  const sourceLabel =
    customs.length === 0
      ? official.source
      : t('plugins.marketplace.mergedSource', { source: official.source, count: customs.length });
  return { entries: [...entries.values()], sourceLabel };
}

async function showPluginMcpPicker(
  host: SlashCommandHost,
  id: string,
  options?: ShowPluginMcpPickerOptions,
): Promise<void> {
  let info: PluginInfo;
  try {
    info = await host.requireSession().getPluginInfo(id);
  } catch (error) {
    host.showError(t('plugins.command.loadMcpFailed', { error: formatErrorMessage(error) }));
    return;
  }

  const editorSlotHandle = host.mountEditorReplacement(
    new PluginMcpSelectorComponent({
      info,
      selectedServer: options?.selectedServer,
      serverHint: options?.serverHint,
      onSelect: (selection) => {
        // Every MCP action re-mounts a picker, so let the handler do the
        // mounting — pre-restoring the editor here would flash on toggle.
        void handlePluginMcpSelection(host, selection).catch((error: unknown) => {
          host.showError(t('plugins.command.mcpFailed', { error: formatErrorMessage(error) }));
        });
      },
      onCancel: () => {
        host.restoreEditor(editorSlotHandle);
        void showPluginsPicker(host, { selectedId: id });
      },
    }),
    {
      // Only the cleanup half of onCancel: re-opening the plugins picker on
      // preempt would clobber the very panel that preempted us.
      onPreempt: () => {
        host.restoreEditor(editorSlotHandle);
      },
    },
  );
}

async function confirmRemovePlugin(host: SlashCommandHost, id: string): Promise<boolean> {
  let displayName = id;
  try {
    displayName = (await host.requireSession().getPluginInfo(id)).displayName;
  } catch {
    // Keep the confirmation available even when plugin details cannot be loaded.
  }

  return new Promise((resolveConfirmed) => {
    const editorSlotHandle = host.mountEditorReplacement(
      new PluginRemoveConfirmComponent({
        id,
        displayName,
        onDone: (result: PluginRemoveConfirmResult) => {
          host.restoreEditor(editorSlotHandle);
          resolveConfirmed(result.kind === 'confirm');
        },
      }),
      {
        // Preempt = the user never confirmed, so resolve as cancelled.
        onPreempt: () => {
          host.restoreEditor(editorSlotHandle);
          resolveConfirmed(false);
        },
      },
    );
  });
}

async function installFromPanel(
  host: SlashCommandHost,
  panel: PluginsPanelComponent,
  source: string,
  label: string,
  official: boolean,
  panelSlot: { current: EditorSlotHandle },
): Promise<void> {
  if (!(await confirmInstallTrust(host, label, official))) {
    host.showStatus(t('plugins.command.installCancelledLabel', { label }));
    host.restoreEditor(panelSlot.current);
    return;
  }
  // Official installs keep the panel mounted and show the inline installing
  // state; third-party installs pass through a trust prompt that replaces the
  // panel, so fall back to a transcript status for those.
  if (official) {
    panel.setInstalling(truncateForStatus(label));
  } else {
    host.showStatus(t('plugins.command.installingOrUpdating', { label }));
  }
  host.state.ui.requestRender();
  try {
    await installPluginFromSource(host, source);
  } catch (error) {
    if (official) {
      panel.clearInstalling();
      host.state.ui.requestRender();
    } else {
      // The trust prompt replaced the panel; re-mount it so the user can retry
      // instead of being dropped back at the editor.
      panelSlot.current = host.mountEditorReplacement(panel, {
        onPreempt: () => {
          host.restoreEditor(panelSlot.current);
        },
      });
    }
    host.showError(
      t('plugins.command.installFailed', { label, error: formatErrorMessage(error) }),
    );
    return;
  }
  // Close the panel after installing so the result status and the
  // "/reload or /new" tip are visible in the transcript.
  host.restoreEditor(panelSlot.current);
}

type PluginEnableScopeFlag = 'user' | 'project';

/**
 * Parse the optional `--user` / `--project` flag of `/plugins enable|disable`.
 * No flag means user scope (the install-level flag — pre-scope behavior).
 */
function parseEnableScopeFlag(args: readonly string[]): PluginEnableScopeFlag | 'invalid' {
  const flags = args.filter((arg) => arg.startsWith('--'));
  if (flags.length !== args.length || flags.length > 1) return 'invalid';
  if (flags.length === 0) return 'user';
  if (flags[0] === '--user') return 'user';
  if (flags[0] === '--project') return 'project';
  return 'invalid';
}

async function applyPluginEnabled(
  host: SlashCommandHost,
  id: string,
  enabled: boolean,
  showStatus = true,
  scope: PluginEnableScopeFlag = 'user',
): Promise<string> {
  const session = host.requireSession();
  if (scope === 'project') {
    await session.setPluginEnabled(id, enabled, {
      scope,
      workDir: host.state.appState.workDir,
    });
  } else {
    await session.setPluginEnabled(id, enabled);
  }
  let info: PluginInfo | undefined;
  try {
    info = await session.getPluginInfo(id);
  } catch {
    info = undefined;
  }
  const mcpHint =
    enabled && info !== undefined && info.mcpServerCount > info.enabledMcpServerCount
      ? t('plugins.command.mcpDisabledHint', { id })
      : '';
  if (showStatus) {
    const base = t(enabled ? 'plugins.command.enabled' : 'plugins.command.disabled', {
      id,
      mcpHint,
    });
    host.showStatus(
      scope === 'project'
        ? t(enabled ? 'plugins.command.enabledProject' : 'plugins.command.disabledProject', {
            id,
            mcpHint,
          })
        : base,
    );
  }
  const inlineMcpHint = mcpHint.length > 0 ? t('plugins.command.inlineMcpDisabled') : '';
  return `${pluginInlineChangeHint()}${inlineMcpHint}`;
}

async function handlePluginsPanelSelection(
  host: SlashCommandHost,
  panel: PluginsPanelComponent,
  selection: PluginsPanelSelection,
  panelSlot: { current: EditorSlotHandle },
): Promise<void> {
  switch (selection.kind) {
    case 'toggle': {
      const hint = await applyPluginEnabled(host, selection.id, selection.enabled, false);
      await showPluginsPicker(host, {
        initialTab: 'installed',
        selectedId: selection.id,
        pluginHint: { id: selection.id, text: hint },
      });
      return;
    }
    case 'remove':
      if (!(await confirmRemovePlugin(host, selection.id))) {
        host.showStatus(t('plugins.command.removeCancelled', { id: selection.id }));
        await showPluginsPicker(host, { initialTab: 'installed', selectedId: selection.id });
        return;
      }
      await removePlugin(host, selection.id);
      await showPluginsPicker(host, { initialTab: 'installed' });
      return;
    case 'mcp':
      await showPluginMcpPicker(host, selection.id);
      return;
    case 'details':
      host.restoreEditor(panelSlot.current);
      await renderPluginInfo(host, selection.id);
      return;
    case 'reload':
      await reloadPlugins(host);
      await showPluginsPicker(host, { initialTab: 'installed' });
      return;
    case 'install':
      await installFromPanel(
        host,
        panel,
        selection.entry.source,
        selection.entry.displayName,
        isOfficialPluginSource(selection.entry.source),
        panelSlot,
      );
      return;
    case 'install-source':
      await installFromPanel(
        host,
        panel,
        selection.source,
        selection.source,
        isOfficialPluginSource(selection.source),
        panelSlot,
      );
      return;
    case 'open-url':
      host.restoreEditor(panelSlot.current);
      openUrl(selection.url);
      host.showStatus(t('plugins.command.openingUrl', { label: selection.label }), 'success');
      host.showStatus(t('plugins.command.openUrlFallback', { url: selection.url }));
      return;
  }
}

async function handlePluginMcpSelection(
  host: SlashCommandHost,
  selection: PluginMcpSelection,
): Promise<void> {
  switch (selection.kind) {
    case 'toggle':
      await host.requireSession().setPluginMcpServerEnabled(
        selection.pluginId,
        selection.server,
        selection.enabled,
      );
      await showPluginMcpPicker(host, selection.pluginId, {
        selectedServer: selection.server,
        serverHint: {
          server: selection.server,
          text: pluginInlineChangeHint(),
        },
      });
      return;
    case 'back':
      await showPluginsPicker(host, { selectedId: selection.pluginId });
      return;
  }
}

async function removePlugin(host: SlashCommandHost, id: string): Promise<void> {
  await host.requireSession().removePlugin(id);
  // One logical notice, one call (single-slot notice area; see above).
  host.showStatus(
    `${t('plugins.command.removed', { id })}\n${resolveDescription(PLUGIN_RELOAD_HINT)}`,
    'warning',
  );
}

async function renderPluginsList(
  host: SlashCommandHost,
  plugins?: readonly PluginSummary[],
): Promise<void> {
  const currentPlugins = plugins ?? (await host.requireSession().listPlugins());
  const title = t('plugins.command.listTitle', { count: currentPlugins.length });
  const panel = new UsagePanelComponent(
    () => buildPluginsListLines({ plugins: currentPlugins }),
    'primary',
    title,
  );
  host.state.transcriptContainer.addChild(panel);
  host.state.ui.requestRender();
}

async function renderPluginInfo(host: SlashCommandHost, id: string): Promise<void> {
  const info = await host.requireSession().getPluginInfo(id);
  const panel = new UsagePanelComponent(
    () => buildPluginsInfoLines({ info }),
    'primary',
    ` ${info.id} `,
  );
  host.state.transcriptContainer.addChild(panel);
  host.state.ui.requestRender();
}

async function reloadPlugins(host: SlashCommandHost): Promise<void> {
  const summary = await host.requireSession().reloadPlugins();
  const line =
    t('plugins.command.reloadSummary', {
      added: summary.added.length,
      removed: summary.removed.length,
    }) +
    (summary.errors.length > 0
      ? t('plugins.command.reloadErrors', { count: summary.errors.length })
      : '');
  host.showStatus(line);
}

function pluginInlineChangeHint(): string {
  return t('plugins.command.inlineReloadHint');
}
