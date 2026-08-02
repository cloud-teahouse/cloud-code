/**
 * Shared search-box renderer for searchable list dialogs — the visible,
 * focusable counterpart of SearchableList's query state, modeled on Claude
 * Code's SearchBox: an always-visible rounded box with a `⌕` prefix and a
 * dim "Search…" placeholder; the border highlights while the box is focused
 * and an inverse-video block cursor marks the (append-only) query tail.
 *
 * Pure rendering — the focus/typing state machine lives in
 * `#/tui/utils/searchable-list`; components splice the returned rows into
 * their header and use SEARCH_BOX_ROWS in their mouse hit tests.
 */

import chalk from 'chalk';
import { truncateToWidth, visibleWidth } from '@cloud-code/pi-tui';

import { t } from '#/tui/i18n';
import { currentTheme } from '#/tui/theme';

/** Rows the box occupies — hit-test math in the hosting dialogs depends on it. */
export const SEARCH_BOX_ROWS = 3;

const SEARCH_PREFIX = '⌕ ';
const ELLIPSIS = '…';
const PREFIX_WIDTH = visibleWidth(SEARCH_PREFIX);

export interface SearchBoxRenderOptions {
  readonly width: number;
  readonly query: string;
  /** Whether the box is the typing target (SearchableListView.searchFocused). */
  readonly focused: boolean;
  /** Placeholder shown while the query is empty; defaults to the shared "Search…". */
  readonly placeholder?: string;
}

export function renderSearchBox(opts: SearchBoxRenderOptions): string[] {
  const width = Math.max(8, opts.width);
  const placeholder = opts.placeholder ?? t('common.searchPlaceholder');
  const borderColor = opts.focused ? 'borderFocus' : 'border';
  const border = (line: string): string => currentTheme.fg(borderColor, line);

  // Inner budget: the side borders plus the single-cell padding on each side.
  const innerWidth = Math.max(1, width - 4);
  const content = renderContent(opts.query, placeholder, opts.focused, innerWidth);
  const padding = ' '.repeat(Math.max(0, innerWidth - content.width));

  return [
    border(`╭${'─'.repeat(width - 2)}╮`),
    `${border('│')} ${content.line}${padding} ${border('│')}`,
    border(`╰${'─'.repeat(width - 2)}╯`),
  ];
}

function renderContent(
  query: string,
  placeholder: string,
  focused: boolean,
  innerWidth: number,
): { line: string; width: number } {
  const budget = Math.max(1, innerWidth - PREFIX_WIDTH);
  const prefix = focused
    ? currentTheme.fg('text', SEARCH_PREFIX)
    : currentTheme.fg('textMuted', SEARCH_PREFIX);
  if (!focused) {
    // Unfocused: query text (tail-kept) or the dim placeholder.
    const plain = query.length > 0 ? tailByWidth(query, budget) : truncateToWidth(placeholder, budget, ELLIPSIS);
    return { line: prefix + currentTheme.fg('textMuted', plain), width: PREFIX_WIDTH + visibleWidth(plain) };
  }
  if (query.length === 0) {
    // Claude Code's empty-focused state: the cursor sits on the placeholder's
    // first cell, the rest stays dimmed.
    const first = placeholder.slice(0, 1);
    const rest = truncateToWidth(placeholder.slice(1), Math.max(0, budget - visibleWidth(first)), ELLIPSIS);
    const line = prefix + chalk.inverse(first) + currentTheme.fg('textMuted', rest);
    return { line, width: PREFIX_WIDTH + visibleWidth(first) + visibleWidth(rest) };
  }
  const plain = tailByWidth(query, Math.max(1, budget - 1));
  const line = prefix + currentTheme.fg('text', plain) + chalk.inverse(' ');
  return { line, width: PREFIX_WIDTH + visibleWidth(plain) + 1 };
}

/**
 * Keeps the tail of an over-long query (the cursor lives at the end), marking
 * the hidden head with an ellipsis. Queries are raw user input without SGR.
 */
function tailByWidth(text: string, budget: number): string {
  if (visibleWidth(text) <= budget) return text;
  const keep = Math.max(1, budget - visibleWidth(ELLIPSIS));
  let out = '';
  let used = 0;
  for (const ch of Array.from(text).reverse()) {
    const w = visibleWidth(ch);
    if (used + w > keep) break;
    out = ch + out;
    used += w;
  }
  return ELLIPSIS + out;
}
