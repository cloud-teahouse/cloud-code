import type { PluginInfo, PluginSummary } from '@cloud-code/sdk';

import { t } from '#/tui/i18n';
import { currentTheme } from '#/tui/theme';
import {
  type PluginTrustLabel,
  formatPluginSourceLabel,
  localizedTrustLabel,
  pluginTrustLabel,
} from '../../utils/plugin-source-label';

export interface PluginsListPanelInput {
  readonly plugins: readonly PluginSummary[];
}

export function buildPluginsListLines(input: PluginsListPanelInput): readonly string[] {
  const muted = (text: string) => currentTheme.fg('textDim', text);
  const value = (text: string) => currentTheme.fg('text', text);
  const success = (text: string) => currentTheme.fg('success', text);
  const primary = (text: string) => currentTheme.fg('primary', text);
  const warning = (text: string) => currentTheme.fg('warning', text);
  if (input.plugins.length === 0) {
    return [
      muted(t('panels.plugins.empty')),
      '',
      value(t('panels.plugins.emptyHint')),
    ];
  }
  const renderTrustBadge = (label: PluginTrustLabel): string => {
    if (label === 'official') return success(`[${localizedTrustLabel(label)}]`);
    if (label === 'curated') return primary(`[${localizedTrustLabel(label)}]`);
    return muted(`[${localizedTrustLabel(label)}]`);
  };
  const lines: string[] = [];
  for (const plugin of input.plugins) {
    const enabled = plugin.enabled ? success(t('panels.plugins.enabled')) : muted(t('panels.plugins.disabled'));
    const state = plugin.state === 'ok' ? '' : ` [${plugin.state}]`;
    const version = plugin.version ?? '-';
    const diagnostics = plugin.hasErrors ? warning(t('panels.plugins.diagnosticsHint')) : '';
    const sourceTag = muted(`[${formatPluginSourceLabel(plugin)}]`);
    const trustBadge = ` ${renderTrustBadge(pluginTrustLabel(plugin))}`;
    lines.push(
      `${value(plugin.displayName)} (${muted(plugin.id)}) ${muted(version)} ${sourceTag}${trustBadge} | ${enabled}${state}`,
    );
    const mcp =
      plugin.mcpServerCount > 0
        ? ` | ${plugin.enabledMcpServerCount}/${plugin.mcpServerCount} mcp`
        : '';
    lines.push(`  ${muted(t('panels.plugins.skillsLabel'))} ${value(String(plugin.skillCount))}${muted(mcp)}${diagnostics}`);
  }
  return lines;
}

export interface PluginsInfoPanelInput {
  readonly info: PluginInfo;
}

export function buildPluginsInfoLines(input: PluginsInfoPanelInput): readonly string[] {
  const { info } = input;
  const muted = (text: string) => currentTheme.fg('textDim', text);
  const value = (text: string) => currentTheme.fg('text', text);
  const success = (text: string) => currentTheme.fg('success', text);
  const warning = (text: string) => currentTheme.fg('warning', text);
  const error = (text: string) => currentTheme.fg('error', text);
  const primary = (text: string) => currentTheme.fg('primary', text);
  const status = info.enabled ? success(t('panels.plugins.enabled')) : muted(t('panels.plugins.disabled'));
  const trustLine = (() => {
    const label = pluginTrustLabel(info);
    const badge = localizedTrustLabel(label);
    if (label === 'official') {
      return `${muted(t('panels.plugins.trustLabel'))}  ${success(badge)} ${muted(t('panels.plugins.trustOfficial'))}`;
    }
    if (label === 'curated') {
      return `${muted(t('panels.plugins.trustLabel'))}  ${primary(badge)} ${muted(t('panels.plugins.trustCurated'))}`;
    }
    return `${muted(t('panels.plugins.trustLabel'))}  ${muted(badge)}`;
  })();
  const lines: string[] = [
    `${value(info.displayName)} (${muted(info.id)}) ${muted(info.version ?? '')}`.trim(),
    `${muted(t('panels.plugins.statusLabel'))} ${status} | ${muted(t('panels.plugins.stateLabel'))} ${stateText(info.state)}`,
    trustLine,
    `${muted(t('panels.plugins.sourceLabel'))} ${value(info.source)}`,
    `${muted(t('panels.plugins.rootLabel'))}   ${value(info.root)}`,
  ];
  if (info.source === 'github' && info.github !== undefined) {
    const refLabel = `${info.github.ref.kind}:${info.github.ref.value}`;
    lines.push(`${muted(t('panels.plugins.githubLabel'))} ${value(`${info.github.owner}/${info.github.repo}`)} ${muted(`@${refLabel}`)}`);
    if (info.github.installedSha !== undefined) {
      lines.push(`${muted(t('panels.plugins.installedSha'))} ${value(info.github.installedSha)}`);
    }
  }
  if (info.originalSource !== undefined) lines.push(`${muted(t('panels.plugins.originalSource'))} ${value(info.originalSource)}`);
  lines.push(`${muted(t('panels.plugins.installedAt'))} ${value(info.installedAt)}`);
  if (info.updatedAt !== undefined && info.updatedAt !== info.installedAt) {
    lines.push(`${muted(t('panels.plugins.lastUpdated'))} ${value(info.updatedAt)}`);
  }
  if (info.manifestPath !== undefined) {
    const kindSuffix = info.manifestKind !== undefined ? ` ${muted(`(${info.manifestKind})`)}` : '';
    lines.push(`${muted(t('panels.plugins.manifestLabel'))} ${value(info.manifestPath)}${kindSuffix}`);
  }
  if (info.shadowedManifestPath !== undefined) {
    lines.push(`${muted(t('panels.plugins.shadowedLabel'))} ${value(info.shadowedManifestPath)}`);
  }
  const sessionStartSkill = info.manifest?.sessionStart?.skill;
  if (sessionStartSkill !== undefined) {
    lines.push(`${muted(t('panels.plugins.sessionStart'))} ${value(sessionStartSkill)}`);
  }
  if (info.manifest?.skillInstructions !== undefined) {
    lines.push(`${muted(t('panels.plugins.skillInstructions'))} ${value(t('panels.plugins.present'))}`);
  }
  lines.push('');
  lines.push(value(t('panels.plugins.skillsHeader', { count: info.manifest?.skills?.length ?? 0 })));
  for (const dir of info.manifest?.skills ?? []) lines.push(`  ${muted('-')} ${value(dir)}`);

  if (info.mcpServers.length > 0) {
    lines.push('');
    lines.push(value(t('panels.plugins.mcpServersHeader', { enabled: info.enabledMcpServerCount, total: info.mcpServerCount })));
    lines.push(muted(`  ${t('panels.plugins.mcpDisableHint', { id: info.id })}`));
    for (const server of info.mcpServers) {
      const enabled = server.enabled ? success(t('panels.plugins.enabled')) : muted(t('panels.plugins.disabled'));
      lines.push(`  ${muted('-')} ${value(server.name)} ${enabled} ${muted(`(${server.runtimeName})`)}`);
      if (server.transport === 'stdio') {
        const args = server.args !== undefined && server.args.length > 0 ? ` ${server.args.join(' ')}` : '';
        lines.push(`    ${muted(t('panels.plugins.commandLabel'))} ${value(`${server.command ?? ''}${args}`.trim())}`);
        if (server.cwd !== undefined) lines.push(`    ${muted(t('panels.plugins.cwdLabel'))} ${value(server.cwd)}`);
        if (server.envKeys !== undefined && server.envKeys.length > 0) {
          lines.push(`    ${muted(t('panels.plugins.envLabel'))} ${value(server.envKeys.join(', '))}`);
        }
      } else {
        lines.push(`    ${muted(t('panels.plugins.urlLabel'))} ${value(server.url ?? '')}`);
        if (server.headerKeys !== undefined && server.headerKeys.length > 0) {
          lines.push(`    ${muted(t('panels.plugins.headersLabel'))} ${value(server.headerKeys.join(', '))}`);
        }
      }
    }
  }

  const iface = info.manifest?.interface;
  if (iface !== undefined) {
    lines.push('');
    lines.push(value(t('panels.plugins.displayHeader')));
    if (iface.shortDescription !== undefined) lines.push(`  ${muted('-')} ${value(iface.shortDescription)}`);
    if (iface.developerName !== undefined) lines.push(`  ${muted('-')} ${value(t('panels.plugins.byDeveloper', { name: iface.developerName }))}`);
    if (iface.websiteURL !== undefined) lines.push(`  ${muted('-')} ${value(iface.websiteURL)}`);
  }

  if (info.manifest?.keywords !== undefined && info.manifest.keywords.length > 0) {
    lines.push('');
    lines.push(muted(t('panels.plugins.keywords', { keywords: info.manifest.keywords.join(', ') })));
  }

  if (info.diagnostics.length > 0) {
    lines.push('');
    lines.push(value(t('panels.plugins.diagnosticsHeader')));
    for (const d of info.diagnostics) {
      const paint = d.severity === 'error' ? error : d.severity === 'warn' ? warning : muted;
      lines.push(`  ${paint(`[${d.severity}]`)} ${value(d.message)}`);
    }
  }
  return lines;
}

function stateText(state: PluginInfo['state']): string {
  if (state === 'ok') return currentTheme.fg('success', state);
  return currentTheme.fg('error', state);
}
