/**
 * Shared tab strip renderer for tabbed dialogs (model selector, plugin
 * marketplace, …). The active tab is filled with the brand background, inactive
 * tabs are muted — matching the AskUserQuestion dialog. See
 * docs/tui-design.md §6 (选中/hover 的 token 约定).
 *
 * When the strip is wider than the terminal, it scrolls to keep the active tab
 * visible, framed by `<`/`>` markers.
 *
 * Mouse support: `hoverIndex` underlines one tab cell (hover highlight), and
 * the hit side uses the same layout math as the renderer so click and hover
 * hit-tests never drift from what is on screen. `tabStripHitZones` declares
 * the visible tab cells as pi-tui hit zones for zone-based dialogs;
 * `tabStripIndexAtCol` is the legacy column hit-test for dialogs that still
 * drive handleMouse by hand.
 */

import { visibleWidth, type HitZone } from '@cloud-code/pi-tui';
import chalk from 'chalk';

import type { ColorPalette } from '#/tui/theme/colors';

export interface RenderTabStripOptions {
  readonly labels: readonly string[];
  readonly activeIndex: number;
  readonly width: number;
  readonly colors: ColorPalette;
  /** Hovered tab index (mouse motion); its cell is underlined. */
  readonly hoverIndex?: number | null;
}

/** Style one tab cell. Active and inactive cells have the same visible width so
 * switching never shifts the layout. */
function styleTab(label: string, isActive: boolean, hovered: boolean, colors: ColorPalette): string {
  const cell = ` ${label} `;
  const styled = isActive
    ? chalk.bgHex(colors.primary).hex(colors.onPrimary).bold(cell)
    : chalk.hex(colors.textMuted)(cell);
  return hovered ? chalk.underline(styled) : styled;
}

interface StripWindow {
  /** First visible tab index. */
  readonly start: number;
  /** One past the last visible tab index. */
  readonly end: number;
  /** Visible width of each tab cell, indexed by tab. */
  readonly cellWidths: readonly number[];
}

/**
 * The visible tab window for a width: everything when it fits (with the
 * leading space), otherwise the widest window containing activeIndex. Shared
 * by the renderer and the column hit-test so they never disagree.
 */
function computeStripWindow(labels: readonly string[], activeIndex: number, width: number): StripWindow {
  const cellWidths = labels.map((label) => visibleWidth(` ${label} `));

  // Account for the single spaces `join(' ')` inserts between tabs — otherwise
  // the strip is declared to fit at widths where the joined line is actually
  // wider and gets truncated instead of showing the `<`/`>` scroll markers.
  const totalCellWidth = cellWidths.reduce((sum, w) => sum + w, 0);
  const fullSeparatorWidth = Math.max(0, labels.length - 1);
  if (1 + totalCellWidth + fullSeparatorWidth <= width) {
    return { start: 0, end: labels.length, cellWidths };
  }

  let start = activeIndex;
  let end = activeIndex + 1;
  let contentWidth = cellWidths[activeIndex] ?? 0;

  const fits = (s: number, e: number, cw: number): boolean => {
    const needLeft = s > 0;
    const needRight = e < labels.length;
    const frameWidth = (needLeft ? 2 : 1) + (needRight ? 2 : 0);
    const separators = Math.max(0, e - s - 1);
    return cw + separators + frameWidth <= width;
  };

  while (true) {
    const leftW = start > 0 ? cellWidths[start - 1]! : Infinity;
    const rightW = end < labels.length ? cellWidths[end]! : Infinity;
    if (leftW === Infinity && rightW === Infinity) break;

    if (leftW <= rightW) {
      if (fits(start - 1, end, contentWidth + leftW)) {
        contentWidth += leftW;
        start--;
      } else if (fits(start, end + 1, contentWidth + rightW)) {
        contentWidth += rightW;
        end++;
      } else {
        break;
      }
    } else if (fits(start, end + 1, contentWidth + rightW)) {
      contentWidth += rightW;
      end++;
    } else if (fits(start - 1, end, contentWidth + leftW)) {
      contentWidth += leftW;
      start--;
    } else {
      break;
    }
  }

  return { start, end, cellWidths };
}

/**
 * 1-based start columns of the visible tab cells, in window order. The strip
 * line starts at terminal column 1 with either a plain space or the `< `
 * scroll marker (both 2 cells wide when scrolled, 1 otherwise — see render).
 */
function visibleTabColumns(labels: readonly string[], window: StripWindow): number[] {
  const hasLeft = window.start > 0;
  const cols: number[] = [];
  let col = hasLeft ? 3 : 2; // 1-based first cell of the first visible tab
  for (let i = window.start; i < window.end; i++) {
    cols.push(col);
    col += (window.cellWidths[i] ?? 0) + 1; // cell + single-space separator
  }
  return cols;
}

export function renderTabStrip(opts: RenderTabStripOptions): string {
  const { labels, activeIndex, width, colors } = opts;
  const hoverIndex = opts.hoverIndex ?? null;
  const window = computeStripWindow(labels, activeIndex, width);
  const hasLeft = window.start > 0;
  const hasRight = window.end < labels.length;

  const cells: string[] = [];
  for (let i = window.start; i < window.end; i++) {
    cells.push(styleTab(labels[i]!, i === activeIndex, i === hoverIndex, colors));
  }

  let strip = hasLeft ? chalk.hex(colors.textMuted)('< ') : ' ';
  strip += cells.join(' ');
  if (hasRight) {
    strip += chalk.hex(colors.textMuted)(' >');
  }
  return strip;
}

/**
 * Declares the visible tab cells as hit zones for the strip rendered at `row`
 * within the component's own output, using the same layout math as
 * {@link renderTabStrip} — zone id = tab index, in the hit-zone coordinate
 * space (row 0-based, col 1-based). Only visible tabs get zones; the leading
 * space, separators, and `<`/`>` scroll markers are chrome and stay
 * unclickable.
 */
export function tabStripHitZones(opts: {
  readonly labels: readonly string[];
  readonly activeIndex: number;
  readonly width: number;
  /** 0-based row of the strip line within the component's rendered output. */
  readonly row: number;
}): HitZone[] {
  const { labels, activeIndex, width, row } = opts;
  const window = computeStripWindow(labels, activeIndex, width);
  const cols = visibleTabColumns(labels, window);
  const zones: HitZone[] = [];
  for (let i = window.start; i < window.end; i++) {
    zones.push({
      id: i,
      row,
      col: cols[i - window.start]!,
      width: window.cellWidths[i] ?? 0,
      height: 1,
    });
  }
  return zones;
}

/**
 * Maps a 1-based terminal column on the strip row to a tab index, using the
 * same layout math as {@link renderTabStrip} (the strip starts at column 1).
 * Returns null over the leading space, the separators, and the `<`/`>`
 * scroll markers — those are chrome, not tabs.
 */
export function tabStripIndexAtCol(opts: {
  readonly labels: readonly string[];
  readonly activeIndex: number;
  readonly width: number;
  readonly col: number;
}): number | null {
  const { labels, activeIndex, width, col } = opts;
  const window = computeStripWindow(labels, activeIndex, width);
  const cols = visibleTabColumns(labels, window);
  for (let i = window.start; i < window.end; i++) {
    const startCol = cols[i - window.start]!;
    const cellWidth = window.cellWidths[i] ?? 0;
    if (col >= startCol && col < startCol + cellWidth) return i;
  }
  return null;
}
