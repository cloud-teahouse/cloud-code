/**
 * DialogFrame — the shared skeleton for list dialogs.
 *
 * One layout contract replaces every dialog's hand-derived row math:
 *
 *   divider
 *   title
 *   hint lines (wrapped at segment boundaries)
 *   notice lines (optional, warning/info block)
 *   blank
 *   tab strip + blank (optional, tabbed variants)
 *   search box (optional, searchable variants)
 *   ── content region (dialog-owned rows: list, cards, options) ──
 *   footer lines (optional: page indicator, counts)
 *   divider
 *
 * The frame owns the chrome rendering and, critically, the row math: it
 * counts the rows it renders, exposes the content region's origin via
 * {@link contentRow}, and offsets the content's hit zones into the
 * component frame via {@link zones} — so zones recorded while producing the
 * content lines are frame-relative by construction and no dialog re-derives
 * "my Nth row sits at screen row M" (no header-height constants, no
 * SEARCH_BOX_ROWS arithmetic).
 *
 * Composition, not a Component: each dialog owns a frame, splices its
 * content lines into {@link render}, and serves the composed zones from its
 * own `hitZones()`. Chrome zones the frame declares:
 *   - the search box (`id: DIALOG_SEARCH_ZONE`, action-only — a press
 *     focuses the box, there is no hover affordance);
 *   - the tab cells (`id: 'tab:<index>'`, action + hover).
 *
 * The frame also implements the shared behaviors the search-dialog family
 * used to copy between files: the layered Esc sequence
 * (clearQuery → unfocusSearch → close, see {@link handleEscape}) and the
 * too-small fallback ({@link tooSmall}, opt-in via chrome config).
 */

import {
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type HitZone,
} from '@cloud-code/pi-tui';

import { DIALOG_MIN_WIDTH } from '#/tui/constant/rendering';
import { t } from '#/tui/i18n';
import { currentTheme, type ColorToken } from '#/tui/theme';
import { wrapHint, wrapHintText } from '#/tui/utils/hint';
import { renderSearchBox } from '#/tui/utils/search-box';
import type { SearchableList } from '#/tui/utils/searchable-list';
import { renderTabStrip, tabStripHitZones } from '#/tui/utils/tab-strip';

/** Zone id of the frame's search box; a press focuses the box. */
export const DIALOG_SEARCH_ZONE = 'search';

/**
 * The shared too-small opt-in for inline (non-takeover) dialogs: spread the
 * result into the chrome config and early-return {@link DialogFrame.tooSmall}
 * in render — below {@link DIALOG_MIN_WIDTH} the dialog shows the notice
 * instead of a line-by-line clipped layout.
 */
export function inlineDialogMinSize(): DialogFrameChrome['minSize'] {
  return {
    width: DIALOG_MIN_WIDTH,
    message: t('common.tooSmall', { width: DIALOG_MIN_WIDTH }),
  };
}

/** Static chrome conventions of a dialog (set once, per dialog). */
export interface DialogFrameChrome {
  /** Prefix before the title text; defaults to none. */
  readonly titleIndent?: string;
  /** Prefix before each hint/notice line; defaults to a single space. */
  readonly hintIndent?: string;
  /** Color token of the divider lines and the default title styling;
   * defaults to 'border' (the chrome token of the two-level box system). */
  readonly tone?: ColorToken;
  /** Optional formatter replacing the bold title styling; receives the
   * titleIndent-prefixed title and returns the full title line. */
  readonly formatTitleLine?: (line: string) => string;
  /** Optional formatter replacing the muted styling of hint lines. */
  readonly formatHintLine?: (line: string) => string;
  /** Minimum size below which {@link tooSmall} renders the fallback. */
  readonly minSize?: {
    readonly width: number;
    readonly height?: number;
    readonly message: string;
  };
}

/** The warning/info block between the hint and the blank line. */
export interface DialogFrameNotice {
  readonly text: string;
  readonly tone: ColorToken;
  /** 'ansi' wraps SGR-styled text; 'words' re-flows plain words per source line. */
  readonly wrap: 'ansi' | 'words';
}

export interface DialogFrameTabStrip {
  readonly labels: readonly string[];
  readonly activeIndex: number;
  /** Hovered tab index (mouse motion); its cell renders underlined. */
  readonly hoverIndex?: number | null;
}

export interface DialogFrameSearch {
  readonly query: string;
  readonly focused: boolean;
  readonly placeholder?: string;
  /** When false the box renders but declares no focus zone — a transient
   * keyboard-only substate (e.g. an inline delete confirmation) owns the
   * dialog, matching its mouse-ignore behavior. Defaults to true. */
  readonly zone?: boolean;
}

/** Per-render inputs: everything the frame needs beyond the static chrome. */
export interface DialogFrameRenderOptions {
  readonly title: string;
  /** Hint as segments, join-wrapped ('↑↓ navigate · Enter select · …'). */
  readonly hintParts?: readonly string[];
  /** Hint as source lines, each re-wrapped at segment boundaries (overrides
   * hintParts). A line without the separator is a single segment and still
   * hard-truncates when wider than the line. */
  readonly hintLines?: readonly string[];
  readonly notice?: DialogFrameNotice;
  readonly tabStrip?: DialogFrameTabStrip;
  readonly search?: DialogFrameSearch;
  /** Content-region lines; their hit zones are passed to {@link zones}. */
  readonly content: readonly string[];
  /** Extra lines between the content region and the closing divider. */
  readonly footer?: readonly string[];
}

interface DialogFrameLayout {
  /** 0-based row of the content region's first line. */
  readonly contentRow: number;
  /** Zones of the frame chrome (search box, tab cells), already frame-relative. */
  readonly chromeZones: readonly HitZone[];
}

export class DialogFrame {
  private readonly chrome: DialogFrameChrome;
  /** Layout of the last render; zones are a render by-product (a render
   * always runs before the TUI dispatches input). */
  private layout: DialogFrameLayout = { contentRow: 0, chromeZones: [] };

  constructor(chrome: DialogFrameChrome = {}) {
    this.chrome = chrome;
  }

  /** 0-based row where the content region started in the last render. */
  get contentRow(): number {
    return this.layout.contentRow;
  }

  /**
   * Renders the full dialog: chrome header, content, footer, closing
   * divider. Row counts are derived from the lines actually produced — the
   * content region's origin is recorded, never recomputed from constants.
   * Lines are not width-clamped; the dialog applies its usual final clamp.
   */
  render(width: number, opts: DialogFrameRenderOptions): string[] {
    const tone = this.chrome.tone ?? 'border';
    const hintIndent = this.chrome.hintIndent ?? ' ';
    const textWidth = Math.max(1, width - visibleWidth(hintIndent));

    const titleText = `${this.chrome.titleIndent ?? ''}${opts.title}`;
    const lines: string[] = [
      currentTheme.fg(tone, '─'.repeat(width)),
      this.chrome.formatTitleLine === undefined
        ? currentTheme.boldFg(tone, titleText)
        : this.chrome.formatTitleLine(titleText),
    ];

    const hintLines =
      opts.hintLines !== undefined
        ? opts.hintLines.flatMap((line) => wrapHintText(line, textWidth))
        : opts.hintParts !== undefined
          ? wrapHint(opts.hintParts, textWidth)
          : [];
    for (const hintLine of hintLines) {
      const text = `${hintIndent}${hintLine}`;
      lines.push(
        this.chrome.formatHintLine === undefined
          ? currentTheme.fg('textMuted', text)
          : this.chrome.formatHintLine(text),
      );
    }

    if (opts.notice !== undefined) {
      const wrapped =
        opts.notice.wrap === 'ansi'
          ? wrapTextWithAnsi(opts.notice.text, textWidth)
          : opts.notice.text.split(/\r?\n/).flatMap((line) => wrapWords(line, textWidth));
      for (const line of wrapped) {
        lines.push(currentTheme.fg(opts.notice.tone, `${hintIndent}${line}`));
      }
    }
    lines.push('');

    const chromeZones: HitZone[] = [];
    if (opts.tabStrip !== undefined) {
      const stripRow = lines.length;
      lines.push(
        renderTabStrip({
          labels: opts.tabStrip.labels,
          activeIndex: opts.tabStrip.activeIndex,
          width,
          colors: currentTheme.palette,
          hoverIndex: opts.tabStrip.hoverIndex,
        }),
      );
      lines.push('');
      // Namespace the tab ids so they can never collide with the content's
      // numeric row ids.
      for (const zone of tabStripHitZones({
        labels: opts.tabStrip.labels,
        activeIndex: opts.tabStrip.activeIndex,
        width,
        row: stripRow,
      })) {
        chromeZones.push({ ...zone, id: `tab:${String(zone.id)}` });
      }
    }

    if (opts.search !== undefined) {
      const searchRow = lines.length;
      lines.push(
        ...renderSearchBox({
          width,
          query: opts.search.query,
          focused: opts.search.focused,
          ...(opts.search.placeholder !== undefined ? { placeholder: opts.search.placeholder } : {}),
        }),
      );
      if (opts.search.zone !== false) {
        chromeZones.push({
          id: DIALOG_SEARCH_ZONE,
          row: searchRow,
          col: 1,
          width,
          height: lines.length - searchRow,
          semantics: { hover: false },
        });
      }
    }

    this.layout = { contentRow: lines.length, chromeZones };

    lines.push(...opts.content);
    if (opts.footer !== undefined) lines.push(...opts.footer);
    lines.push(currentTheme.fg(tone, '─'.repeat(width)));
    return lines;
  }

  /**
   * The frame-relative hit zones for the last render: the chrome zones plus
   * the content's zones shifted by the content region's origin. Content
   * zones are recorded by the dialog while producing the content lines
   * (row 0 = first content line), so the offset is the only row math left.
   */
  zones(contentZones: readonly HitZone[]): HitZone[] {
    const { contentRow, chromeZones } = this.layout;
    return [
      ...chromeZones,
      ...contentZones.map((zone) => ({ ...zone, row: zone.row + contentRow })),
    ];
  }

  /**
   * The layered Esc sequence every searchable dialog shares: clear the
   * query (running `afterClear` for dialog-specific bookkeeping), then
   * unfocus the search box, then close the dialog.
   */
  handleEscape<T>(list: SearchableList<T>, close: () => void, afterClear?: () => void): void {
    if (list.clearQuery()) {
      afterClear?.();
      return;
    }
    if (list.unfocusSearch()) return;
    close();
  }

  /**
   * The too-small fallback, once: the configured message (error tone), padded
   * to `rows` when the host knows the screen height. Returns null when the
   * frame has no minimum configured or the terminal is large enough.
   */
  tooSmall(width: number, rows?: number): string[] | null {
    const min = this.chrome.minSize;
    if (min === undefined) return null;
    if (width >= min.width && (min.height === undefined || rows === undefined || rows >= min.height)) {
      return null;
    }
    const lines = [truncateToWidth(currentTheme.fg('error', min.message), Math.max(1, width))];
    if (rows !== undefined) {
      while (lines.length < rows) lines.push('');
    }
    return lines;
  }
}

/**
 * Re-flows plain text onto lines of at most `width` visible columns,
 * breaking at word boundaries; an over-long word hard-truncates (there is no
 * good break point inside it). Used by the 'words' notice wrap and by
 * dialogs for option descriptions.
 */
export function wrapWords(text: string, width: number): string[] {
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
    current = visibleWidth(word) <= maxWidth ? word : truncateToWidth(word, maxWidth, '…');
  }

  if (current.length > 0) lines.push(current);
  return lines;
}
