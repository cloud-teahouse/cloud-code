/**
 * TeamsBrowserApp — full-screen takeover for the `/teams` command
 * (read-only team/mailbox views).
 *
 * Two-pane layout, same idiom as the workflows browser: a team list on the
 * left (roster + shared-task counts) and a scrollable detail pane on the
 * right — members with live task liveness (joined by the controller from
 * `AgentTaskInfo.teammate` task data), the shared task list with
 * status/owner, and recent mailbox activity for the team. Data flows in
 * via `setProps` from the event-fed `TeamTracker`; the view is read-only,
 * so the only actions are navigation and close.
 */

import {
  Container,
  drawScrollbar,
  Key,
  matchesKey,
  type MouseEvent,
  Scrollbar,
  scrollbarThumb,
  type ScrollbarMetrics,
  type Terminal,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  hitZoneAt,
  type Focusable,
  type HitZone,
  type HitZoneId,
} from '@cloud-code/pi-tui';
import type { BackgroundTaskInfo, MailboxActivityMessage, TeamWire } from '@cloud-code/sdk';

import { SELECT_POINTER } from '#/tui/constant/symbols';
import { fitExactly, renderTable } from '#/tui/components/primitives';
import { getLocalePreference, t, type MessageKey } from '#/tui/i18n';
import { currentTheme } from '#/tui/theme';
import { createScrollbarStyle } from '#/tui/theme/pi-tui-theme';
import { wrapHint } from '#/tui/utils/hint';
import { HoverState, underlineText } from '#/tui/utils/mouse-hover';
import { printableChar } from '#/tui/utils/printable-key';
import { followScroll, scrolledToSelection } from '#/tui/utils/scroll-window';

import { DialogFrame } from './frame/dialog-frame';

const ELLIPSIS = '…';

/** Zone id of the detail pane's hover-revealed scrollbar (its right border). */
const DETAIL_SCROLLBAR_ZONE = 'scrollbar:detail';

/** Live liveness of a team member, joined from background task info. */
export type MemberLiveness = BackgroundTaskInfo['status'] | 'idle';

export interface TeamsBrowserProps {
  readonly teams: readonly TeamWire[];
  readonly activity: readonly MailboxActivityMessage[];
  /** Live task status per member agent id; absent = no live task (`idle`). */
  readonly memberLiveness: ReadonlyMap<string, BackgroundTaskInfo['status']>;
  readonly selectedTeamName: string | undefined;
  readonly onSelect: (teamName: string) => void;
  readonly onCancel: () => void;
}

const TASK_STATUS_LABEL: Record<TeamWire['tasks'][number]['status'], MessageKey> = {
  pending: 'teams.task.status.pending',
  in_progress: 'teams.task.status.in_progress',
  completed: 'teams.task.status.completed',
};

const LIVENESS_LABEL: Record<MemberLiveness, MessageKey> = {
  running: 'teams.member.status.running',
  completed: 'teams.member.status.completed',
  failed: 'teams.member.status.failed',
  timed_out: 'teams.member.status.timed_out',
  killed: 'teams.member.status.killed',
  lost: 'teams.member.status.lost',
  idle: 'teams.member.status.idle',
};

const ACTIVITY_KIND_LABEL: Record<MailboxActivityMessage['kind'], MessageKey> = {
  message: 'teams.activity.kind.message',
  task_assignment: 'teams.activity.kind.task_assignment',
  shutdown_request: 'teams.activity.kind.shutdown_request',
  shutdown_approved: 'teams.activity.kind.shutdown_approved',
  shutdown_rejected: 'teams.activity.kind.shutdown_rejected',
  permission_request: 'teams.activity.kind.permission_request',
  permission_response: 'teams.activity.kind.permission_response',
};

/** Minimum dimensions before we just print a "too small" message. */
const MIN_WIDTH = 48;
const MIN_HEIGHT = 10;

/** Hard caps so a tiny / huge terminal still gets a sensible left-column width. */
const LIST_COL_MIN = 24;
const LIST_COL_MAX = 40;
const LIST_COL_RATIO = 0.32;

/** Most recent mailbox entries shown in the detail pane. */
const ACTIVITY_DISPLAY_COUNT = 8;

function livenessColor(status: MemberLiveness): 'success' | 'textMuted' | 'error' | 'warning' {
  switch (status) {
    case 'running':
      return 'success';
    case 'timed_out':
    case 'lost':
      return 'warning';
    case 'failed':
    case 'killed':
      return 'error';
    case 'completed':
      return 'success';
    case 'idle':
      return 'textMuted';
  }
}

const LIVENESS_ICON: Record<MemberLiveness, string> = {
  running: '●',
  completed: '✓',
  failed: '✗',
  timed_out: '◐',
  killed: '✗',
  lost: '◌',
  idle: '○',
};

function singleLine(text: string): string {
  return text.replaceAll(/\s+/g, ' ').trim();
}

/** `HH:MM` wall-clock tag for one mailbox activity entry. */
function activityTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '--:--';
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

export class TeamsBrowserApp extends Container implements Focusable {
  focused = false;

  private props: TeamsBrowserProps;
  private readonly terminal: Terminal;
  private selectedIndex = 0;
  private listScroll = 0;
  /** Detail pane scroll position; pinned to the tail by default. */
  private detailScroll = 0;
  private detailFollow = true;
  /** Hover-revealed scrollbar on the detail frame's right border. */
  private readonly detailScrollbar = new Scrollbar();
  /** Hovered team row index (mouse motion); null when the pointer is elsewhere. */
  private readonly hover = new HoverState();
  /** The shared frame, used here only for its too-small fallback — the
   * takeover's own ┌─┐ pane chrome renders byte-identically without it. */
  private readonly frame: DialogFrame;
  /** Component-relative hit zones of the last render (team rows + the two
   * wheel-routing panes) — served from hitZones(). */
  private frameZones: HitZone[] = [];
  /** Team-row zones recorded by renderListFrame during the current render. */
  private rowZones: HitZone[] = [];
  /** Width of the last render; direct handleMouse calls re-derive the zones
   * from the current state at this width (the TUI's zone dispatch uses the
   * render cache — a render always runs before dispatched input). */
  private lastRenderWidth = 80;
  /** Footer rows of the last render (the key hint wraps at narrow widths);
   * paneInnerRows consults this cache outside render. */
  private lastFooterRows = 1;
  /** Inputs the declared zones depend on, captured by each render. A mouse
   * event whose inputs all match skips the zone re-derivation render:
   * render is pure, so unchanged inputs mean the cached zones are exact. */
  private zoneInputs:
    | {
        props: TeamsBrowserProps;
        selectedIndex: number;
        listScroll: number;
        screenRows: number;
        locale: string;
      }
    | undefined;

  constructor(props: TeamsBrowserProps, terminal: Terminal) {
    super();
    this.props = props;
    this.terminal = terminal;
    this.frame = new DialogFrame({
      minSize: {
        width: MIN_WIDTH,
        height: MIN_HEIGHT,
        message: t('teams.tooSmall', { width: MIN_WIDTH, height: MIN_HEIGHT }),
      },
    });
    this.syncSelectionFromProps();
  }

  setProps(next: TeamsBrowserProps): void {
    this.props = next;
    this.syncSelectionFromProps();
    // The content behind the detail pane may have changed with the props —
    // re-settle the stored scroll/follow the way the render pass used to
    // (render is pure now, so this is where content-driven clamping lives).
    this.settleDetailPane();
    this.invalidate();
  }

  private syncSelectionFromProps(): void {
    if (this.props.teams.length === 0) {
      this.selectedIndex = 0;
      this.listScroll = 0;
      return;
    }
    if (this.props.selectedTeamName !== undefined) {
      const idx = this.props.teams.findIndex((team) => team.name === this.props.selectedTeamName);
      if (idx !== -1) {
        this.selectedIndex = idx;
        this.listScroll = scrolledToSelection(
          this.listScroll,
          this.selectedIndex,
          this.paneInnerRows(),
          this.props.teams.length,
        );
        return;
      }
    }
    if (this.selectedIndex >= this.props.teams.length) {
      this.selectedIndex = this.props.teams.length - 1;
    }
    this.listScroll = scrolledToSelection(
      this.listScroll,
      this.selectedIndex,
      this.paneInnerRows(),
      this.props.teams.length,
    );
  }

  private emitSelect(): void {
    const team = this.props.teams[this.selectedIndex];
    if (team !== undefined) this.props.onSelect(team.name);
    // A different team's details replace the pane — re-pin to its tail.
    this.detailScroll = 0;
    this.detailFollow = true;
  }

  // ── input ────────────────────────────────────────────────────────────

  handleInput(data: string): void {
    const k = printableChar(data);

    if (matchesKey(data, Key.escape) || k === 'q' || k === 'Q') {
      this.props.onCancel();
      return;
    }
    if (matchesKey(data, Key.up) || k === 'k') {
      this.moveSelection(-1);
      return;
    }
    if (matchesKey(data, Key.down) || k === 'j') {
      this.moveSelection(1);
      return;
    }
    if (matchesKey(data, Key.pageUp)) {
      this.scrollDetail(-this.detailPageSize());
      return;
    }
    if (matchesKey(data, Key.pageDown)) {
      this.scrollDetail(this.detailPageSize());
      return;
    }
    // Home/End jump the selection to the first/last team (a large clamped
    // moveSelection step — it guards the empty list and no-ops in place).
    if (matchesKey(data, Key.home)) {
      this.moveSelection(-this.props.teams.length);
      return;
    }
    if (matchesKey(data, Key.end)) {
      this.moveSelection(this.props.teams.length);
      return;
    }
  }

  /**
   * Mouse: over the left list pane the wheel moves the team selection, over
   * the detail pane it scrolls the content. Left-press on a list row selects
   * that team — the detail pane is the "detail" target of a click, since the
   * browser is a read-only master-detail view. Motion underlines the hovered
   * team row. Press/hover targeting is declared as hit zones (see render);
   * the TUI dispatches zone presses to {@link onHitZone} and tracks the
   * hovered zone via {@link setHoveredZone}. This handler keeps the
   * zone-routed wheel and routes presses/motion arriving outside the zone
   * dispatch (e.g. direct component-relative events) through the same zones.
   */
  handleMouse(event: MouseEvent): void | boolean {
    // A detail-scrollbar drag owns the pointer until the release and maps
    // against the session the press captured — the zones and the content
    // metrics (a full detail rebuild) are NOT re-derived per motion event.
    if (event.type === 'motion' && this.detailScrollbar.dragging) {
      if (event.button === 0) {
        this.scrollDetailTo(this.detailScrollbar.drag(event.row - this.detailTrack().top));
        return;
      }
      // Defensive: a button-free motion without a release ends the drag.
      this.detailScrollbar.release();
      this.settleDetailPane();
      this.invalidate();
      return;
    }
    if (event.type === 'release' && this.detailScrollbar.dragging) {
      this.detailScrollbar.release();
      // The drag mapped against the press-time snapshot; re-settle against
      // the live content now that it ended.
      this.settleDetailPane();
      this.invalidate();
      return;
    }
    // Re-derived from the current state: direct callers (unit tests) may fire
    // events without an intervening render, so the render cache can be stale.
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
    const delta = event.button === 64 ? -3 : event.button === 65 ? 3 : 0;
    if (delta === 0) return false;
    // Takeover wheel events carry a 1-based screen row (the TUI only
    // translates press/motion into the component frame) — subtract one for
    // the zone lookup.
    const zone = hitZoneAt(zones, event.row - 1, event.col, 'action');
    if (zone === null) return false;
    if (zone.id === 'pane:detail' || zone.id === DETAIL_SCROLLBAR_ZONE) {
      this.scrollDetail(delta);
      return;
    }
    this.moveSelection(delta);
  }

  /** The declared zones of the last render. */
  hitZones(): Iterable<HitZone> {
    return this.frameZones;
  }

  /** Zones of the last render, re-derived only when a zone input changed
   * since the capture (the handleMouse fallback consults these so it never
   * acts on a stale layout; a discarded render refreshes the capture). */
  private currentZones(): HitZone[] {
    const last = this.zoneInputs;
    if (
      last === undefined ||
      last.props !== this.props ||
      last.selectedIndex !== this.selectedIndex ||
      last.listScroll !== this.listScroll ||
      last.screenRows !== Math.max(1, this.terminal.rows) ||
      last.locale !== getLocalePreference()
    ) {
      this.render(this.lastRenderWidth);
    }
    return this.frameZones;
  }

  /**
   * Zone press: a team row takes the selection (the detail pane follows).
   * The pane zones exist for wheel routing — a press on them, or on the
   * already-selected row, is a no-op. A press on the detail scrollbar starts
   * a drag: anchored on the thumb (no jump), jumping to the pointed fraction
   * on the bare track (button-held motion continues it in handleMouse).
   */
  onHitZone(id: HitZoneId, event: MouseEvent): void | boolean {
    if (id === DETAIL_SCROLLBAR_ZONE) {
      const track = this.detailTrack();
      this.scrollDetailTo(
        this.detailScrollbar.press(event.row - track.top, this.detailScrollbarMetrics(), track.height),
      );
      return;
    }
    if (typeof id !== 'number' || id < 0 || id >= this.props.teams.length) return false;
    if (id === this.selectedIndex) return false;
    this.selectTeamIndex(id);
    this.invalidate();
  }

  /** Zone hover: the hovered team row underlines; the detail scrollbar
   * reveals while its column is hovered; null clears. */
  setHoveredZone(id: HitZoneId | null): void | boolean {
    const barChanged = this.detailScrollbar.hover(id === DETAIL_SCROLLBAR_ZONE);
    const changed = this.hover.update(typeof id === 'number' ? id : null);
    if (changed || barChanged) this.invalidate();
    return changed || barChanged ? undefined : false;
  }

  /** Component-frame geometry of the detail scrollbar's track: the inner
   * rows of the detail frame, whose right border is the screen's last
   * column (header row 0, frame top border row 1). */
  private detailTrack(): { top: number; height: number } {
    return { top: 2, height: this.paneInnerRows() };
  }

  /** Detail-pane scroll metrics for the scrollbar (the same settle the
   * render derives — stored state is the input handlers'). The render passes
   * the content height it already built; input handlers re-derive it. */
  private detailScrollbarMetrics(content = this.detailContentRows()): ScrollbarMetrics {
    const viewport = this.paneInnerRows();
    const settled = followScroll(
      { scroll: this.detailScroll, follow: this.detailFollow },
      content,
      viewport,
    );
    return { scrollTop: settled.scroll, viewport, content };
  }

  /** Absolute counterpart of scrollDetail: the scrollbar's press/drag target
   * lands here; parking at the bottom re-engages the tail follow. During a
   * drag the settle reuses the session's geometry snapshot instead of
   * re-deriving the content height per motion event. */
  private scrollDetailTo(target: number): void {
    const session = this.detailScrollbar.dragSession;
    const settled = followScroll(
      { scroll: target, follow: false },
      session?.content ?? this.detailContentRows(),
      session?.viewport ?? this.paneInnerRows(),
    );
    this.detailScroll = settled.scroll;
    this.detailFollow = settled.follow;
    this.invalidate();
  }

  private moveSelection(delta: number): void {
    if (this.props.teams.length === 0) return;
    const next = Math.max(0, Math.min(this.props.teams.length - 1, this.selectedIndex + delta));
    if (next === this.selectedIndex) return;
    this.selectTeamIndex(next);
    this.invalidate();
  }

  /**
   * Selection change with the scroll normalization the render pass used to
   * own: settle the stored scroll against the current geometry, change the
   * selection, settle again (render is pure now — it derives the same window
   * for display without storing it).
   */
  private selectTeamIndex(next: number): void {
    const visible = this.paneInnerRows();
    this.listScroll = scrolledToSelection(
      this.listScroll,
      this.selectedIndex,
      visible,
      this.props.teams.length,
    );
    this.selectedIndex = next;
    this.listScroll = scrolledToSelection(
      this.listScroll,
      this.selectedIndex,
      visible,
      this.props.teams.length,
    );
    this.emitSelect();
  }

  /** Inner content rows of the body frames (body = rows-2, borders eat 2). */
  private paneInnerRows(): number {
    // header(1) + footer(lastFooterRows — the key hint wraps when narrow)
    // + the pane frame's two borders.
    return Math.max(0, Math.max(1, this.terminal.rows) - 3 - this.lastFooterRows);
  }

  /** List column width for a render width (the render's own split). */
  private listWidthFor(width: number): number {
    return Math.max(LIST_COL_MIN, Math.min(LIST_COL_MAX, Math.floor(width * LIST_COL_RATIO)));
  }

  /** Content height of the detail pane at the last render width. */
  private detailContentRows(): number {
    const team = this.props.teams.find(
      (candidate) => candidate.name === this.props.selectedTeamName,
    );
    if (team === undefined) return 0;
    const detailWidth = this.lastRenderWidth - this.listWidthFor(this.lastRenderWidth);
    return this.buildDetailContent(team, detailWidth - 2).length;
  }

  /** Re-settle the detail pane against the current content and geometry. */
  private settleDetailPane(): void {
    const settled = followScroll(
      { scroll: this.detailScroll, follow: this.detailFollow },
      this.detailContentRows(),
      this.paneInnerRows(),
    );
    this.detailScroll = settled.scroll;
    this.detailFollow = settled.follow;
  }

  private detailPageSize(): number {
    return Math.max(1, this.terminal.rows - 4);
  }

  private scrollDetail(delta: number): void {
    // Settle the stored position against the current content and geometry
    // (render is pure now), then apply the tick — parking at the bottom
    // re-engages the tail follow.
    const contentRows = this.detailContentRows();
    const visible = this.paneInnerRows();
    const settled = followScroll(
      {
        scroll: followScroll(
          { scroll: this.detailScroll, follow: this.detailFollow },
          contentRows,
          visible,
        ).scroll + delta,
        follow: false,
      },
      contentRows,
      visible,
    );
    this.detailScroll = settled.scroll;
    this.detailFollow = settled.follow;
    this.invalidate();
  }

  // ── render ───────────────────────────────────────────────────────────

  /**
   * Render the entire screen as `terminal.rows` lines of `width` cols.
   * Layout: header(1) + body(rows-2) + footer(1). Pure: the scroll windows
   * are derived from state (see scrolledToSelection / followScroll), never
   * stored back. Records the render's hit zones as a by-product: one zone
   * per visible team row plus the two full-height panes the wheel handler
   * routes on (row zones first so they win the overlap).
   */
  override render(width: number): string[] {
    this.lastRenderWidth = width;
    const rows = Math.max(1, this.terminal.rows);
    this.zoneInputs = {
      props: this.props,
      selectedIndex: this.selectedIndex,
      listScroll: this.listScroll,
      screenRows: rows,
      locale: getLocalePreference(),
    };
    const tooSmall = this.frame.tooSmall(width, rows);
    if (tooSmall !== null) {
      this.frameZones = [];
      this.rowZones = [];
      return tooSmall;
    }

    const header = this.renderHeader(width);
    const footerLines = this.renderFooter(width);
    this.lastFooterRows = footerLines.length;
    const bodyHeight = rows - 1 - footerLines.length;

    const listWidth = this.listWidthFor(width);
    const detailWidth = width - listWidth;

    this.rowZones = [];
    const listFrame = this.renderListFrame(listWidth, bodyHeight);
    // One detail-content build per render: the scrollbar metrics reuse the
    // height from this pass (buildDetailContent is pure given the same
    // props/width, so a second build would be identical).
    const detail = this.renderDetailFrame(detailWidth, bodyHeight);
    const detailFrame = detail.lines;

    const lines: string[] = [header];
    for (let i = 0; i < bodyHeight; i++) {
      lines.push(
        (listFrame[i] ?? ' '.repeat(listWidth)) + (detailFrame[i] ?? ' '.repeat(detailWidth)),
      );
    }
    lines.push(...footerLines);

    // The detail scrollbar's zone comes first so it wins its column over
    // the pane zone; the bar itself is drawn over the frame's right border
    // while engaged (hover-revealed, never a reserved column).
    const track = this.detailTrack();
    const scrollMetrics = this.detailScrollbarMetrics(detail.contentRows);
    const scrollable = scrollbarThumb(scrollMetrics, track.height) !== null;
    const thumb = this.detailScrollbar.engaged
      ? scrollbarThumb(scrollMetrics, track.height)
      : null;
    if (thumb !== null) {
      const barred = drawScrollbar(lines.slice(track.top, track.top + track.height), width, thumb, createScrollbarStyle());
      for (let i = 0; i < barred.length; i++) lines[track.top + i] = barred[i]!;
    }
    this.frameZones = [
      ...(scrollable
        ? [{ id: DETAIL_SCROLLBAR_ZONE, row: track.top, col: width, width: 1, height: track.height }]
        : []),
      ...this.rowZones,
      // Full-height panes for wheel routing (presses on them are no-ops).
      { id: 'pane:list', row: 0, col: 1, width: listWidth, height: rows, semantics: { hover: false } },
      { id: 'pane:detail', row: 0, col: listWidth + 1, width: detailWidth, height: rows, semantics: { hover: false } },
    ];
    return lines;
  }

  // ── header / footer ──────────────────────────────────────────────────

  private renderHeader(width: number): string {
    const title = currentTheme.boldFg('primary', t('teams.title'));
    let members = 0;
    let tasks = 0;
    let activeTasks = 0;
    for (const team of this.props.teams) {
      members += team.members.length;
      tasks += team.tasks.length;
      activeTasks += team.tasks.filter((task) => task.status === 'in_progress').length;
    }
    const segments: string[] = [];
    if (this.props.teams.length > 0) {
      segments.push(
        currentTheme.fg('textMuted', t('teams.count.teams', { count: this.props.teams.length })),
      );
      segments.push(currentTheme.fg('textDim', t('teams.count.members', { count: members })));
      segments.push(currentTheme.fg('textDim', t('teams.count.tasks', { count: tasks })));
      if (activeTasks > 0) {
        segments.push(
          currentTheme.fg('success', t('teams.count.activeTasks', { count: activeTasks })),
        );
      }
    }
    return fitExactly(`${title} ${segments.join('')}`, width);
  }

  private renderFooter(width: number): string[] {
    const key = (text: string): string => currentTheme.boldFg('primary', text);
    const dim = (text: string): string => currentTheme.fg('textMuted', text);
    const parts = [
      ` ${key('↑↓')} ${dim(t('teams.hint.select'))}`,
      `${key('PgUp/PgDn')} ${dim(t('teams.hint.page'))}`,
      `${key('Q/Esc')} ${dim(t('teams.hint.close'))} `,
    ];
    // Wrap at segment boundaries: narrow widths keep every key instead of
    // clipping the tail segments off the single line.
    return wrapHint(parts, width, '  ').map((line) => fitExactly(line, width));
  }

  // ── frame primitive (same box-drawing idiom as the workflows browser) ──

  private renderFrame(
    title: string,
    content: readonly string[],
    width: number,
    height: number,
  ): string[] {
    if (height < 2 || width < 4) {
      const out: string[] = [];
      for (let i = 0; i < height; i++) out.push(' '.repeat(width));
      return out;
    }
    const innerWidth = width - 2;
    const innerHeight = height - 2;

    const titleStyled = currentTheme.boldFg('textStrong', title);
    const titleWidth = visibleWidth(titleStyled);
    const titleSegment = `─ ${titleStyled} `;
    const titleSegmentWidth = visibleWidth(titleSegment);
    const remainingDashes = Math.max(0, innerWidth - titleSegmentWidth);
    const topMid =
      titleWidth > 0 && titleSegmentWidth <= innerWidth
        ? currentTheme.fg('border', '─ ') +
          titleStyled +
          ' ' +
          currentTheme.fg('border', '─'.repeat(remainingDashes))
        : currentTheme.fg('border', '─'.repeat(innerWidth));
    const top = currentTheme.fg('border', '┌') + topMid + currentTheme.fg('border', '┐');
    const bottom = currentTheme.fg('border', '└' + '─'.repeat(innerWidth) + '┘');

    const lines: string[] = [top];
    for (let i = 0; i < innerHeight; i++) {
      const inner = content[i] ?? '';
      lines.push(
        currentTheme.fg('border', '│') +
          fitExactly(inner, innerWidth) +
          currentTheme.fg('border', '│'),
      );
    }
    lines.push(bottom);
    return lines;
  }

  // ── left: team list frame ────────────────────────────────────────────

  private renderListFrame(width: number, height: number): string[] {
    const title = t('teams.list.title');
    const innerHeight = Math.max(0, height - 2);

    if (this.props.teams.length === 0) {
      const lines: string[] = [currentTheme.fg('textMuted', t('teams.list.empty'))];
      while (lines.length < innerHeight) lines.push('');
      return this.renderFrame(title, lines, width, height);
    }

    const start = scrolledToSelection(
      this.listScroll,
      this.selectedIndex,
      innerHeight,
      this.props.teams.length,
    );
    const window = this.props.teams.slice(start, start + innerHeight);

    const innerWidth = width - 2;
    const lines: string[] = [];
    for (const [vi, team] of window.entries()) {
      const index = start + vi;
      // Hover underline marks the team row under the pointer (mouse motion);
      // text-segment only — the row's full-width padding stays plain.
      lines.push(
        underlineText(
          this.renderTeamRow(team, index === this.selectedIndex, innerWidth),
          this.hover.isHovered(index),
        ),
      );
      // The row's zone spans the whole list column (borders included, as the
      // press math always allowed): header(1) + frame top border(1) + vi.
      this.rowZones.push({ id: index, row: 2 + vi, col: 1, width, height: 1 });
    }
    while (lines.length < innerHeight) lines.push('');

    return this.renderFrame(title, lines, width, height);
  }

  private renderTeamRow(team: TeamWire, selected: boolean, innerWidth: number): string {
    const pointer = selected ? `${SELECT_POINTER} ` : '  ';
    const pointerStyled = currentTheme.fg(selected ? 'primary' : 'textDim', pointer);

    const hasRunning = team.members.some(
      (member) => this.props.memberLiveness.get(member.agentId) === 'running',
    );
    const icon = currentTheme.fg(hasRunning ? 'success' : 'textMuted', hasRunning ? '●' : '○');
    const nameText = selected
      ? currentTheme.boldFg('primary', team.name)
      : currentTheme.fg('text', team.name);

    const openTasks = team.tasks.filter((task) => task.status !== 'completed').length;
    const info = currentTheme.fg(
      'textMuted',
      `${String(team.members.length)}·${openTasks > 0 ? `${String(openTasks)}▸` : ''}${String(team.tasks.length)}`,
    );

    const prefix = `${pointerStyled}${icon} ${nameText}`;
    const prefixWidth = visibleWidth(prefix);
    const infoBudget = Math.max(0, innerWidth - prefixWidth - 1);
    if (infoBudget < 4) return fitExactly(prefix, innerWidth);
    return fitExactly(`${prefix} ${truncateToWidth(info, infoBudget, ELLIPSIS)}`, innerWidth);
  }

  // ── right: team detail frame ─────────────────────────────────────────

  private renderDetailFrame(
    width: number,
    height: number,
  ): { lines: string[]; contentRows: number } {
    const innerHeight = Math.max(0, height - 2);
    const team = this.props.teams.find(
      (candidate) => candidate.name === this.props.selectedTeamName,
    );
    if (team === undefined) {
      const lines: string[] = [currentTheme.fg('textMuted', t('teams.detail.empty'))];
      while (lines.length < innerHeight) lines.push('');
      return {
        lines: this.renderFrame(t('teams.detail.title'), lines, width, height),
        contentRows: 0,
      };
    }

    const innerWidth = width - 2;
    const content = this.buildDetailContent(team, innerWidth);

    // The scroll window is derived here (pure) — the input handlers own the
    // stored state.
    const settled = followScroll(
      { scroll: this.detailScroll, follow: this.detailFollow },
      content.length,
      innerHeight,
    );
    const visible = content.slice(settled.scroll, settled.scroll + innerHeight);
    while (visible.length < innerHeight) visible.push('');
    const title =
      content.length > innerHeight
        ? `${t('teams.detail.title')}: ${team.name}` +
          t('teams.detail.scrollInfo', {
            from: settled.scroll + 1,
            to: Math.min(content.length, settled.scroll + innerHeight),
            total: content.length,
          })
        : `${t('teams.detail.title')}: ${team.name}`;
    return { lines: this.renderFrame(title, visible, width, height), contentRows: content.length };
  }

  private buildDetailContent(team: TeamWire, innerWidth: number): string[] {
    // Members with live liveness joined from task info.
    const lines: string[] = [
      currentTheme.boldFg('textMuted', t('teams.detail.members', { count: team.members.length })),
    ];
    for (const member of team.members) {
      const liveness: MemberLiveness = this.props.memberLiveness.get(member.agentId) ?? 'idle';
      const icon = currentTheme.fg(livenessColor(liveness), LIVENESS_ICON[liveness]);
      lines.push(
        `  ${icon} ${currentTheme.fg('text', member.name)}${currentTheme.fg('textDim', ` · ${t(LIVENESS_LABEL[liveness])}`)}`,
      );
    }
    lines.push('');

    // Shared task list with status and owner — the sanctioned table dialect
    // (header + rule + aligned columns; degrades to key-value records when
    // the pane is too narrow).
    lines.push(
      currentTheme.boldFg('textMuted', t('teams.detail.tasks', { count: team.tasks.length })),
    );
    if (team.tasks.length === 0) {
      lines.push(currentTheme.fg('textDim', `  ${t('teams.detail.noTasks')}`));
    } else {
      lines.push(
        ...renderTable({
          columns: [
            { header: t('teams.task.column.id') },
            { header: t('teams.task.column.subject') },
            { header: t('teams.task.column.status') },
            { header: t('teams.task.column.owner') },
          ],
          rows: team.tasks.map((task) => {
            const statusColor =
              task.status === 'in_progress'
                ? 'success'
                : task.status === 'completed'
                  ? 'textMuted'
                  : 'text';
            return [
              currentTheme.fg('textDim', `#${String(task.id)}`),
              currentTheme.fg('text', task.subject),
              currentTheme.fg(statusColor, `[${t(TASK_STATUS_LABEL[task.status])}]`),
              currentTheme.fg('textDim', task.owner ?? t('teams.task.unclaimed')),
            ];
          }),
          width: innerWidth,
          margin: 2,
        }),
      );
    }
    lines.push('');

    // Recent mailbox activity for this team (newest at the bottom — the
    // pane is tail-pinned by default).
    lines.push(currentTheme.boldFg('textMuted', t('teams.detail.activity')));
    const activity = this.props.activity
      .filter((entry) => entry.teamName === team.name)
      .slice(-ACTIVITY_DISPLAY_COUNT);
    if (activity.length === 0) {
      lines.push(currentTheme.fg('textDim', `  ${t('teams.detail.noActivity')}`));
    } else {
      for (const entry of activity) {
        const head = currentTheme.fg(
          'textDim',
          `  ${activityTime(entry.createdAt)} ${entry.from} → ${entry.to}`,
        );
        const kind = currentTheme.fg('textMuted', `[${t(ACTIVITY_KIND_LABEL[entry.kind])}]`);
        const preview = singleLine(entry.preview);
        const line = `${head} ${kind}${preview.length > 0 ? currentTheme.fg('text', ` ${preview}`) : ''}`;
        for (const wrapped of wrapTextWithAnsi(line, innerWidth)) {
          lines.push(wrapped);
        }
      }
    }
    return lines;
  }
}
