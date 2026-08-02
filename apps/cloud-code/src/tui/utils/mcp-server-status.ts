import type { McpServerInfo, McpServerStatusEvent } from '@cloud-code/sdk';

import { t } from '#/tui/i18n';

export type McpServerStatusSnapshot = McpServerInfo | McpServerStatusEvent['server'];

export const MCP_STARTUP_STATUS_ROW_LIMIT = 4;

function mcpStartupStatusPriority(status: McpServerStatusSnapshot['status']): number {
  switch (status) {
    case 'failed':
      return 0;
    case 'needs-auth':
      return 1;
    case 'pending':
      return 2;
    case 'connected':
      return 3;
    case 'disabled':
      return 4;
  }
}

export function selectMcpStartupStatusRows(
  servers: readonly McpServerStatusSnapshot[],
): McpServerStatusSnapshot[] {
  return [...servers]
    .filter((server) => server.status !== 'disabled')
    .toSorted((a, b) => mcpStartupStatusPriority(a.status) - mcpStartupStatusPriority(b.status))
    .slice(0, MCP_STARTUP_STATUS_ROW_LIMIT);
}

export function formatMcpStartupStatusSummary(
  servers: readonly McpServerStatusSnapshot[],
): string {
  let failed = 0;
  let needsAuth = 0;
  let connecting = 0;
  let connected = 0;
  let disabled = 0;
  for (const server of servers) {
    switch (server.status) {
      case 'failed':
        failed++;
        break;
      case 'needs-auth':
        needsAuth++;
        break;
      case 'pending':
        connecting++;
        break;
      case 'connected':
        connected++;
        break;
      case 'disabled':
        disabled++;
        break;
    }
  }

  const parts: string[] = [];
  if (failed > 0) parts.push(t('utils.mcp.summary.failed', { count: failed }));
  if (needsAuth > 0) parts.push(t('utils.mcp.summary.needsAuth', { count: needsAuth }));
  if (connecting > 0) parts.push(t('utils.mcp.summary.connecting', { count: connecting }));
  if (connected > 0) parts.push(t('utils.mcp.summary.connected', { count: connected }));
  if (disabled > 0) parts.push(t('utils.mcp.summary.disabled', { count: disabled }));
  return parts.join(', ');
}

export function mcpServerStatusKey(server: McpServerStatusSnapshot): string {
  return JSON.stringify([server.status, server.transport, server.toolCount, server.error]);
}
