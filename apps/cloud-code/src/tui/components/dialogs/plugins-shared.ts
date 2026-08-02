/**
 * Shared rendering helpers for the plugins dialogs — the unified panel
 * (plugins-selector.ts) and the MCP selector + confirm pickers
 * (plugins-mcp.ts). Extracted so each dialog file stays under the 800-line
 * soft cap.
 */

import { truncateToWidth, visibleWidth } from '@cloud-code/pi-tui';
import chalk from 'chalk';

import { t } from '#/tui/i18n';
import { currentTheme } from '#/tui/theme';
import type { ColorPalette } from '#/tui/theme/colors';

export const ELLIPSIS = '…';

export interface PluginsOverviewItem {
  readonly value: string;
  readonly kind: 'plugin' | 'action';
  readonly label: string;
  readonly status?: string;
  readonly description: string;
}

export function sectionLabel(label: string, colors: ColorPalette): string {
  return chalk.hex(colors.textDim).bold(` ${label}`);
}

export function statusStyle(
  item: PluginsOverviewItem,
  colors: ColorPalette,
): (text: string) => string {
  if (item.kind === 'action') return chalk.hex(colors.textDim);
  if (item.status === 'enabled' || item.status === 'installed') return chalk.hex(colors.success);
  if (item.status?.startsWith('install')) return chalk.hex(colors.primary);
  if (item.status === 'disabled') return chalk.hex(colors.textDim);
  if (item.status !== undefined && /^\d/.test(item.status)) return chalk.hex(colors.textDim);
  return chalk.hex(colors.warning);
}

// Status strings double as styling tokens (see statusStyle), so they stay
// English internally and are translated only at the display boundary. Plugin
// state enums (e.g. 'error') pass through unchanged.
export function displayStatus(status: string): string {
  if (status === 'enabled') return t('plugins.status.enabled');
  if (status === 'disabled') return t('plugins.status.disabled');
  return status;
}

export function mutedHintLine(text: string, colors?: ColorPalette): string {
  if (colors !== undefined) {
    return chalk.hex(colors.textMuted)(text);
  }
  return currentTheme.fg('textMuted', text);
}

export function wrapOverviewDescription(text: string, width: number): string[] {
  const maxWidth = Math.max(1, width);
  const words = text
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0);
  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    const candidate = current.length === 0 ? word : `${current} ${word}`;
    if (visibleWidth(candidate) <= maxWidth) {
      current = candidate;
      continue;
    }
    if (current.length > 0) lines.push(current);
    current = visibleWidth(word) <= maxWidth ? word : truncateToWidth(word, maxWidth, ELLIPSIS);
  }

  if (current.length > 0) lines.push(current);
  return lines;
}
