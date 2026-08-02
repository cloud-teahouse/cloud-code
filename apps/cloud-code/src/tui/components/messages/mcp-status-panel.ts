import type { McpServerInfo } from '@cloud-code/sdk';
import { visibleWidth } from '@cloud-code/pi-tui';

import { padEndVisible, resolveDescription, t } from '#/tui/i18n';
import { currentTheme } from '#/tui/theme';

export interface McpStatusReportOptions {
  readonly servers: readonly McpServerInfo[];
}

const STATUS_PRIORITY: Record<McpServerInfo['status'], number> = {
  failed: 0,
  'needs-auth': 1,
  pending: 2,
  connected: 3,
  disabled: 4,
};

/** Status → i18n key; resolved at render time so locale switches repaint. */
const STATUS_LABEL: Record<McpServerInfo['status'], string> = {
  connected: 'panels.mcp.status.connected',
  pending: 'panels.mcp.status.pending',
  'needs-auth': 'panels.mcp.status.needsAuth',
  failed: 'panels.mcp.status.failed',
  disabled: 'panels.mcp.status.disabled',
};

function statusLabel(status: McpServerInfo['status']): string {
  return resolveDescription(STATUS_LABEL[status]);
}

const SUMMARY_ORDER: readonly McpServerInfo['status'][] = [
  'connected',
  'pending',
  'needs-auth',
  'failed',
  'disabled',
];

function statusPainter(
  status: McpServerInfo['status'],
): (text: string) => string {
  switch (status) {
    case 'connected':
      return (text) => currentTheme.fg('success', text);
    case 'failed':
      return (text) => currentTheme.fg('error', text);
    case 'needs-auth':
    case 'pending':
      return (text) => currentTheme.fg('warning', text);
    case 'disabled':
      return (text) => currentTheme.fg('textDim', text);
  }
}

function formatToolCount(server: McpServerInfo): string {
  if (server.status === 'disabled') return '—';
  return t(server.toolCount === 1 ? 'panels.mcp.tools.one' : 'panels.mcp.tools.other', {
    count: server.toolCount,
  });
}

function formatToolsAvailable(count: number): string {
  return t(count === 1 ? 'panels.mcp.toolsAvailable.one' : 'panels.mcp.toolsAvailable.other', {
    count,
  });
}

/**
 * Collapse a (possibly multi-line) MCP error into a single line. The status
 * panel renders each returned string as exactly one boxed row (see
 * `UsagePanelComponent.render`), so an embedded newline — e.g. the
 * `\nstderr: ...` a failed stdio server appends — would drop the trailing
 * text to column 0 and punch through the rounded border. Folding every run
 * of whitespace to a single space keeps the error on one row, which the
 * panel then truncates to the available width.
 */
function formatErrorLine(error: string): string {
  return error.trim().replaceAll(/\s+/g, ' ');
}

function sortedServers(servers: readonly McpServerInfo[]): McpServerInfo[] {
  return servers.toSorted(
    (a, b) =>
      STATUS_PRIORITY[a.status] - STATUS_PRIORITY[b.status] || a.name.localeCompare(b.name),
  );
}

function buildSummary(servers: readonly McpServerInfo[]): string {
  const counts: Partial<Record<McpServerInfo['status'], number>> = {};
  let toolsAvailable = 0;
  for (const server of servers) {
    counts[server.status] = (counts[server.status] ?? 0) + 1;
    if (server.status === 'connected') toolsAvailable += server.toolCount;
  }
  const parts: string[] = [];
  for (const status of SUMMARY_ORDER) {
    const n = counts[status];
    if (n === undefined || n === 0) continue;
    parts.push(`${n} ${statusLabel(status)}`);
  }
  parts.push(formatToolsAvailable(toolsAvailable));
  return parts.join(' · ');
}

export function buildMcpStatusReportLines(options: McpStatusReportOptions): string[] {
  const servers = sortedServers(options.servers);
  const accent = (text: string) => currentTheme.boldFg('primary', text);
  const muted = (text: string) => currentTheme.fg('textDim', text);
  const value = (text: string) => currentTheme.fg('text', text);
  const error = (text: string) => currentTheme.fg('error', text);

  const lines: string[] = [accent(t('panels.mcp.servers'))];

  if (servers.length === 0) {
    lines.push(muted(`  ${t('panels.mcp.empty')}`));
    return lines;
  }

  const nameWidth = Math.max(
    visibleWidth(t('panels.mcp.col.name')),
    ...servers.map((server) => visibleWidth(server.name)),
  );
  const statusWidth = Math.max(
    visibleWidth(t('panels.mcp.col.status')),
    ...servers.map((server) => visibleWidth(statusLabel(server.status))),
  );
  const transportWidth = Math.max(
    visibleWidth(t('panels.mcp.col.transport')),
    ...servers.map((server) => visibleWidth(server.transport)),
  );

  lines.push(
    `  ${muted(padEndVisible(t('panels.mcp.col.name'), nameWidth))}  ${muted(padEndVisible(t('panels.mcp.col.status'), statusWidth))}  ${muted(
      padEndVisible(t('panels.mcp.col.transport'), transportWidth),
    )}  ${muted(t('panels.mcp.col.tools'))}`,
  );

  for (const server of servers) {
    const status = statusPainter(
      server.status,
    )(padEndVisible(statusLabel(server.status), statusWidth));
    lines.push(
      `  ${value(padEndVisible(server.name, nameWidth))}  ${status}  ${muted(
        padEndVisible(server.transport, transportWidth),
      )}  ${value(formatToolCount(server))}`,
    );

    if (
      server.status === 'failed' &&
      server.error !== undefined &&
      server.error.trim().length > 0
    ) {
      lines.push(`    ${muted(t('panels.mcp.errorLabel'))} ${error(formatErrorLine(server.error))}`);
    }
    if (server.status === 'needs-auth') {
      lines.push(
        `    ${muted(t('panels.mcp.actionLabel'))} ${value(t('panels.mcp.loginAction', { name: server.name }))}`,
      );
    }
  }

  lines.push('');
  lines.push(`  ${value(buildSummary(servers))}`);
  lines.push(`  ${muted(t('panels.mcp.configureWith'))} ${value('/mcp-config')}`);

  return lines;
}
