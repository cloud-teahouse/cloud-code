import { homedir as osHomedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

import type { PluginSummary } from '@cloud-code/sdk';

import { PluginInstallTrustConfirmComponent } from '../components/dialogs/plugins-selector';
import { resolveDescription, t } from '../i18n';
import { QUOTA_CONSUMING_PLUGIN_IDS } from '#/constant/app';
import { formatErrorMessage } from '../utils/event-payload';
import { formatPluginSourceLabel, isOfficialPluginInstall } from '../utils/plugin-source-label';
import type { PluginMarketplaceEntry } from '#/utils/plugin-marketplace';
import type { SlashCommandHost } from './dispatch';

/**
 * Shared install plumbing for the /plugins flows: the third-party trust
 * confirmation and the source install + result notice used by the direct
 * `/plugins install` command, the panel install action, and installs from a
 * registered marketplace. Kept separate from the command dispatch and the
 * marketplace flows so neither has to import the other.
 */

export const PLUGIN_RELOAD_HINT = 'plugins.command.reloadHint';

export async function confirmInstallTrust(
  host: SlashCommandHost,
  label: string,
  official: boolean,
): Promise<boolean> {
  // Kimi-built official plugins are trusted implicitly; anything else requires
  // the user to explicitly opt in via the trust prompt.
  if (official) return true;
  return new Promise((resolveConfirmed) => {
    const editorSlotHandle = host.mountEditorReplacement(
      new PluginInstallTrustConfirmComponent({
        label,
        onDone: (result) => {
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

export async function installPluginFromSource(
  host: SlashCommandHost,
  source: string,
): Promise<void> {
  const session = host.requireSession();
  const beforeList = await session.listPlugins();
  const summary = await session.installPlugin(
    resolvePluginInstallSource(source, host.state.appState.workDir),
  );
  showPluginInstallResult(host, beforeList, summary);
}

/**
 * Install a marketplace catalog entry with the same trust + spinner flow as
 * `/plugins install <source>`. Used by `name@marketplace` installs and the
 * bare-name marketplace lookup.
 */
export async function installMarketplaceEntry(
  host: SlashCommandHost,
  entry: PluginMarketplaceEntry,
  official: boolean,
): Promise<void> {
  if (!(await confirmInstallTrust(host, entry.displayName, official))) {
    host.showStatus(t('plugins.command.installCancelledLabel', { label: entry.displayName }));
    return;
  }
  const spinner = host.showProgressSpinner(
    t('plugins.command.installingFrom', { source: truncateForStatus(entry.source) }),
  );
  try {
    await installPluginFromSource(host, entry.source);
    spinner.stop({ ok: true, label: t('plugins.command.installFinished') });
  } catch (error) {
    spinner.stop({
      ok: false,
      label: t('plugins.command.installFailedSpinner', { error: formatErrorMessage(error) }),
    });
    throw error;
  }
}

export function truncateForStatus(input: string): string {
  const max = 80;
  return input.length > max ? `${input.slice(0, max - 1)}…` : input;
}

/**
 * Map a user-typed install source onto the shape the plugin manager accepts:
 * URLs pass through; `~` and relative paths resolve against home/workDir.
 */
export function resolvePluginInstallSource(source: string, workDir: string): string {
  const trimmed = source.trim();
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) return trimmed;
  if (trimmed === '~') return osHomedir();
  if (trimmed.startsWith('~/')) return join(osHomedir(), trimmed.slice(2));
  return isAbsolute(trimmed) ? trimmed : resolve(workDir, trimmed);
}

function showPluginInstallResult(
  host: SlashCommandHost,
  beforeList: readonly PluginSummary[],
  summary: PluginSummary,
): void {
  const previous = beforeList.find((entry) => entry.id === summary.id);
  const mcpHint =
    summary.mcpServerCount > 0
      ? t(
          summary.mcpServerCount === 1
            ? 'plugins.command.declaresMcp.one'
            : 'plugins.command.declaresMcp.other',
          { count: summary.mcpServerCount },
        )
      : '';
  const action = describeInstallAction(previous, summary);
  // One logical notice, one call: the transient notice slot is single-entry,
  // so a multi-line result must arrive as a single message.
  // Quota note rides the same message: gate on provenance, not just the id —
  // a local/GitHub fork whose manifest reuses a billed plugin's id is not the
  // official quota-consuming build.
  const quotaNote =
    QUOTA_CONSUMING_PLUGIN_IDS.includes(summary.id) && isOfficialPluginInstall(summary)
      ? `\n${t('plugins.command.quotaNote')}`
      : '';
  host.showStatus(
    `${action} (${summary.id}).${mcpHint}\n${resolveDescription(PLUGIN_RELOAD_HINT)}${quotaNote}`,
    'warning',
  );
}

function describeInstallAction(
  previous: PluginSummary | undefined,
  next: PluginSummary,
): string {
  const sourceLabel = formatPluginSourceLabel(next);
  const versionFromTo = (prev?: string, cur?: string): string => {
    if (prev === undefined || prev === cur) return cur === undefined ? '' : ` ${cur}`;
    return ` ${prev} → ${cur ?? '-'}`;
  };
  if (previous === undefined) {
    return t('plugins.command.installed', {
      name: next.displayName,
      version: versionFromTo(undefined, next.version),
      source: sourcePhrase(sourceLabel),
    });
  }
  if (sourceIdentity(previous) !== sourceIdentity(next)) {
    const prevSourceLabel = formatPluginSourceLabel(previous);
    return t('plugins.command.migrated', {
      name: next.displayName,
      previousSource: prevSourceLabel,
      source: sourceLabel,
      version: versionFromTo(previous.version, next.version),
    });
  }
  return t('plugins.command.updated', {
    name: next.displayName,
    version: versionFromTo(previous.version, next.version),
    source: sourcePhrase(sourceLabel),
  });
}

// formatPluginSourceLabel already prefixes zip-url hosts with "via", so adding
// "from" would read as "from via <host>". Only prepend "from" otherwise.
function sourcePhrase(sourceLabel: string): string {
  return sourceLabel.startsWith('via ')
    ? sourceLabel
    : t('plugins.command.sourceFrom', { label: sourceLabel });
}

function sourceIdentity(plugin: PluginSummary): string {
  if (plugin.source === 'github' && plugin.github !== undefined) {
    return `github:${plugin.github.owner}/${plugin.github.repo}`;
  }
  return plugin.source;
}
