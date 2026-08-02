/**
 * Row primitive — one horizontal line of styled cells joined by a fixed gap.
 *
 * Deliberately not a flexbox: a cell's width is its content width unless an
 * explicit (visible-column) width floors it; nothing is shrunk, truncated,
 * or redistributed. When several rows must share one column width (the
 * `Label: value` grammar), derive it once with {@link columnWidth} and pass
 * it to each row's cell.
 *
 * Styling order is part of the contract: the text is padded to its width
 * first, then the token style wraps the whole padded cell, so the padding
 * carries the cell's colour — matching the hand-written
 * `muted(padEndVisible(label, w))` rows this replaces.
 */

import { visibleWidth } from '@cloud-code/pi-tui';

import { padEndVisible } from '#/tui/i18n/pad-visible';
import type { ColorToken } from '#/tui/theme';

import { padStartVisible, styleText } from './text';

export interface RowCell {
  readonly text: string;
  /** Theme token applied to the padded cell; omit for pre-styled text. */
  readonly token?: ColorToken;
  /** Bold variant of the token style. */
  readonly bold?: boolean;
  /** Minimum column width in visible columns; content wider than this is
   * kept as-is (a width floors the column, it never caps it). */
  readonly width?: number;
  /** Alignment inside `width`; defaults to 'left'. */
  readonly align?: 'left' | 'right';
}

export interface RowOptions {
  /** Spaces between cells; defaults to 2. */
  readonly gap?: number;
  /** Left margin in spaces; defaults to 0. */
  readonly margin?: number;
}

/** The shared column width for a set of rows: widest content, floored at `min`. */
export function columnWidth(texts: readonly string[], min = 0): number {
  return texts.reduce((max, text) => Math.max(max, visibleWidth(text)), min);
}

export function renderRow(cells: readonly RowCell[], options?: RowOptions): string {
  const gap = ' '.repeat(options?.gap ?? 2);
  const margin = ' '.repeat(options?.margin ?? 0);
  const parts = cells.map((cell) => {
    const padded =
      cell.width === undefined
        ? cell.text
        : cell.align === 'right'
          ? padStartVisible(cell.text, cell.width)
          : padEndVisible(cell.text, cell.width);
    return cell.token === undefined ? padded : styleText(padded, cell.token, cell.bold ?? false);
  });
  return margin + parts.join(gap);
}
