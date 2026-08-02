/**
 * Status tab line builder for the `/status` dialog.
 *
 * Global session/runtime facts only (the account-specific blocks live on the
 * per-account tabs): version header, title/session/directory/model rows,
 * permission mode, an MCP server summary, and the context-window bar moved
 * over from the old Usage tab.
 */

import type { McpServerInfo, ModelAlias, PermissionMode } from '@cloud-code/sdk';

import { PRODUCT_NAME } from '#/constant/app';
import { columnWidth, renderRow } from '#/tui/components/primitives';
import { t } from '#/tui/i18n';
import { currentTheme, type ColorToken } from '#/tui/theme';
import {
  formatTokenCount,
  ratioSeverity,
  renderProgressBar,
  safeUsageRatio,
  usagePercent,
} from '#/utils/usage/usage-format';

import { modelDisplayName, providerDisplayName } from '../dialogs/model-selector';

interface FieldRow {
  readonly label: string;
  readonly value: string;
  readonly tone?: 'error' | 'muted';
}

export interface StatusTabOptions {
  readonly version: string;
  readonly model: string;
  readonly workDir: string;
  readonly sessionId: string;
  readonly sessionTitle: string | null;
  readonly availableModels: Record<string, ModelAlias>;
  /** Current permission mode; the row is omitted when the host does not report one. */
  readonly permissionMode?: PermissionMode | undefined;
  readonly contextUsage: number;
  readonly contextTokens: number;
  readonly maxContextTokens: number;
  /** undefined → the listMcpServers RPC failed (rendered as 'unavailable'). */
  readonly mcpServers?: readonly McpServerInfo[] | undefined;
  /** true while the MCP server list RPC is still in flight. */
  readonly mcpServersLoading?: boolean | undefined;
}

type Colorize = (text: string) => string;

function formatModel(model: string, models: Record<string, ModelAlias>): string {
  if (model.trim().length === 0) return t('panels.status.modelNotSet');
  const alias = models[model];
  const name = modelDisplayName(model, alias);
  const provider = alias?.provider;
  return provider === undefined || provider.length === 0
    ? name
    : `${name} (${providerDisplayName(provider)})`;
}

const MCP_SEGMENT_KEYS = [
  ['connected', 'panels.status.mcp.segment.connected'],
  ['failed', 'panels.status.mcp.segment.failed'],
  ['needs-auth', 'panels.status.mcp.segment.needsAuth'],
  ['pending', 'panels.status.mcp.segment.pending'],
  ['disabled', 'panels.status.mcp.segment.disabled'],
] as const;

function mcpSummary(servers: readonly McpServerInfo[]): string {
  const counts = new Map<McpServerInfo['status'], number>();
  for (const server of servers) {
    counts.set(server.status, (counts.get(server.status) ?? 0) + 1);
  }
  const segments: string[] = [];
  for (const [status, key] of MCP_SEGMENT_KEYS) {
    const count = counts.get(status) ?? 0;
    if (count > 0) segments.push(t(key, { count }));
  }
  return segments.join(' · ');
}

/** Names of servers needing attention, one line per actionable state. */
function mcpAttentionLines(servers: readonly McpServerInfo[], muted: Colorize): string[] {
  const lines: string[] = [];
  const pushNames = (
    status: McpServerInfo['status'],
    key: 'panels.status.mcp.names.failed' | 'panels.status.mcp.names.needsAuth',
  ): void => {
    const names = servers.filter((s) => s.status === status).map((s) => s.name);
    if (names.length > 0) lines.push(`    ${muted(t(key, { names: names.join(', ') }))}`);
  };
  pushNames('failed', 'panels.status.mcp.names.failed');
  pushNames('needs-auth', 'panels.status.mcp.names.needsAuth');
  return lines;
}

function addFieldRows(lines: string[], rows: readonly FieldRow[]): void {
  const labelWidth = columnWidth(
    rows.map((row) => row.label),
    10,
  );
  for (const row of rows) {
    const valueToken: ColorToken =
      row.tone === 'error' ? 'error' : row.tone === 'muted' ? 'textDim' : 'text';
    lines.push(
      renderRow(
        [
          { text: row.label, token: 'textDim', width: labelWidth },
          { text: row.value, token: valueToken },
        ],
        { margin: 2 },
      ),
    );
  }
}

function permissionModeLabel(mode: PermissionMode): string {
  switch (mode) {
    case 'manual':
      return t('selectors.permission.manual.label');
    case 'yolo':
      return t('selectors.permission.yolo.label');
    case 'auto':
      return t('selectors.permission.auto.label');
  }
}

export function buildStatusTabLines(options: StatusTabOptions): string[] {
  const accent = (text: string) => currentTheme.boldFg('primary', text);
  const value = (text: string) => currentTheme.fg('text', text);
  const muted = (text: string) => currentTheme.fg('textDim', text);

  const title = options.sessionTitle?.trim();
  const sessionId =
    options.sessionId.trim().length > 0 ? options.sessionId : t('panels.status.none');

  const rows: FieldRow[] = [
    title !== undefined && title.length > 0
      ? { label: t('panels.status.label.title'), value: title }
      : { label: t('panels.status.label.title'), value: t('panels.status.titlePlaceholder'), tone: 'muted' },
    { label: t('panels.status.label.session'), value: sessionId },
    { label: t('panels.status.label.directory'), value: options.workDir },
    { label: t('panels.status.label.model'), value: formatModel(options.model, options.availableModels) },
  ];

  if (options.permissionMode !== undefined) {
    rows.push({
      label: t('panels.status.label.permissions'),
      value: permissionModeLabel(options.permissionMode),
    });
  }

  if (options.mcpServersLoading === true) {
    rows.push({
      label: t('panels.status.label.mcpServers'),
      value: t('common.loading'),
      tone: 'muted',
    });
  } else if (options.mcpServers === undefined) {
    rows.push({
      label: t('panels.status.label.mcpServers'),
      value: t('panels.status.mcp.unavailable'),
      tone: 'muted',
    });
  } else if (options.mcpServers.length === 0) {
    rows.push({
      label: t('panels.status.label.mcpServers'),
      value: t('panels.status.mcp.none'),
      tone: 'muted',
    });
  } else {
    rows.push({
      label: t('panels.status.label.mcpServers'),
      value: mcpSummary(options.mcpServers),
    });
  }

  const lines: string[] = [
    `${accent(`>_ ${PRODUCT_NAME}`)} ${muted(`(v${options.version})`)}`,
    '',
  ];
  addFieldRows(lines, rows);
  if (options.mcpServers !== undefined && options.mcpServers.length > 0) {
    lines.push(...mcpAttentionLines(options.mcpServers, muted));
  }

  if (options.maxContextTokens > 0) {
    const ratio = safeUsageRatio(options.contextUsage);
    const bar = renderProgressBar(ratio, 20);
    const pct = `${String(usagePercent(options.contextTokens, options.maxContextTokens))}%`;
    const barColored = currentTheme.fg(
      ratioSeverity(ratio) === 'danger' ? 'error' : ratioSeverity(ratio) === 'warn' ? 'warning' : 'success',
      bar,
    );
    lines.push('', accent(t('panels.contextWindow')));
    lines.push(
      `  ${barColored}  ${value(pct.padStart(6, ' '))}  ` +
        muted(
          `(${formatTokenCount(options.contextTokens)} / ${formatTokenCount(
            options.maxContextTokens,
          )})`,
        ),
    );
  }
  return lines;
}
