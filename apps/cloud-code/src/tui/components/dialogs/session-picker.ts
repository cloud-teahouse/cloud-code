/**
 * SessionPicker — pi-tui version of the session selection dialog.
 */

import {
  Container,
  matchesKey,
  Key,
  truncateToWidth,
  visibleWidth,
  drawScrollbar,
  hitZoneAt,
  Scrollbar,
  scrollbarThumb,
  type ScrollbarMetrics,
  type Focusable,
  type HitZone,
  type HitZoneId,
  type MouseEvent,
} from '@cloud-code/pi-tui';
import { formatSessionLabel } from '#/migration/badge';
import { SELECT_POINTER } from '#/tui/constant/symbols';
import { t } from '#/tui/i18n';
import { currentTheme } from '#/tui/theme';
import { wrapHint } from '#/tui/utils/hint';
import { HoverState, underlineText } from '#/tui/utils/mouse-hover';
import { SearchableList } from '#/tui/utils/searchable-list';

import { DIALOG_SEARCH_ZONE, DialogFrame, inlineDialogMinSize } from './frame/dialog-frame';

export interface SessionRow {
  readonly id: string;
  readonly title: string | null;
  readonly last_prompt?: string | null;
  readonly work_dir: string;
  readonly updated_at: number;
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
}

const ELLIPSIS = '…';

/** Zone id of the cards region's hover-revealed scrollbar (rightmost column). */
const SCROLLBAR_ZONE = 'scrollbar';

/** Scrollbar glyphs: muted track, primary thumb — the same chrome pairing
 * the transcript bar uses (see theme/pi-tui-theme createScrollbarStyle). */
const SCROLLBAR_STYLE = {
  track: (glyph: string): string => currentTheme.fg('textMuted', glyph),
  thumb: (glyph: string): string => currentTheme.fg('primary', glyph),
};

function formatRelativeTime(ts: number): string {
  // SessionSummary timestamps come from filesystem stat `*timeMs`,
  // so they use the same millisecond unit as `Date.now()`.
  if (!Number.isFinite(ts) || ts <= 0) return '';
  const diffSec = Math.floor(Math.max(0, Date.now() - ts) / 1000);
  if (diffSec < 60) return t('dialogs.time.justNow');
  const minutes = Math.floor(diffSec / 60);
  if (minutes < 60) return t('dialogs.time.minutesAgo', { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('dialogs.time.hoursAgo', { count: hours });
  const days = Math.floor(hours / 24);
  return t('dialogs.time.daysAgo', { count: days });
}

function homeAlias(path: string): string {
  const home = process.env['HOME'] ?? '';
  if (home && path.startsWith(home)) return '~' + path.slice(home.length);
  return path;
}

// Truncates from the LEFT (keeps the tail), prefixing an ellipsis when clipped.
// Paths typically carry the relevant info near the end, so we drop the prefix.
function truncatePathLeft(path: string, maxWidth: number): string {
  if (maxWidth <= 0) return '';
  if (visibleWidth(path) <= maxWidth) return path;
  if (maxWidth === 1) return ELLIPSIS;
  // Walk graphemes from the end accumulating width, keep the longest tail
  // whose width + ellipsis fits.
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  const segments = [...segmenter.segment(path)].map((s) => s.segment);
  let used = 0;
  const budget = maxWidth - 1; // reserve 1 column for ellipsis
  let i = segments.length - 1;
  while (i >= 0) {
    const seg = segments[i];
    if (seg === undefined) break;
    const w = visibleWidth(seg);
    if (used + w > budget) break;
    used += w;
    i--;
  }
  return ELLIPSIS + segments.slice(i + 1).join('');
}

function singleLine(text: string): string {
  return text.replaceAll(/\s+/g, ' ').trim();
}

function sessionSearchText(session: SessionRow): string {
  return singleLine((session.title ?? session.id).trim() || session.id);
}

export class SessionPickerComponent extends Container implements Focusable {
  private sessions: SessionRow[];
  private currentSessionId: string;
  private onSelect: (session: SessionRow) => void;
  private onCancel: () => void;
  private onToggleScope?: (selectedSessionId: string) => void;
  private maxVisibleSessions: number;
  private pageSize: number;
  private visibleCount: number;
  private scope: 'cwd' | 'all';
  private loading: boolean;
  private list: SearchableList<SessionRow>;
  /** The dialog skeleton owning the chrome (divider/title/hint/search box)
   * and its row math. The session dialog's hint lines are not indented. */
  private readonly frame = new DialogFrame({ hintIndent: '', minSize: inlineDialogMinSize() });
  /** Frame-relative hit zones of the last render (search box + session
   * cards) — served from hitZones(). */
  private frameZones: HitZone[] = [];
  /** Width of the last render; direct handleMouse calls re-derive the zones
   * from the current state at this width (the TUI's zone dispatch uses the
   * render cache — a render always runs before dispatched input). */
  private lastRenderWidth = 80;
  /** Hovered session index (mouse motion); null when the pointer is elsewhere. */
  private readonly hover = new HoverState<HitZoneId>();
  /** Hover-revealed scrollbar on the cards region's rightmost column. */
  private readonly scrollbar = new Scrollbar();
  /** Render by-products the scrollbar's metrics derive from (a render always
   * runs before dispatched input): the window's first loaded index and the
   * cards region's height in rows. */
  private lastVisibleStart = 0;
  private lastCardsHeight = 0;

  focused = false;

  constructor(opts: {
    sessions: SessionRow[];
    loading: boolean;
    currentSessionId: string;
    scope?: 'cwd' | 'all';
    initialSelectedSessionId?: string;
    pageSize?: number;
    onSelect: (session: SessionRow) => void;
    onCancel: () => void;
    onCtrlC?: () => void;
    onCtrlD?: () => void;
    onToggleScope?: (selectedSessionId: string) => void;
    maxVisibleSessions?: number;
  }) {
    super();
    this.sessions = opts.sessions;
    this.loading = opts.loading;
    this.currentSessionId = opts.currentSessionId;
    this.scope = opts.scope ?? 'cwd';
    this.onSelect = opts.onSelect;
    this.onCancel = opts.onCancel;
    this.onToggleScope = opts.onToggleScope;
    this.maxVisibleSessions = opts.maxVisibleSessions ?? 4;
    this.pageSize = Math.max(1, opts.pageSize ?? 50);
    const initialIndex = this.resolveInitialSelectedIndex(opts.initialSelectedSessionId);
    this.list = new SearchableList({
      items: this.sessions,
      toSearchText: sessionSearchText,
      pageSize: this.pageSize,
      initialIndex,
      searchable: true,
    });
    const initialLoadedPages = Math.ceil((initialIndex + 1) / this.pageSize);
    this.visibleCount = Math.min(this.sessions.length, initialLoadedPages * this.pageSize);
    this.onCtrlC = opts.onCtrlC;
    this.onCtrlD = opts.onCtrlD;
  }

  private readonly onCtrlC?: () => void;
  private readonly onCtrlD?: () => void;

  private resolveInitialSelectedIndex(initialSelectedSessionId: string | undefined): number {
    if (initialSelectedSessionId === undefined) return 0;
    const index = this.sessions.findIndex((session) => session.id === initialSelectedSessionId);
    return Math.max(index, 0);
  }

  private filteredSessions(): readonly SessionRow[] {
    return this.list.view().items;
  }

  private loadedSessions(sessions: readonly SessionRow[] = this.filteredSessions()): SessionRow[] {
    return sessions.slice(0, Math.min(sessions.length, this.visibleCount));
  }

  private syncVisibleCount(previousQuery: string): void {
    const view = this.list.view();
    if (view.query !== previousQuery) {
      this.visibleCount = Math.min(view.items.length, this.pageSize);
      return;
    }

    const loadedCount = Math.min(view.items.length, this.visibleCount);
    if (view.selectedIndex >= loadedCount - 1 && loadedCount < view.items.length) {
      this.visibleCount = Math.min(view.items.length, this.visibleCount + this.pageSize);
    }
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.ctrl('c'))) {
      this.onCtrlC?.();
      return;
    }
    if (matchesKey(data, Key.ctrl('d'))) {
      this.onCtrlD?.();
      return;
    }
    if (matchesKey(data, Key.ctrl('a'))) {
      this.onToggleScope?.(this.list.selected()?.id ?? this.currentSessionId);
      return;
    }
    if (matchesKey(data, Key.escape)) {
      this.frame.handleEscape(this.list, this.onCancel, () => {
        this.visibleCount = Math.min(this.filteredSessions().length, this.pageSize);
      });
      return;
    }
    if (matchesKey(data, Key.enter)) {
      const session = this.list.selected();
      if (session) this.onSelect(session);
      return;
    }

    const previousQuery = this.list.view().query;
    if (this.list.handleKey(data)) {
      this.syncVisibleCount(previousQuery);
    }
  }

  /** Mouse: the wheel moves the cursor one row per tick, clamped by
   * SearchableList exactly like ↑/↓, with the same lazy-load growth. Press
   * and hover targeting is declared as hit zones (see renderCards); the TUI
   * dispatches zone presses to {@link onHitZone} and tracks the hovered zone
   * via {@link setHoveredZone}. This handler keeps the wheel behavior and
   * routes presses/motion arriving outside the zone dispatch (e.g. direct
   * component-relative events) through the same zones. A scrollbar drag
   * (button-held motion) lands here too — zone hover only tracks
   * button-free motion. */
  handleMouse(event: MouseEvent): void | boolean {
    // A scrollbar drag owns the pointer until the release and maps against
    // the session the press captured — the zones (a full render here) and
    // the metrics are NOT re-derived per motion event.
    if (event.type === 'motion' && this.scrollbar.dragging) {
      if (event.button === 0) {
        this.selectForWindowTop(this.scrollbar.drag(event.row - this.scrollbarTrack().top));
        return;
      }
      // Defensive: a button-free motion without a release ends the drag.
      this.scrollbar.release();
      this.invalidate();
      return;
    }
    if (event.type === 'release' && this.scrollbar.dragging) {
      this.scrollbar.release();
      this.invalidate();
      return;
    }
    // Re-derived from the current state: direct callers (unit tests) may fire
    // keys without an intervening render, so the render cache can be stale.
    const zones = this.currentZones();
    if (event.type === 'motion') {
      const zone = event.row < 0 ? null : hitZoneAt(zones, event.row, event.col, 'hover');
      return this.setHoveredZone(zone?.id ?? null);
    }
    if (event.type === 'release') return false;
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
    this.syncVisibleCount(this.list.view().query);
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
   * Zone press: the search box selects it (the mouse counterpart of `/`); a
   * session card moves the cursor onto it — a press on the already-selected
   * card opens it like Enter (see utils/mouse-hover for the uniform click
   * semantics). While the search box is the selected option no card is
   * active, so a card press only selects the card (dropping the box), never
   * opens. A press on the scrollbar starts a drag: anchored on the
   * thumb (no jump — the cursor/window mapping does not round-trip, so a
   * grab skips the target application entirely), jumping to the pointed
   * fraction on the bare track (button-held motion continues it in
   * handleMouse).
   */
  onHitZone(id: HitZoneId, event: MouseEvent): void | boolean {
    if (id === DIALOG_SEARCH_ZONE) {
      this.list.focusSearch();
      this.invalidate();
      return;
    }
    if (id === SCROLLBAR_ZONE) {
      const track = this.scrollbarTrack();
      const target = this.scrollbar.press(event.row - track.top, this.scrollbarMetrics(), track.height);
      if (this.scrollbar.dragSession?.grabbedThumb === true) {
        // No jump — but the grab still reveals the bar.
        this.invalidate();
        return;
      }
      this.selectForWindowTop(target);
      return;
    }
    const hit = typeof id === 'number' ? id : null;
    const view = this.list.view();
    if (hit === null || hit < 0 || hit >= view.items.length) return false;
    if (hit === view.selectedIndex && !view.searchFocused) {
      const session = this.list.selected();
      if (session) this.onSelect(session);
      return;
    }
    this.list.selectIndex(hit);
    this.syncVisibleCount(view.query);
    this.invalidate();
  }

  /** Zone hover: the hovered card's text rows underline; the scrollbar
   * reveals while its column is hovered; null clears. */
  setHoveredZone(id: HitZoneId | null): void | boolean {
    const barChanged = this.scrollbar.hover(id === SCROLLBAR_ZONE);
    const changed = this.hover.update(id === SCROLLBAR_ZONE ? null : id);
    if (changed || barChanged) this.invalidate();
    return changed || barChanged ? undefined : false;
  }

  /** Component-frame geometry of the scrollbar's track: the cards region
   * (frame content rows) at the dialog's rightmost column. */
  private scrollbarTrack(): { top: number; height: number } {
    return { top: this.frame.contentRow, height: this.lastCardsHeight };
  }

  /** Window-based scroll metrics: for a cursor list the visible window is
   * the viewport and the loaded sessions the content. */
  private scrollbarMetrics(): ScrollbarMetrics {
    return {
      scrollTop: this.lastVisibleStart,
      viewport: this.maxVisibleSessions,
      content: this.loadedSessions().length,
    };
  }

  /** Move the cursor so the window top lands on the scrollbar's target:
   * the window centers on the selection (see renderLines), so selecting the
   * item half a window past the target top puts the window there. */
  private selectForWindowTop(target: number): void {
    const loaded = this.loadedSessions().length;
    if (loaded === 0) return;
    this.list.selectIndex(Math.min(target + Math.floor(this.maxVisibleSessions / 2), loaded - 1));
    this.syncVisibleCount(this.list.view().query);
    this.invalidate();
  }

  /** Key-hint segments for the current view (scope toggle, search state). */
  private hintParts(view: { readonly query: string; readonly searchFocused: boolean }): string[] {
    const scopeHint =
      this.onToggleScope === undefined
        ? undefined
        : this.scope === 'all'
          ? t('dialogs.sessions.hint.scopeCwd')
          : t('dialogs.sessions.hint.scopeAll');
    return [
      ...(view.query.length > 0 ? [t('dialogs.hint.backspaceClear')] : []),
      t('common.hint.navigate'),
      scopeHint,
      t('common.hint.select'),
      // The focused search box swaps the cancel segment for the Esc-exit; the
      // unfocused box advertises the `/` focus key.
      ...(view.searchFocused
        ? [t('common.hint.searchExit')]
        : [t('common.hint.searchFocus'), t('common.hint.cancel')]),
    ].filter((item): item is string => item !== undefined);
  }

  override render(width: number): string[] {
    this.lastRenderWidth = width;
    const tooSmall = this.frame.tooSmall(width);
    if (tooSmall !== null) {
      this.frameZones = [];
      return tooSmall;
    }
    return this.renderLines(width).map((line) => truncateToWidth(line, width, ELLIPSIS));
  }

  // Builds the raw lines; `render()` applies a final width clamp so no line
  // can ever exceed the terminal width. The per-line budgets below keep the
  // layout tidy at normal widths, but on a very narrow terminal those budgets
  // floor at a minimum and the trailing time/badge are appended in full, so
  // the clamp in `render()` is what guarantees the renderer's invariant and
  // prevents the "Rendered line exceeds terminal width" crash (issue #240).
  private renderLines(width: number): string[] {
    const lines: string[] = [currentTheme.fg('border', '─'.repeat(width))];
    const title =
      this.scope === 'all' ? t('dialogs.sessions.title.all') : t('dialogs.sessions.title');
    const scopeHint =
      this.onToggleScope === undefined
        ? undefined
        : this.scope === 'all'
          ? t('dialogs.sessions.hint.scopeCwd')
          : t('dialogs.sessions.hint.scopeAll');

    if (this.loading) {
      this.frameZones = [];
      lines.push(currentTheme.boldFg('border', truncateToWidth(title, width, ELLIPSIS)));
      lines.push(
        currentTheme.fg(
          'textMuted',
          truncateToWidth(t('dialogs.sessions.loading'), width, ELLIPSIS),
        ),
      );
      lines.push(currentTheme.fg('border', '─'.repeat(width)));
      return lines;
    }

    if (this.sessions.length === 0) {
      this.frameZones = [];
      const hintParts = [scopeHint, t('common.hint.cancel')].filter(
        (item): item is string => item !== undefined,
      );
      lines.push(currentTheme.boldFg('border', truncateToWidth(title, width, ELLIPSIS)));
      for (const hintLine of wrapHint(hintParts, width)) {
        lines.push(currentTheme.fg('textMuted', hintLine));
      }
      lines.push('');
      lines.push(
        currentTheme.fg(
          'textMuted',
          truncateToWidth(t('dialogs.sessions.empty'), width, ELLIPSIS),
        ),
      );
      lines.push(currentTheme.fg('border', '─'.repeat(width)));
      return lines;
    }

    const view = this.list.view();
    const loadedSessions = this.loadedSessions(view.items);
    const selectedIndex = view.selectedIndex;
    const visibleStart = Math.max(
      0,
      Math.min(
        selectedIndex - Math.floor(this.maxVisibleSessions / 2),
        Math.max(0, loadedSessions.length - this.maxVisibleSessions),
      ),
    );
    const visibleSessions = loadedSessions.slice(
      visibleStart,
      visibleStart + this.maxVisibleSessions,
    );

    const cards =
      loadedSessions.length === 0
        ? {
            lines: [
              currentTheme.fg('textMuted', truncateToWidth(t('common.noMatches'), width, ELLIPSIS)),
            ],
            zones: [] as HitZone[],
          }
        : this.renderCards(width, visibleSessions, visibleStart, selectedIndex);

    const filteredCount = view.items.length;
    const footer: string[] = [];
    if (
      loadedSessions.length > 0 &&
      (loadedSessions.length > visibleSessions.length || view.query.length > 0)
    ) {
      const totalSuffix =
        view.query.length > 0
          ? t('dialogs.sessions.footer.matches', {
              loaded: loadedSessions.length,
              total: filteredCount,
            })
          : loadedSessions.length === this.sessions.length
            ? t('dialogs.sessions.footer.sessions', { count: loadedSessions.length })
            : t('dialogs.sessions.footer.loadedSessions', {
                loaded: loadedSessions.length,
                total: this.sessions.length,
              });
      const footerText = t('dialogs.sessions.footer.showing', {
        from: visibleStart + 1,
        to: visibleStart + visibleSessions.length,
        suffix: totalSuffix,
      });
      footer.push('', currentTheme.fg('textMuted', truncateToWidth(footerText, width, ELLIPSIS)));
    }

    const frameLines = this.frame.render(width, {
      title,
      hintParts: this.hintParts(view),
      search: { query: view.query, focused: view.searchFocused },
      content: cards.lines,
      footer,
    });
    this.frameZones = this.frame.zones(cards.zones);
    // The scrollbar's zone comes first so its column wins over the cards;
    // the bar itself overlays the cards region's rightmost column while
    // engaged (hover-revealed, never a reserved column).
    this.lastVisibleStart = visibleStart;
    this.lastCardsHeight = cards.lines.length;
    const thumb = scrollbarThumb(this.scrollbarMetrics(), cards.lines.length);
    if (thumb !== null) {
      this.frameZones.unshift({
        id: SCROLLBAR_ZONE,
        row: this.frame.contentRow,
        col: width,
        width: 1,
        height: cards.lines.length,
      });
      if (this.scrollbar.engaged) {
        const top = this.frame.contentRow;
        const barred = drawScrollbar(frameLines.slice(top, top + cards.lines.length), width, thumb, SCROLLBAR_STYLE);
        for (let i = 0; i < barred.length; i++) frameLines[top + i] = barred[i]!;
      }
    }
    return frameLines;
  }

  /**
   * The content region (between the search box and the counts footer): the
   * visible window of session cards, one blank separator row after every
   * card but the last. Returns the lines plus the content-relative hit zones
   * (row 0 = first content line): one zone per card, spanning its rendered
   * rows — the id row, the split dir row, and the optional prompt row
   * included; the separators are chrome and get no zone.
   */
  private renderCards(
    width: number,
    visibleSessions: readonly SessionRow[],
    visibleStart: number,
    selectedIndex: number,
  ): { lines: string[]; zones: HitZone[] } {
    const lines: string[] = [];
    const zones: HitZone[] = [];
    for (const [vi, session] of visibleSessions.entries()) {
      const index = visibleStart + vi;
      const isSelected = index === selectedIndex;
      const isCurrent = session.id === this.currentSessionId;
      const card = this.renderSessionCard(width, session, isSelected, isCurrent);
      const cardStart = lines.length;
      lines.push(...card);
      // Hover underline on every text row of the hovered card (mouse motion)
      // — the whole card is clickable, so the whole card's text underlines.
      if (this.hover.isHovered(index)) {
        for (let row = cardStart; row < cardStart + card.length; row++) {
          lines[row] = underlineText(lines[row]!, true);
        }
      }
      zones.push({ id: index, row: cardStart, col: 1, width, height: card.length });
      if (vi < visibleSessions.length - 1) lines.push('');
    }
    return { lines, zones };
  }

  private renderSessionCard(
    width: number,
    session: SessionRow,
    isSelected: boolean,
    isCurrent: boolean,
  ): string[] {
    const pointer = isSelected ? SELECT_POINTER : ' ';
    const indent = '  ';
    const indentWidth = visibleWidth(indent);
    const titleColor: 'primary' | 'text' = isSelected ? 'primary' : 'text';
    const titleStyle = (text: string) =>
      isSelected ? currentTheme.boldFg(titleColor, text) : currentTheme.fg(titleColor, text);

    const time = formatRelativeTime(session.updated_at);
    const badge = isCurrent ? t('common.currentMark') : '';
    const rawTitle = (session.title ?? session.id).trim() || session.id;
    const titleSource = formatSessionLabel({ title: rawTitle, metadata: session.metadata });

    // Inline trailing parts after the title: "<title>  <time>  ← current".
    const trailingParts = [time, badge].filter((p) => p.length > 0);
    const trailingText = trailingParts.length > 0 ? '  ' + trailingParts.join('  ') : '';
    const trailingWidth = visibleWidth(trailingText);
    const headerPrefixWidth = visibleWidth(pointer) + 1; // pointer + space
    const titleBudget = Math.max(8, width - headerPrefixWidth - trailingWidth);
    const shownTitle = truncateToWidth(singleLine(titleSource), titleBudget, ELLIPSIS);

    let header = currentTheme.fg(isSelected ? 'primary' : 'textDim', pointer + ' ');
    header += titleStyle(shownTitle);
    if (time.length > 0) header += '  ' + currentTheme.fg('textDim', time);
    if (badge.length > 0) header += '  ' + currentTheme.fg('success', badge);
    const card: string[] = [header];

    // Session id is rendered in full at normal widths (the final clamp in
    // `render()` truncates it only when the terminal is narrower than the id).
    // The directory wraps to its own line if it would push past the edge.
    const fullId = session.id;
    const idWidth = visibleWidth(fullId);
    const metaGap = '   ';
    const metaGapWidth = visibleWidth(metaGap);
    const idLineWidth = indentWidth + idWidth;
    const aliasedDir = homeAlias(session.work_dir);
    const dirWidth = visibleWidth(aliasedDir);

    if (idLineWidth + metaGapWidth + dirWidth <= width) {
      card.push(
        indent +
          currentTheme.fg('textMuted', fullId) +
          currentTheme.fg('textDim', metaGap) +
          currentTheme.fg('textMuted', aliasedDir),
      );
    } else {
      // Not enough room for both on one line — keep the id intact and put the
      // directory on the next line (left-truncated only if it still doesn't fit).
      card.push(
        indent +
          currentTheme.fg(
            'textMuted',
            truncateToWidth(fullId, Math.max(idWidth, width - indentWidth), ELLIPSIS),
          ),
      );
      const dirBudget = Math.max(8, width - indentWidth);
      const dir = truncatePathLeft(aliasedDir, dirBudget);
      card.push(indent + currentTheme.fg('textMuted', dir));
    }

    const rawPrompt = session.last_prompt?.trim();
    if (rawPrompt && rawPrompt.length > 0) {
      const promptMarker = '› ';
      const promptMarkerWidth = visibleWidth(promptMarker);
      const promptBudget = Math.max(8, width - indentWidth - promptMarkerWidth);
      const promptText = truncateToWidth(singleLine(rawPrompt), promptBudget, ELLIPSIS);
      const promptLine = indent + currentTheme.fg('textDim', promptMarker + promptText);
      card.push(promptLine);
    }

    return card;
  }
}
