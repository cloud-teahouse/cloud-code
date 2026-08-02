/**
 * Text primitives — the smallest styling/width helpers the visual system
 * shares: theme-token styling and display-width-aware pad/truncate. All
 * width math delegates to pi-tui (`visibleWidth`, `truncateToWidth`) and
 * `padEndVisible`; nothing here re-derives cell widths.
 */

import { truncateToWidth, visibleWidth } from '@cloud-code/pi-tui';

import { padEndVisible } from '#/tui/i18n/pad-visible';
import { currentTheme, type ColorToken } from '#/tui/theme';

/**
 * Style `text` with a theme color token. The palette is read on every call,
 * so a theme switch repaints on the next render — never cache the result at
 * module scope.
 */
export function styleText(text: string, token: ColorToken, bold = false): string {
  return bold ? currentTheme.boldFg(token, text) : currentTheme.fg(token, text);
}

/**
 * Display-width-aware `String.prototype.padStart` — the right-align
 * companion to `padEndVisible`. Plain `.padStart()` counts UTF-16 code
 * units, so CJK text (2 columns each) gets over-padded and right-aligned
 * columns drift; this pads by *visible columns*. Strings already at or
 * beyond `width` are returned unchanged (no truncation).
 */
export function padStartVisible(text: string, width: number, fill = ' '): string {
  const padding = width - visibleWidth(text);
  return padding <= 0 ? text : fill.repeat(padding) + text;
}

/**
 * Fit `text` to exactly `width` visible columns: pad when short, truncate
 * with `ellipsis` when long.
 */
export function fitText(text: string, width: number, ellipsis = '…'): string {
  return visibleWidth(text) > width
    ? truncateToWidth(text, width, ellipsis)
    : padEndVisible(text, width);
}

/**
 * The strict counterpart of {@link fitText}: also re-pads after truncation,
 * which can land short of `width` when a wide (CJK) glyph straddles the
 * budget. Use where a surface needs every row at exactly `width` columns.
 */
export function fitExactly(line: string, width: number, ellipsis = '…'): string {
  let s = line;
  if (visibleWidth(s) > width) s = truncateToWidth(s, width, ellipsis);
  const w = visibleWidth(s);
  if (w === width) return s;
  if (w > width) return truncateToWidth(s, width, ellipsis);
  return s + ' '.repeat(width - w);
}
