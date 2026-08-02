/**
 * ChoicePicker — modal single-select list for slash commands that ask
 * the user to pick from a small set of preset values.
 *
 * Mirrors SessionPickerComponent's container-replacement pattern: host
 * calls `showChoicePicker(...)` which clears the editor container,
 * addChild(picker), setFocus(picker); the picker invokes `onSelect` or
 * `onCancel`, and the host tears it down.
 */

import {
  Container,
  matchesKey,
  Key,
  truncateToWidth,
  hitZoneAt,
  type Focusable,
  type HitZone,
  type HitZoneId,
  type MouseEvent,
} from '@cloud-code/pi-tui';
import { SELECT_POINTER } from '#/tui/constant/symbols';
import { t } from '#/tui/i18n';
import { currentTheme, type ColorToken } from '#/tui/theme';
import { normalizeLegacyMetaKey } from '#/tui/utils/legacy-meta-key';
import { HoverState, underlineText } from '#/tui/utils/mouse-hover';
import { printableChar } from '#/tui/utils/printable-key';
import { SearchableList, type SearchableListView } from '#/tui/utils/searchable-list';

import {
  DIALOG_SEARCH_ZONE,
  DialogFrame,
  inlineDialogMinSize,
  wrapWords,
} from './frame/dialog-frame';

export interface ChoiceOption {
  /** Value passed to onSelect (e.g. the actual editor command string). */
  readonly value: string;
  /** Display text shown in the list. */
  readonly label: string;
  /** Optional semantic tone for labels that need stronger visual treatment. */
  readonly tone?: 'danger';
  /** Optional explanatory text shown below the label. */
  readonly description?: string | undefined;
  /** Color token applied to the description while this option is selected, drawing
   *  attention to important details. Falls back to `textMuted` when unset or not selected. */
  readonly descriptionTone?: ColorToken;
}

export interface ChoicePickerOptions {
  readonly title: string;
  readonly hint?: string;
  readonly formatHint?: (text: string) => string;
  readonly notice?: string;
  /** Color tone for the notice line. Defaults to 'success'. */
  readonly noticeTone?: 'success' | 'warning';
  readonly options: readonly ChoiceOption[];
  readonly currentValue?: string;
  /** When true, typed characters filter the list (fuzzy) and the focusable
   * search box is shown (`/` focuses, Esc clears → unfocuses → cancels). */
  readonly searchable?: boolean;
  /** Items per page. Lists longer than this paginate. */
  readonly pageSize?: number;
  readonly onSelect: (value: string) => void;
  /** When provided, Alt+S invokes this with the selected value instead of
   * onSelect — used to apply the choice to the current session only. */
  readonly onSessionOnlySelect?: (value: string) => void;
  readonly onCancel: () => void;
}

export class ChoicePickerComponent extends Container implements Focusable {
  focused = false;
  private readonly opts: ChoicePickerOptions;
  private readonly list: SearchableList<ChoiceOption>;
  /** The dialog skeleton owning the chrome (divider/title/hint/notice/
   * search box) and its row math. */
  private readonly frame: DialogFrame;
  /** Frame-relative hit zones of the last render (search box + option rows)
   * — served from hitZones(). */
  private frameZones: HitZone[] = [];
  /** Width of the last render; direct handleMouse calls re-derive the zones
   * from the current state at this width (the TUI's zone dispatch uses the
   * render cache — a render always runs before dispatched input). */
  private lastRenderWidth = 80;
  /** Hovered option index (mouse motion); null when the pointer is elsewhere. */
  private readonly hover = new HoverState<HitZoneId>();

  constructor(opts: ChoicePickerOptions) {
    super();
    this.opts = opts;
    this.frame = new DialogFrame({
      titleIndent: ' ',
      minSize: inlineDialogMinSize(),
      ...(opts.formatHint !== undefined ? { formatHintLine: opts.formatHint } : {}),
    });
    const currentIdx = opts.options.findIndex((o) => o.value === opts.currentValue);
    this.list = new SearchableList({
      items: opts.options,
      toSearchText: (o) => `${o.label} ${o.description ?? ''}`,
      pageSize: opts.pageSize,
      initialIndex: Math.max(currentIdx, 0),
      searchable: opts.searchable === true,
    });
  }

  handleInput(data: string): void {
    // Legacy ESC-prefixed Alt bytes → CSI-u when Kitty is active (see
    // utils/legacy-meta-key); everything else passes through untouched.
    const normalized = normalizeLegacyMetaKey(data);
    if (matchesKey(normalized, Key.escape)) {
      this.frame.handleEscape(this.list, this.opts.onCancel);
      return;
    }
    if (matchesKey(normalized, Key.alt('s')) && this.opts.onSessionOnlySelect !== undefined) {
      const chosen = this.list.selected();
      if (chosen !== undefined) this.opts.onSessionOnlySelect(chosen.value);
      return;
    }
    // Left/Right page through the list (this picker has no horizontal
    // control). While the search box is the selected option they stay inert:
    // arrows never move the list highlight under a selected box.
    if (matchesKey(normalized, Key.left) || matchesKey(normalized, Key.right)) {
      if (this.list.view().searchFocused) return;
      if (matchesKey(normalized, Key.left)) this.list.pageUp();
      else this.list.pageDown();
      return;
    }
    // Enter always selects. Space selects too — but only when the list is not
    // searchable; in a searchable list a space must reach the query instead.
    const isSpace = matchesKey(normalized, Key.space) || printableChar(normalized) === ' ';
    if (matchesKey(normalized, Key.enter) || (isSpace && this.opts.searchable !== true)) {
      const chosen = this.list.selected();
      if (chosen !== undefined) this.opts.onSelect(chosen.value);
      return;
    }
    this.list.handleKey(normalized);
  }

  /** Mouse: the wheel moves the cursor one row per tick, clamped by
   * SearchableList exactly like ↑/↓. Press and hover targeting is declared as
   * hit zones (see renderContent); the TUI dispatches zone presses to
   * {@link onHitZone} and tracks the hovered zone via {@link setHoveredZone}.
   * This handler keeps the wheel behavior and routes presses/motion arriving
   * outside the zone dispatch (e.g. direct component-relative events) through
   * the same zones. */
  handleMouse(event: MouseEvent): void | boolean {
    // Re-derived from the current state: direct callers (unit tests) may fire
    // keys without an intervening render, so the render cache can be stale.
    const zones = this.currentZones();
    if (event.type === 'motion') {
      const zone = event.row < 0 ? null : hitZoneAt(zones, event.row, event.col, 'hover');
      return this.setHoveredZone(zone?.id ?? null);
    }
    if (event.type === 'press' && event.button === 0) {
      const zone = hitZoneAt(zones, event.row, event.col, 'action');
      if (zone === null) return false;
      return this.onHitZone(zone.id, event);
    }
    if (event.type !== 'wheel') return false;
    const delta = event.button === 64 ? -1 : event.button === 65 ? 1 : 0;
    if (delta === 0 || this.list.view().items.length === 0) return false;
    if (delta < 0) this.list.moveUp();
    else this.list.moveDown();
    this.invalidate();
  }

  /** The declared zones of the last render. */
  hitZones(): Iterable<HitZone> {
    return this.frameZones;
  }

  /** Zones derived from the current state at the last render width (a
   * discarded render refreshes the cache). The handleMouse fallback consults
   * these so it never acts on a stale layout. */
  private currentZones(): HitZone[] {
    this.render(this.lastRenderWidth);
    return this.frameZones;
  }

  /**
   * Zone press: the search box selects it (the mouse counterpart of `/`); an
   * option row moves the cursor onto it — a press on the already-selected
   * option confirms it like Enter (see utils/mouse-hover for the uniform
   * click semantics). While the search box is the selected option no option
   * is active, so a row press only selects the row (dropping the box), never
   * confirms.
   */
  onHitZone(id: HitZoneId, _event: MouseEvent): void | boolean {
    if (id === DIALOG_SEARCH_ZONE) {
      this.list.focusSearch();
      this.invalidate();
      return;
    }
    const hit = typeof id === 'number' ? id : null;
    const view = this.list.view();
    if (hit === null || hit < 0 || hit >= view.items.length) return false;
    if (hit === view.selectedIndex && !view.searchFocused) {
      const chosen = this.list.selected();
      if (chosen !== undefined) this.opts.onSelect(chosen.value);
      return;
    }
    this.list.selectIndex(hit);
    this.invalidate();
  }

  /** Zone hover: the hovered option underlines; null clears. */
  setHoveredZone(id: HitZoneId | null): void | boolean {
    const changed = this.hover.update(id);
    if (changed) this.invalidate();
    return changed ? undefined : false;
  }

  /** Default key-hint segments; the focused search box swaps the cancel
   * segment for the Esc-exit, and the unfocused box advertises the `/`
   * focus key. */
  private defaultHintParts(view: SearchableListView<ChoiceOption>): string[] {
    const searchable = this.opts.searchable === true;
    const navParts = [t('common.hint.navigate')];
    if (view.page.pageCount > 1) navParts.push(t('common.hint.page'));
    navParts.push(t('common.hint.select'));
    if (searchable && view.searchFocused) {
      navParts.push(t('common.hint.searchExit'));
    } else {
      if (searchable) navParts.push(t('common.hint.searchFocus'));
      navParts.push(t('common.hint.cancel'));
    }
    return navParts;
  }

  override render(width: number): string[] {
    this.lastRenderWidth = width;
    const tooSmall = this.frame.tooSmall(width);
    if (tooSmall !== null) {
      this.frameZones = [];
      return tooSmall;
    }
    const searchable = this.opts.searchable === true;
    const view = this.list.view();
    const { lines, zones } = this.renderContent(width, view);
    // Header mirrors the model dialog (see model-selector.ts): border, title,
    // the hint (wrapped at segment boundaries, never hard-truncated), a
    // blank, then the always-visible search box. Key vocabulary is lowercase
    // to match every list dialog.
    const frameLines = this.frame.render(width, {
      title: this.opts.title,
      ...(this.opts.hint !== undefined
        ? { hintLines: this.opts.hint.split(/\r?\n/) }
        : { hintParts: this.defaultHintParts(view) }),
      ...(this.opts.notice !== undefined
        ? {
            notice: {
              text: this.opts.notice,
              tone: this.opts.noticeTone ?? ('success' as const),
              wrap: 'words' as const,
            },
          }
        : {}),
      ...(searchable ? { search: { query: view.query, focused: view.searchFocused } } : {}),
      content: lines,
      footer:
        view.page.pageCount > 1
          ? [
              '',
              currentTheme.fg('textMuted',
                ` ${t('common.pageIndicator', { page: view.page.page + 1, total: view.page.pageCount })}`,
              ),
            ]
          : [''],
    });
    this.frameZones = this.frame.zones(zones);
    return frameLines.map((line) => truncateToWidth(line, width));
  }

  /**
   * The content region (between the search box and the footer): one label
   * row per option in page order, plus its wrapped description rows. Returns
   * the lines plus the content-relative hit zones (row 0 = first content
   * line; one zone per option, spanning its label and description rows).
   */
  private renderContent(
    width: number,
    view: SearchableListView<ChoiceOption>,
  ): { lines: string[]; zones: HitZone[] } {
    const options = view.items;
    const lines: string[] = [];
    const zones: HitZone[] = [];
    if (options.length === 0) {
      lines.push(currentTheme.fg('textMuted', `   ${t('common.noMatches')}`));
      return { lines, zones };
    }
    for (let i = view.page.start; i < view.page.end; i++) {
      const opt = options[i]!;
      const rowStart = lines.length;
      const isSelected = i === view.selectedIndex;
      const isCurrent = opt.value === this.opts.currentValue;
      const pointer = isSelected ? SELECT_POINTER : ' ';
      const labelStyle = optionLabelStyle(opt, isSelected);
      let line = currentTheme.fg(isSelected ? 'primary' : 'textDim', `  ${pointer} `);
      line += labelStyle(opt.label);
      if (isCurrent) {
        line += ' ' + currentTheme.fg('success', t('common.currentMark'));
      }
      lines.push(underlineText(line, this.hover.isHovered(i)));
      if (opt.description !== undefined && opt.description.length > 0) {
        const descriptionWidth = Math.max(1, width - 4);
        const descriptionColor =
          isSelected && opt.descriptionTone !== undefined ? opt.descriptionTone : 'textMuted';
        for (const descLine of wrapWords(opt.description, descriptionWidth)) {
          lines.push(currentTheme.fg(descriptionColor, `    ${descLine}`));
        }
      }
      zones.push({ id: i, row: rowStart, col: 1, width, height: lines.length - rowStart });
    }
    return { lines, zones };
  }
}

function optionLabelStyle(
  option: ChoiceOption,
  selected: boolean,
): (text: string) => string {
  if (option.tone === 'danger') {
    return selected
      ? (text) => currentTheme.boldFg('error', text)
      : (text) => currentTheme.fg('error', text);
  }
  return selected
    ? (text) => currentTheme.boldFg('primary', text)
    : (text) => currentTheme.fg('text', text);
}
