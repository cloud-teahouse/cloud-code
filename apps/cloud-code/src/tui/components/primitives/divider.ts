/**
 * Divider primitive — the frameless level of the two-level chrome system:
 * one full-width '─' rule in the `border` token (`borderFocus` on focused
 * surfaces), optionally embedding a title (`─ Title ───…`). This is the
 * single sanctioned way to draw a horizontal separator; do not hand-roll
 * `'─'.repeat(width)` lines or hard-code their colour.
 */

import { truncateToWidth, visibleWidth } from '@cloud-code/pi-tui';

import type { ColorToken } from '#/tui/theme';

import { styleText } from './text';

export interface DividerOptions {
  /** Embedded title after a `─ ` prefix; truncated when it cannot fit. */
  readonly title?: string;
  /** Line token; defaults to 'border' ('borderFocus' when `focused`). */
  readonly token?: ColorToken;
  /** Focused/attention surface — switches the default token to 'borderFocus'. */
  readonly focused?: boolean;
}

export function renderDivider(width: number, options?: DividerOptions): string {
  const w = Math.max(0, width);
  const token = options?.token ?? (options?.focused === true ? 'borderFocus' : 'border');
  const title = options?.title;
  // A titled divider needs `─ ` + title + ` ` + at least one trailing dash.
  if (title === undefined || w < 4) {
    return styleText('─'.repeat(w), token);
  }
  const text = visibleWidth(title) > w - 4 ? truncateToWidth(title, w - 4, '…') : title;
  return styleText(`─ ${text} ${'─'.repeat(w - 3 - visibleWidth(text))}`, token);
}
