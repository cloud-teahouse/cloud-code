/**
 * Shared mouse hover/hit-test idiom for interactive TUI components — the
 * hover counterpart of the SearchableList keyboard state machine.
 *
 * Click semantics (uniform across dialogs, mirroring GUI lists):
 *   - single left-press on a row moves the cursor/selection onto it;
 *   - a press on the already-selected row confirms it (Enter equivalent —
 *     SGR mouse has no double-click event, so re-click is the "open"
 *     gesture). Toggle rows (checkboxes, question options) activate
 *     directly on press since toggling IS the row action; tabs switch
 *     immediately.
 *
 * Hover semantics: pointer motion over an interactive element paints a hover
 * affordance, split by element kind:
 *   - list rows (and other full text rows) render underlined —
 *     hovered-not-selected = underline, selected = the existing highlight,
 *     hovered+selected = highlight + underline (`underlineText`);
 *   - word-level affordances and menu choices (the /status Stats range
 *     words, the slash-command autocomplete rows) paint the theme's
 *     `hoverBackground` background — a dimmer blue than the `primary`
 *     selection fill, so hover never reads as selected (`highlightBgIf`).
 * When no mouse is in use the hover state stays null and renders are
 * byte-identical to the keyboard-only flow.
 *
 * Usage in a component:
 *   private readonly hover = new HoverState();
 *
 *   handleMouse(event: MouseEvent): void | boolean {
 *     if (event.type === 'motion') {
 *       return trackHover(event, this.hover, (row) => this.hitIndexForRow(row))
 *         ? undefined
 *         : false; // unchanged → the TUI skips the re-render
 *     }
 *     ...press/wheel handling...
 *   }
 *
 *   render(): wrap each interactive row's label with
 *   underlineText(line, this.hover.isHovered(i)).
 *
 * `hitIndexForRow` is the same row→index math the component already uses
 * for press hit-testing (header heights, page window, per-item heights) —
 * keeping one mapping shared by press and hover is the whole point.
 */

import chalk from 'chalk';
import type { MouseEvent } from '@cloud-code/pi-tui';

import { currentTheme } from '#/tui/theme';

/**
 * The hovered interactive element of a component (list row, tab, button), or
 * null when the pointer is not over anything interactive. Motion events
 * with row -1 (pointer left the component region — see MouseEvent) clear
 * it via {@link update}.
 *
 * The key type is free-form: simple lists use the row index (number);
 * components with several interactive regions (tabs + options + action
 * rows) use namespaced string keys like `tab:2` / `option:0`.
 */
export class HoverState<K = number> {
  private hovered: K | null = null;

  /** The hovered key, or null when nothing is hovered. */
  get index(): K | null {
    return this.hovered;
  }

  /**
   * Sets the hovered key (null clears). Returns true when the value
   * actually changed — i.e. when a re-render is warranted.
   */
  update(key: K | null): boolean {
    if (key === this.hovered) return false;
    this.hovered = key;
    return true;
  }

  isHovered(key: K): boolean {
    return this.hovered === key;
  }
}

/**
 * Hover underline for a rendered row/segment — the one underline idiom.
 *
 * Extent: the underline spans exactly the element's visible text, from its
 * first to its last non-space character. Leading indentation and trailing
 * full-width padding stay plain whether the spaces are bare (fitExactly) or
 * wrapped inside a styled segment; the interior spacing between a row's
 * segments stays underlined, so a clickable row reads as one continuous
 * mark covering its text and nothing else.
 *
 * Color: the run carries a single SGR 58 underline color (set once, plus
 * SGR 4 for the underline itself), so the line renders in ONE color even
 * when the row mixes styled segments — per-segment foregrounds no longer
 * tint their slice of the underline, while the segment text colors stay
 * intact. `color` is a hex value (#rgb / #rrggbb); it defaults to the
 * theme's `text` token (the palette has no dedicated hover-foreground
 * token, so the underline takes the text color). An unparseable value
 * degrades to a plain SGR 4 underline, and terminals without SGR 58 support
 * ignore it, falling back to per-segment foreground underlines.
 *
 * Applied AFTER the row's normal styling; inner color resets (SGR 39/49)
 * clear neither SGR 4 nor SGR 58, so selection highlights survive. No-ops
 * (returns `rendered` unchanged): not hovered, colors disabled
 * (chalk.level 0 — keyboard-only/no-TTY renders stay byte-identical), or no
 * visible non-space text in the string.
 */
export function underlineText(rendered: string, hovered: boolean, color?: string): string {
  if (!hovered || chalk.level === 0) return rendered;
  const extent = textExtent(rendered);
  if (extent === null) return rendered;
  const rgb = hexToRgb(color ?? currentTheme.color('text'));
  const open =
    rgb === null
      ? '\x1b[4m'
      : `\x1b[58;2;${String(rgb[0])};${String(rgb[1])};${String(rgb[2])}m\x1b[4m`;
  const close = rgb === null ? '\x1b[24m' : '\x1b[24m\x1b[59m';
  return rendered.slice(0, extent[0]) + open + rendered.slice(extent[0], extent[1]) + close + rendered.slice(extent[1]);
}

/**
 * Hover background for word-level affordances (the /status Stats range
 * words) — the background counterpart of {@link underlineText}, used where
 * an underline would read as a text edit affordance rather than a choice.
 *
 * Extent: the background spans exactly the element's visible text, first to
 * last non-space character — the same {@link textExtent} walk as
 * `underlineText`, so leading indentation and trailing padding stay plain.
 *
 * Color: a single SGR 48 truecolor background (`48;2;r;g;b` … `49`) in the
 * theme's `hoverBackground` token — deliberately a dimmer blue than the
 * `primary` selection fill so a hovered choice never reads as selected.
 * `color` is a hex override (#rgb / #rrggbb); an unparseable value degrades
 * to the plain theme token, and terminals without truecolor let chalk's own
 * downsampling approximate it (the wrapper emits raw SGR only at
 * chalk.level ≥ 1; at level 2/1 the 48;2 sequence is still valid SGR —
 * terminals map it to their nearest color). Inner foreground resets
 * (SGR 39) do not clear the background, so per-segment text colors survive.
 * No-ops (returns `rendered` unchanged): not hovered, colors disabled
 * (chalk.level 0 — keyboard-only/no-TTY renders stay byte-identical), or no
 * visible non-space text in the string.
 */
export function highlightBgIf(rendered: string, hovered: boolean, color?: string): string {
  if (!hovered || chalk.level === 0) return rendered;
  const extent = textExtent(rendered);
  if (extent === null) return rendered;
  const rgb = hexToRgb(color ?? currentTheme.color('hoverBackground')) ?? hexToRgb(currentTheme.color('hoverBackground'));
  if (rgb === null) return rendered;
  const open = `\x1b[48;2;${String(rgb[0])};${String(rgb[1])};${String(rgb[2])}m`;
  return rendered.slice(0, extent[0]) + open + rendered.slice(extent[0], extent[1]) + '\x1b[49m' + rendered.slice(extent[1]);
}

/**
 * The visible-text extent of a rendered line: the string offset of the
 * first non-space visible character and the offset just past the last one,
 * or null when the line has no visible text. ANSI escape sequences are
 * skipped and non-BMP characters are kept whole, so the offsets never split
 * an escape sequence or a surrogate pair.
 */
function textExtent(rendered: string): readonly [number, number] | null {
  let start = -1;
  let end = -1;
  let i = 0;
  while (i < rendered.length) {
    const escapeLength = ansiLengthAt(rendered, i);
    if (escapeLength > 0) {
      i += escapeLength;
      continue;
    }
    const codePoint = rendered.codePointAt(i)!;
    const charLength = codePoint > 0xffff ? 2 : 1;
    if (codePoint !== 0x20) {
      if (start < 0) start = i;
      end = i + charLength;
    }
    i += charLength;
  }
  return start < 0 ? null : [start, end];
}

/**
 * Length of the ANSI escape sequence starting at `pos`, or 0 when none
 * starts there. Handles CSI (`ESC [` … final byte in @–~) and OSC/APC
 * (`ESC ]` / `ESC _` … BEL or ST).
 */
function ansiLengthAt(str: string, pos: number): number {
  if (str[pos] !== '\x1b') return 0;
  const kind = str[pos + 1];
  if (kind === '[') {
    let j = pos + 2;
    while (j < str.length && !/[@-~]/.test(str[j]!)) j++;
    return j < str.length ? j + 1 - pos : 0;
  }
  if (kind === ']' || kind === '_') {
    let j = pos + 2;
    while (j < str.length) {
      if (str[j] === '\x07') return j + 1 - pos;
      if (str[j] === '\x1b' && str[j + 1] === '\\') return j + 2 - pos;
      j++;
    }
  }
  return 0;
}

/** Parses a #rgb / #rrggbb hex color into RGB channels; null otherwise. */
function hexToRgb(hex: string): readonly [number, number, number] | null {
  const short = /^#[0-9a-fA-F]{3}$/.exec(hex);
  const long = /^#[0-9a-fA-F]{6}$/.exec(hex);
  const full =
    long !== null
      ? hex.slice(1)
      : short !== null
        ? hex.slice(1).split('').map((c) => c + c).join('')
        : null;
  if (full === null) return null;
  return [
    Number.parseInt(full.slice(0, 2), 16),
    Number.parseInt(full.slice(2, 4), 16),
    Number.parseInt(full.slice(4), 16),
  ];
}

/**
 * Shared motion-event branch for component handleMouse implementations:
 * maps the component-relative motion row to a hover index via `hitAt`
 * (the component's press hit-test math; return null for non-interactive
 * rows) and updates `hover`. Row -1 (pointer left the component) clears.
 * Returns true when the hover state changed and a re-render is needed;
 * components pass `false` through as their handleMouse return otherwise so
 * the TUI skips the frame.
 */
export function trackHover(
  event: MouseEvent,
  hover: HoverState,
  hitAt: (row: number) => number | null,
): boolean {
  const index = event.row < 0 ? null : hitAt(event.row);
  return hover.update(index);
}

/**
 * Column-walk hit test for horizontal segmented controls (tab strips,
 * effort segments): given the visible cell widths in display order, the
 * 1-based column of the first cell, the gap in cells between adjacent
 * cells, and a 1-based terminal column, returns the index of the cell
 * containing the column, or null over the leading padding and the gaps.
 */
export function columnHitIndex(
  widths: readonly number[],
  startCol: number,
  gap: number,
  col: number,
): number | null {
  let next = startCol;
  for (let i = 0; i < widths.length; i++) {
    const width = widths[i] ?? 0;
    if (col >= next && col < next + width) return i;
    next += width + gap;
  }
  return null;
}

/**
 * Row-walk hit test: given the rendered heights of consecutive interactive
 * items (in display order) and a 0-based row offset into their shared list
 * area, returns the display position of the item whose row range contains
 * the offset, or null when the offset falls outside all items. This is the
 * per-item-heights generalization of `start + offset` for rows that occupy
 * more than one line (e.g. an option label plus its wrapped description).
 */
export function rowHitIndex(heights: readonly number[], offset: number): number | null {
  if (offset < 0) return null;
  let top = 0;
  for (let i = 0; i < heights.length; i++) {
    const height = heights[i] ?? 1;
    if (offset < top + height) return i;
    top += height;
  }
  return null;
}
