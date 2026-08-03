/**
 * TasksBrowserApp — full-screen alt-screen takeover for browsing
 * background tasks. Three-pane layout (left task list, right top
 * detail, right bottom preview output) framed by a header row and
 * footer key hint.
 *
 * Mounted by `cloud-code-tui.ts` via container swap rather than `showOverlay`
 * — the main TUI's children are saved, cleared, and this component is
 * added as the sole child so it covers the entire screen. The
 * controller restores the children when the user exits.
 *
 * Data (tasks list, tail output) flows in via `setProps`; user actions
 * fire the `on*` callbacks back to the controller.
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
  hitZoneAt,
  type Focusable,
  type HitZone,
  type HitZoneId,
} from '@cloud-code/pi-tui';
import type { BackgroundTaskInfo, BackgroundTaskStatus } from '@cloud-code/sdk';

import { SELECT_POINTER } from '@/tui/constant/symbols';
import { padEndVisible, t, type MessageKey } from '#/tui/i18n';
import { currentTheme } from '#/tui/theme';
import { wrapHint } from '#/tui/utils/hint';
import { HoverState, underlineText } from '#/tui/utils/mouse-hover';
import { printableChar } from '@/tui/utils/printable-key';

import { DialogFrame } from './frame/dialog-frame';

const ELLIPSIS = '…';

/** Zone id of the preview pane's hover-revealed scrollbar (its right border). */
const PREVIEW_SCROLLBAR_ZONE = 'scrollbar:preview';

/** Scrollbar glyphs: muted track, primary thumb — the same chrome pairing
 * the transcript bar uses (see theme/pi-tui-theme createScrollbarStyle). */
const SCROLLBAR_STYLE = {
  track: (glyph: string): string => currentTheme.fg('textMuted', glyph),
  thumb: (glyph: string): string => currentTheme.fg('primary', glyph),
};

export type TasksFilter = 'all' | 'active';

export interface TasksBrowserProps {
  readonly tasks: readonly BackgroundTaskInfo[];
  readonly filter: TasksFilter;
  readonly selectedTaskId: string | undefined;
  readonly tailOutput: string | undefined;
  readonly tailLoading: boolean;
  readonly flashMessage: string | undefined;
  readonly onSelect: (taskId: string) => void;
  readonly onToggleFilter: () => void;
  readonly onRefresh: () => void;
  readonly onCancel: () => void;
  /** Fired when the user confirms a stop request via the inline `y` prompt. */
  readonly onStopConfirmed: (taskId: string) => void;
  /** Fired when the user presses Enter or O on a selected task. */
  readonly onOpenOutput: (taskId: string) => void;
  /** Fired when stop is requested on a task that cannot be stopped. */
  readonly onStopIgnored?: (taskId: string, reason: 'terminal') => void;
}

const STATUS_LABEL: Record<BackgroundTaskStatus, MessageKey> = {
  running: 'dialogs.tasks.status.running',
  completed: 'dialogs.tasks.status.completed',
  failed: 'dialogs.tasks.status.failed',
  timed_out: 'dialogs.tasks.status.timedOut',
  killed: 'dialogs.tasks.status.killed',
  lost: 'dialogs.tasks.status.lost',
};

/** Auto-cancel the inline stop confirmation after this many ms. */
const STOP_CONFIRM_TIMEOUT_MS = 5_000;

/** Minimum dimensions before we just print a "too small" message. */
const MIN_WIDTH = 48;
const MIN_HEIGHT = 10;

/** Hard caps so a tiny / huge terminal still gets a sensible left-column width. */
const LIST_COL_MIN = 28;
const LIST_COL_MAX = 44;
const LIST_COL_RATIO = 0.32;

function statusColor(status: BackgroundTaskStatus): 'success' | 'textMuted' | 'error' {
  switch (status) {
    case 'running':
      return 'success';
    case 'completed':
      return 'textMuted';
    case 'failed':
    case 'timed_out':
    case 'killed':
    case 'lost':
      return 'error';
  }
}

function isTerminal(status: BackgroundTaskStatus): boolean {
  return (
    status === 'completed' ||
    status === 'failed' ||
    status === 'timed_out' ||
    status === 'killed' ||
    status === 'lost'
  );
}

function formatRelativeTime(ts: number | null | undefined): string {
  if (ts === null || ts === undefined || !Number.isFinite(ts) || ts <= 0) return '';
  const diffSec = Math.floor(Math.max(0, Date.now() - ts) / 1000);
  if (diffSec < 60) return t('dialogs.time.justNow');
  const minutes = Math.floor(diffSec / 60);
  if (minutes < 60) return t('dialogs.time.minutesAgo', { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('dialogs.time.hoursAgo', { count: hours });
  const days = Math.floor(hours / 24);
  return t('dialogs.time.daysAgo', { count: days });
}

function singleLine(text: string): string {
  return text.replaceAll(/\s+/g, ' ').trim();
}

function padToWidth(line: string, width: number): string {
  const w = visibleWidth(line);
  if (w === width) return line;
  if (w > width) return truncateToWidth(line, width, ELLIPSIS);
  return line + ' '.repeat(width - w);
}

/** Fit `line` into exactly `width` columns, even after CJK-edge truncation. */
function fitExactly(line: string, width: number): string {
  let s = line;
  if (visibleWidth(s) > width) s = truncateToWidth(s, width, ELLIPSIS);
  return padToWidth(s, width);
}

function visibleTasks(
  tasks: readonly BackgroundTaskInfo[],
  filter: TasksFilter,
): BackgroundTaskInfo[] {
  // The /tasks panel is for background task management. Foreground tasks
  // (detached === false) are shown in the main transcript instead, and only
  // appear here after being detached via Ctrl+B. `detached !== false` keeps
  // reconcile ghosts whose `detached` field may be undefined.
  const backgroundOnly = tasks.filter((t) => t.detached !== false);
  if (filter === 'all') return [...backgroundOnly];
  return backgroundOnly.filter((t) => !isTerminal(t.status));
}

function compareTasks(a: BackgroundTaskInfo, b: BackgroundTaskInfo): number {
  const aTerminal = isTerminal(a.status);
  const bTerminal = isTerminal(b.status);
  if (aTerminal !== bTerminal) return aTerminal ? 1 : -1;
  if (!aTerminal) return a.startedAt - b.startedAt;
  return (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt);
}

interface StatusCounts {
  running: number;
  completed: number;
  terminalFailed: number;
}

function countByStatus(tasks: readonly BackgroundTaskInfo[]): StatusCounts {
  const counts: StatusCounts = { running: 0, completed: 0, terminalFailed: 0 };
  for (const t of tasks) {
    switch (t.status) {
      case 'running':
        counts.running += 1;
        break;
      case 'completed':
        counts.completed += 1;
        break;
      case 'failed':
      case 'timed_out':
      case 'killed':
      case 'lost':
        counts.terminalFailed += 1;
        break;
    }
  }
  return counts;
}

/**
 * The scroll window that keeps `selected` visible, clamped to the item count
 * — a pure function: render derives its window from it without mutating
 * state, and the input/scroll handlers apply it to normalize the stored
 * scroll before and after a selection change (exactly what the render
 * sandwich did when render owned the adjustment).
 */
function scrolledToSelection(
  scroll: number,
  selected: number,
  visibleRows: number,
  itemCount: number,
): number {
  if (visibleRows <= 0) return 0;
  let next = scroll;
  if (selected < next) {
    next = selected;
  } else if (selected >= next + visibleRows) {
    next = selected - visibleRows + 1;
  }
  const maxScroll = Math.max(0, itemCount - visibleRows);
  return Math.max(0, Math.min(next, maxScroll));
}

interface FollowScroll {
  readonly scroll: number;
  readonly follow: boolean;
}

/**
 * Tail-pinned scroll window, pure: `follow` pins to the tail of the content;
 * otherwise the position clamps against the content height and re-engages
 * follow once it reaches the bottom.
 */
function followScroll(state: FollowScroll, contentRows: number, visibleRows: number): FollowScroll {
  const maxScroll = Math.max(0, contentRows - visibleRows);
  if (state.follow) return { scroll: maxScroll, follow: true };
  const scroll = Math.max(0, Math.min(state.scroll, maxScroll));
  return { scroll, follow: scroll >= maxScroll };
}

export class TasksBrowserApp extends Container implements Focusable {
  focused = false;

  private props: TasksBrowserProps;
  private readonly terminal: Terminal;
  private sortedVisible: BackgroundTaskInfo[];
  private selectedIndex = 0;
  private listScroll = 0;
  private pendingStopTaskId: string | undefined = undefined;
  private pendingStopTimer: NodeJS.Timeout | undefined = undefined;
  /** Preview pane scroll position; pinned to the output tail by default. */
  private previewScroll = 0;
  private previewFollow = true;
  /** Hover-revealed scrollbar on the preview frame's right border. */
  private readonly previewScrollbar = new Scrollbar();
  /** Hovered task row index (mouse motion); null when the pointer is elsewhere. */
  private readonly hover = new HoverState();
  /** The shared frame, used here only for its too-small fallback — the
   * takeover's own ┌─┐ pane chrome renders byte-identically without it. */
  private readonly frame: DialogFrame;
  /** Component-relative hit zones of the last render (task rows + the two
   * wheel-routing panes) — served from hitZones(). */
  private frameZones: HitZone[] = [];
  /** Task-row zones recorded by renderListFrame during the current render. */
  private rowZones: HitZone[] = [];
  /** Width of the last render; direct handleMouse calls re-derive the zones
   * from the current state at this width (the TUI's zone dispatch uses the
   * render cache — a render always runs before dispatched input). */
  private lastRenderWidth = 80;
  /** Footer rows of the last render (the key hint wraps at narrow widths);
   * the body-height derivations outside render consult this cache. */
  private lastFooterRows = 1;

  constructor(props: TasksBrowserProps, terminal: Terminal) {
    super();
    this.props = props;
    this.terminal = terminal;
    this.frame = new DialogFrame({
      minSize: {
        width: MIN_WIDTH,
        height: MIN_HEIGHT,
        message: t('dialogs.tasks.tooSmall', { width: MIN_WIDTH, height: MIN_HEIGHT }),
      },
    });
    this.sortedVisible = visibleTasks(props.tasks, props.filter).toSorted(compareTasks);
    this.syncSelectionFromProps();
  }

  // ── mouse ────────────────────────────────────────────────────────────

  /**
   * Mouse: the wheel over the task-list pane moves the selection; over the
   * right pane (detail + output preview) it scrolls the preview into history.
   * Left-press on a task row selects that task — the right pane is the
   * read-only "detail" target of a click. Motion underlines the hovered task
   * row. Press/hover targeting is declared as hit zones (see render); the TUI
   * dispatches zone presses to {@link onHitZone} and tracks the hovered zone
   * via {@link setHoveredZone}. This handler keeps the zone-routed wheel and
   * routes presses/motion arriving outside the zone dispatch (e.g. direct
   * component-relative events) through the same zones.
   */
  handleMouse(event: MouseEvent): void | boolean {
    // A preview-scrollbar drag owns the pointer until the release and maps
    // against the session the press captured — the zones (a full render here)
    // and the preview metrics are NOT re-derived per motion event.
    if (event.type === 'motion' && this.previewScrollbar.dragging) {
      if (event.button === 0) {
        this.scrollPreviewTo(this.previewScrollbar.drag(event.row - this.previewTrack().top));
        return;
      }
      // Defensive: a button-free motion without a release ends the drag.
      this.previewScrollbar.release();
      this.settlePreviewPane();
      this.invalidate();
      return;
    }
    if (event.type === 'release' && this.previewScrollbar.dragging) {
      this.previewScrollbar.release();
      // The drag mapped against the press-time snapshot; re-settle against
      // the live content now that it ended.
      this.settlePreviewPane();
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
    if (event.type !== 'wheel' || this.pendingStopTaskId !== undefined) return false;
    const delta = event.button === 64 ? -3 : event.button === 65 ? 3 : 0;
    if (delta === 0 || this.sortedVisible.length === 0) return false;
    // Takeover wheel events carry a 1-based screen row (the TUI only
    // translates press/motion into the component frame) — subtract one for
    // the zone lookup.
    const zone = hitZoneAt(zones, event.row - 1, event.col, 'action');
    if (zone === null) return false;
    if (zone.id === 'pane:detail' || zone.id === PREVIEW_SCROLLBAR_ZONE) {
      this.scrollPreview(delta);
      return;
    }
    const next = Math.max(0, Math.min(this.sortedVisible.length - 1, this.selectedIndex + delta));
    if (next === this.selectedIndex) return false;
    this.selectTaskIndex(next);
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
   * Zone press: a task row takes the selection (the detail/preview pane
   * follows). The pane zones exist for wheel routing — a press on them, or
   * on the already-selected row, is a no-op. A press on the preview
   * scrollbar starts a drag: anchored on the thumb (no jump), jumping to
   * the pointed fraction on the bare track (button-held motion continues
   * it in handleMouse).
   */
  onHitZone(id: HitZoneId, event: MouseEvent): void | boolean {
    if (id === PREVIEW_SCROLLBAR_ZONE) {
      const track = this.previewTrack();
      this.scrollPreviewTo(
        this.previewScrollbar.press(event.row - track.top, this.previewScrollbarMetrics(), track.height),
      );
      return;
    }
    if (typeof id !== 'number' || id < 0 || id >= this.sortedVisible.length) return false;
    if (id === this.selectedIndex) return false;
    this.selectTaskIndex(id);
    this.invalidate();
  }

  /** Zone hover: the hovered task row underlines; the preview scrollbar
   * reveals while its column is hovered; null clears. */
  setHoveredZone(id: HitZoneId | null): void | boolean {
    const barChanged = this.previewScrollbar.hover(id === PREVIEW_SCROLLBAR_ZONE);
    const changed = this.hover.update(typeof id === 'number' ? id : null);
    if (changed || barChanged) this.invalidate();
    return changed || barChanged ? undefined : false;
  }

  /** Component-frame geometry of the preview scrollbar's track: the inner
   * rows of the preview frame, whose right border is the screen's last
   * column. The split matches renderRightStack. */
  private previewTrack(): { top: number; height: number } {
    const body = Math.max(1, this.terminal.rows) - 1 - this.lastFooterRows;
    const detailHeight = Math.max(8, Math.min(Math.floor(body * 0.4), body - 5));
    return { top: 2 + detailHeight, height: Math.max(0, body - detailHeight - 2) };
  }

  /** Preview-pane scroll metrics for the scrollbar (the same settle the
   * render derives — stored state is the input handlers'). */
  private previewScrollbarMetrics(): ScrollbarMetrics {
    const viewport = this.previewInnerRows();
    const content = this.previewContentRows();
    const settled = followScroll(
      { scroll: this.previewScroll, follow: this.previewFollow },
      content,
      viewport,
    );
    return { scrollTop: settled.scroll, viewport, content };
  }

  /** Absolute counterpart of scrollPreview: the scrollbar's press/drag target
   * lands here; parking at the bottom re-engages the tail follow. During a
   * drag the settle reuses the session's geometry snapshot instead of
   * re-deriving the content height per motion event. */
  private scrollPreviewTo(target: number): void {
    const session = this.previewScrollbar.dragSession;
    const settled = followScroll(
      { scroll: target, follow: false },
      session?.content ?? this.previewContentRows(),
      session?.viewport ?? this.previewInnerRows(),
    );
    this.previewScroll = settled.scroll;
    this.previewFollow = settled.follow;
    this.invalidate();
  }

  setProps(next: TasksBrowserProps): void {
    this.props = next;
    this.sortedVisible = visibleTasks(next.tasks, next.filter).toSorted(compareTasks);
    this.syncSelectionFromProps();
    // The content behind the preview pane may have changed with the props —
    // re-settle the stored scroll/follow the way the render pass used to
    // (render is pure now, so this is where content-driven clamping lives).
    this.settlePreviewPane();
    if (this.pendingStopTaskId !== undefined) {
      const task = next.tasks.find((t) => t.taskId === this.pendingStopTaskId);
      if (task === undefined || isTerminal(task.status)) this.clearPendingStop();
    }
    this.invalidate();
  }

  private syncSelectionFromProps(): void {
    if (this.sortedVisible.length === 0) {
      this.selectedIndex = 0;
      this.listScroll = 0;
      return;
    }
    if (this.props.selectedTaskId !== undefined) {
      const idx = this.sortedVisible.findIndex((t) => t.taskId === this.props.selectedTaskId);
      if (idx !== -1) {
        this.selectedIndex = idx;
        this.listScroll = scrolledToSelection(
          this.listScroll,
          this.selectedIndex,
          this.listInnerRows(),
          this.sortedVisible.length,
        );
        return;
      }
    }
    if (this.selectedIndex >= this.sortedVisible.length) {
      this.selectedIndex = this.sortedVisible.length - 1;
    }
    this.listScroll = scrolledToSelection(
      this.listScroll,
      this.selectedIndex,
      this.listInnerRows(),
      this.sortedVisible.length,
    );
  }

  private clearPendingStop(): void {
    this.pendingStopTaskId = undefined;
    if (this.pendingStopTimer !== undefined) {
      clearTimeout(this.pendingStopTimer);
      this.pendingStopTimer = undefined;
    }
  }

  private emitSelect(): void {
    const task = this.sortedVisible[this.selectedIndex];
    if (task) this.props.onSelect(task.taskId);
    // A different task's output replaces the preview — re-pin to its tail.
    this.previewScroll = 0;
    this.previewFollow = true;
  }

  /**
   * Selection change with the scroll normalization the render pass used to
   * own: settle the stored scroll against the current geometry, change the
   * selection, settle again (render is pure now — it derives the same window
   * for display without storing it).
   */
  private selectTaskIndex(next: number): void {
    const visible = this.listInnerRows();
    this.listScroll = scrolledToSelection(
      this.listScroll,
      this.selectedIndex,
      visible,
      this.sortedVisible.length,
    );
    this.selectedIndex = next;
    this.listScroll = scrolledToSelection(
      this.listScroll,
      this.selectedIndex,
      visible,
      this.sortedVisible.length,
    );
    this.emitSelect();
  }

  /** Inner content rows of the list frame (body = rows-2, borders eat 2). */
  private listInnerRows(): number {
    return Math.max(0, Math.max(1, this.terminal.rows) - 4);
  }

  /** Inner height of the preview pane at the current terminal size — the
   * same split renderRightStack applies. */
  private previewInnerRows(): number {
    const body = Math.max(1, this.terminal.rows) - 1 - this.lastFooterRows;
    const detailHeight = Math.max(8, Math.min(Math.floor(body * 0.4), body - 5));
    return Math.max(0, body - detailHeight - 2);
  }

  /** The preview pane's display text (loading / empty placeholder / tail). */
  private previewBody(): string {
    if (this.props.tailLoading) return t('dialogs.tasks.preview.loading');
    if (this.props.tailOutput === undefined || this.props.tailOutput.length === 0) {
      return t('dialogs.tasks.preview.noOutput');
    }
    return this.props.tailOutput;
  }

  /** Content height of the preview pane (the displayed body's line count). */
  private previewContentRows(): number {
    return this.previewBody().split('\n').length;
  }

  /** Re-settle the preview pane against the current content and geometry. */
  private settlePreviewPane(): void {
    const settled = followScroll(
      { scroll: this.previewScroll, follow: this.previewFollow },
      this.previewContentRows(),
      this.previewInnerRows(),
    );
    this.previewScroll = settled.scroll;
    this.previewFollow = settled.follow;
  }

  /**
   * Wheel/PgUp/PgDn tick of the preview pane: settle the stored position
   * against the current content and geometry first (render is pure now), then
   * apply the tick — parking at the bottom re-engages the tail follow.
   */
  private scrollPreview(delta: number): void {
    const contentRows = this.previewContentRows();
    const visible = this.previewInnerRows();
    const settled = followScroll(
      {
        scroll: followScroll(
          { scroll: this.previewScroll, follow: this.previewFollow },
          contentRows,
          visible,
        ).scroll + delta,
        follow: false,
      },
      contentRows,
      visible,
    );
    this.previewScroll = settled.scroll;
    this.previewFollow = settled.follow;
    this.invalidate();
  }

  handleInput(data: string): void {
    const k = printableChar(data);

    if (this.pendingStopTaskId !== undefined) {
      if (k === 'y' || k === 'Y') {
        const taskId = this.pendingStopTaskId;
        this.clearPendingStop();
        this.props.onStopConfirmed(taskId);
        this.invalidate();
        return;
      }
      this.clearPendingStop();
      this.invalidate();
      return;
    }

    if (matchesKey(data, Key.escape) || k === 'q' || k === 'Q') {
      this.props.onCancel();
      return;
    }
    if (matchesKey(data, Key.up) || k === 'k') {
      if (this.sortedVisible.length === 0) return;
      const next = Math.max(0, this.selectedIndex - 1);
      if (next === this.selectedIndex) return;
      this.selectTaskIndex(next);
      this.invalidate();
      return;
    }
    if (matchesKey(data, Key.down) || k === 'j') {
      if (this.sortedVisible.length === 0) return;
      const next = Math.min(this.sortedVisible.length - 1, this.selectedIndex + 1);
      if (next === this.selectedIndex) return;
      this.selectTaskIndex(next);
      this.invalidate();
      return;
    }
    // PgUp/PgDn scroll the preview pane by a page; Home/End jump the
    // selection to the first/last task.
    if (matchesKey(data, Key.pageUp)) {
      this.scrollPreview(-Math.max(1, this.previewInnerRows() - 1));
      return;
    }
    if (matchesKey(data, Key.pageDown)) {
      this.scrollPreview(Math.max(1, this.previewInnerRows() - 1));
      return;
    }
    if (matchesKey(data, Key.home) || matchesKey(data, Key.end)) {
      if (this.sortedVisible.length === 0) return;
      const next = matchesKey(data, Key.home) ? 0 : this.sortedVisible.length - 1;
      if (next === this.selectedIndex) return;
      this.selectTaskIndex(next);
      this.invalidate();
      return;
    }
    if (matchesKey(data, Key.tab) || k === '\t') {
      this.props.onToggleFilter();
      return;
    }
    if (k === 'r' || k === 'R') {
      this.props.onRefresh();
      return;
    }
    if (k === 's' || k === 'S') {
      const task = this.sortedVisible[this.selectedIndex];
      if (task === undefined) return;
      if (isTerminal(task.status)) {
        this.props.onStopIgnored?.(task.taskId, 'terminal');
        return;
      }
      this.pendingStopTaskId = task.taskId;
      this.pendingStopTimer = setTimeout(() => {
        this.clearPendingStop();
        this.invalidate();
      }, STOP_CONFIRM_TIMEOUT_MS);
      this.invalidate();
      return;
    }
    if (k === 'o' || k === 'O' || matchesKey(data, Key.enter)) {
      const task = this.sortedVisible[this.selectedIndex];
      if (task) this.props.onOpenOutput(task.taskId);
      return;
    }
  }

  /**
   * Render the entire screen as `terminal.rows` lines of `width` cols.
   * Layout: header(1) + body(rows-1-footerRows) + footer(1+ rows — the key
   * hint wraps at segment boundaries when narrow). Pure: the scroll windows
   * are derived from state (see scrolledToSelection / followScroll), never
   * stored back. Records the render's hit zones as a by-product: one zone
   * per visible task row plus the two full-height panes the wheel handler
   * routes on (row zones first so they win the overlap).
   */
  override render(width: number): string[] {
    this.lastRenderWidth = width;
    const rows = Math.max(1, this.terminal.rows);
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

    const listWidth = Math.max(
      LIST_COL_MIN,
      Math.min(LIST_COL_MAX, Math.floor(width * LIST_COL_RATIO)),
    );
    const rightWidth = width - listWidth;

    this.rowZones = [];
    const listFrame = this.renderListFrame(listWidth, bodyHeight);
    const rightFrames = this.renderRightStack(rightWidth, bodyHeight);

    const lines: string[] = [header];
    for (let i = 0; i < bodyHeight; i++) {
      lines.push((listFrame[i] ?? ' '.repeat(listWidth)) + (rightFrames[i] ?? ' '.repeat(rightWidth)));
    }
    lines.push(...footerLines);

    // The preview scrollbar's zone comes first so it wins its column over
    // the pane zone; the bar itself is drawn over the frame's right border
    // while engaged (hover-revealed, never a reserved column).
    const track = this.previewTrack();
    const scrollMetrics = this.previewScrollbarMetrics();
    const scrollable = scrollbarThumb(scrollMetrics, track.height) !== null;
    const thumb = this.previewScrollbar.engaged
      ? scrollbarThumb(scrollMetrics, track.height)
      : null;
    if (thumb !== null) {
      const barred = drawScrollbar(lines.slice(track.top, track.top + track.height), width, thumb, SCROLLBAR_STYLE);
      for (let i = 0; i < barred.length; i++) lines[track.top + i] = barred[i]!;
    }
    this.frameZones = [
      ...(scrollable
        ? [{ id: PREVIEW_SCROLLBAR_ZONE, row: track.top, col: width, width: 1, height: track.height }]
        : []),
      ...this.rowZones,
      // Full-height panes for wheel routing (presses on them are no-ops).
      { id: 'pane:list', row: 0, col: 1, width: listWidth, height: rows, semantics: { hover: false } },
      { id: 'pane:detail', row: 0, col: listWidth + 1, width: rightWidth, height: rows, semantics: { hover: false } },
    ];
    return lines;
  }

  // ── header / footer ──────────────────────────────────────────────────

  private renderHeader(width: number): string {
    const title = currentTheme.boldFg('primary', t('dialogs.tasks.title'));
    const filterText = currentTheme.fg(
      'textMuted',
      ` ${t(this.props.filter === 'all' ? 'dialogs.tasks.filter.all' : 'dialogs.tasks.filter.active')} `,
    );
    // Count only the tasks actually listed (background tasks after the
    // foreground-task filter), so a foreground-only session doesn't read
    // "1 running / 1 total" above an empty list.
    const visible = visibleTasks(this.props.tasks, this.props.filter);
    const counts = countByStatus(visible);
    const countSegments: string[] = [];
    if (counts.running > 0)
      countSegments.push(
        currentTheme.fg('success', t('dialogs.tasks.count.running', { count: counts.running })),
      );
    if (counts.completed > 0)
      countSegments.push(
        currentTheme.fg('textDim', t('dialogs.tasks.count.completed', { count: counts.completed })),
      );
    if (counts.terminalFailed > 0)
      countSegments.push(
        currentTheme.fg(
          'error',
          t('dialogs.tasks.count.interrupted', { count: counts.terminalFailed }),
        ),
      );
    const totals = currentTheme.fg(
      'textMuted',
      t('dialogs.tasks.count.total', { count: visible.length }),
    );

    const composed = title + filterText + countSegments.join('') + totals;
    return fitExactly(composed, width);
  }

  private renderFooter(width: number): string[] {
    const key = (text: string): string => currentTheme.boldFg('primary', text);
    const dim = (text: string): string => currentTheme.fg('textMuted', text);

    if (this.pendingStopTaskId !== undefined) {
      const warn = (text: string): string => currentTheme.boldFg('warning', text);
      const line =
        ` ${warn(t('dialogs.tasks.confirm.stop'))} ${currentTheme.fg('text', this.pendingStopTaskId)}? ` +
        `${key('Y')} ${dim(t('dialogs.tasks.confirm.confirm'))}  ${key('N')}${dim('/')}${key('esc')} ${dim(t('dialogs.tasks.hint.cancel'))} `;
      return [fitExactly(line, width)];
    }

    const parts = [
      ` ${key('↑↓')} ${dim(t('dialogs.tasks.hint.select'))}`,
      `${key('Enter/O')} ${dim(t('dialogs.tasks.hint.output'))}`,
      `${key('S')} ${dim(t('dialogs.tasks.hint.stop'))}`,
      `${key('R')} ${dim(t('dialogs.tasks.hint.refresh'))}`,
      `${key('Tab')} ${dim(t('dialogs.tasks.hint.filter'))}`,
      `${key('Q/Esc')} ${dim(t('dialogs.tasks.hint.cancel'))} `,
    ];
    // Wrap at segment boundaries: narrow widths keep every key instead of
    // clipping the tail segments off the single line.
    const lines = wrapHint(parts, width, '  ');
    const flash = this.props.flashMessage;
    const last = lines.at(-1);
    if (flash !== undefined && flash.length > 0 && last !== undefined) {
      const flashStyled = currentTheme.fg('warning', ` ${flash} `);
      const total = visibleWidth(last) + visibleWidth(flashStyled);
      if (total <= width) {
        lines[lines.length - 1] = last + ' '.repeat(width - total) + flashStyled;
      }
    }
    return lines.map((line) => fitExactly(line, width));
  }

  // ── frame primitive ──────────────────────────────────────────────────

  /**
   * Render a framed box: `┌─ Title ─┐` top, `│ <content> │` sides, `└─┘`
   * bottom. Result is exactly `width × height` cells. `content` is a
   * pre-rendered array of inner-width-sized lines; extra rows are padded.
   */
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
      lines.push(currentTheme.fg('border', '│') + fitExactly(inner, innerWidth) + currentTheme.fg('border', '│'));
    }
    lines.push(bottom);
    return lines;
  }

  // ── left: task list frame ────────────────────────────────────────────

  private renderListFrame(width: number, height: number): string[] {
    const title = t('dialogs.tasks.list.title', {
      filter: t(
        this.props.filter === 'all'
          ? 'dialogs.tasks.filterName.all'
          : 'dialogs.tasks.filterName.active',
      ),
    });
    const innerHeight = Math.max(0, height - 2);

    if (this.sortedVisible.length === 0) {
      const empty =
        this.props.filter === 'active'
          ? t('dialogs.tasks.empty.active')
          : t('dialogs.tasks.empty.all');
      const lines: string[] = [currentTheme.fg('textMuted', empty)];
      while (lines.length < innerHeight) lines.push('');
      return this.renderFrame(title, lines, width, height);
    }

    const start = scrolledToSelection(
      this.listScroll,
      this.selectedIndex,
      innerHeight,
      this.sortedVisible.length,
    );
    const window = this.sortedVisible.slice(start, start + innerHeight);

    const innerWidth = width - 2;
    const lines: string[] = [];
    for (const [vi, task] of window.entries()) {
      const index = start + vi;
      // Hover underline marks the task row under the pointer (mouse motion).
      lines.push(
        underlineText(
          this.renderListRow(task, index === this.selectedIndex, innerWidth),
          this.hover.isHovered(index),
        ),
      );
      // The row's zone spans the whole list column (borders included, as the
      // press math always allowed): header(1) + frame top border(1) + vi.
      // Navigation is locked while the inline stop confirmation is pending,
      // same as the keyboard path — no row zones then.
      if (this.pendingStopTaskId === undefined) {
        this.rowZones.push({ id: index, row: 2 + vi, col: 1, width, height: 1 });
      }
    }
    while (lines.length < innerHeight) lines.push('');

    return this.renderFrame(title, lines, width, height);
  }

  private renderListRow(task: BackgroundTaskInfo, selected: boolean, innerWidth: number): string {
    const pointer = selected ? `${SELECT_POINTER} ` : '  ';
    const pointerStyled = currentTheme.fg(selected ? 'primary' : 'textDim', pointer);

    const idColor = selected
      ? 'primary'
      : task.kind === 'agent'
        ? 'success'
        : task.kind === 'question'
          ? 'warning'
          : 'accent';
    const idText = selected
      ? currentTheme.boldFg(idColor, task.taskId)
      : currentTheme.fg(idColor, task.taskId);
    const idPad = ' '.repeat(Math.max(0, 17 - task.taskId.length));

    const status = t(STATUS_LABEL[task.status]);
    const statusBadge = currentTheme.fg(statusColor(task.status), status);

    const prefix = `${pointerStyled}${idText}${idPad} ${statusBadge}`;
    const prefixWidth = visibleWidth(prefix);
    const descBudget = Math.max(0, innerWidth - prefixWidth - 1);
    if (descBudget < 4) return fitExactly(prefix, innerWidth);

    const description =
      singleLine(task.description) ||
      (task.kind === 'process' ? singleLine(task.command) : '') ||
      t('dialogs.tasks.noDescription');
    const desc = truncateToWidth(description, descBudget, ELLIPSIS);
    return fitExactly(`${prefix} ${currentTheme.fg('text', desc)}`, innerWidth);
  }

  // ── right: detail + preview stack ────────────────────────────────────

  private renderRightStack(width: number, height: number): string[] {
    // Detail gets ~8 rows (or 40% of body, whichever is larger). Preview
    // takes the rest. Both rendered as separate frames stacked vertically.
    const detailHeight = Math.max(8, Math.min(Math.floor(height * 0.4), height - 5));
    const previewHeight = height - detailHeight;
    return [
      ...this.renderDetailFrame(width, detailHeight),
      ...this.renderPreviewFrame(width, previewHeight),
    ];
  }

  private renderDetailFrame(width: number, height: number): string[] {
    const innerHeight = Math.max(0, height - 2);
    const task = this.sortedVisible[this.selectedIndex];
    if (task === undefined) {
      const empty = currentTheme.fg('textMuted', t('dialogs.tasks.detail.empty'));
      const lines: string[] = [empty];
      while (lines.length < innerHeight) lines.push('');
      return this.renderFrame(t('dialogs.tasks.detail.title'), lines, width, height);
    }

    const label = (text: string): string => currentTheme.fg('textMuted', padEndVisible(text, 14));
    const value = (text: string): string => currentTheme.fg('text', text);

    const lines: string[] = [
      `${label(t('dialogs.tasks.detail.taskId'))}${value(task.taskId)}`,
      `${label(t('dialogs.tasks.detail.status'))}${currentTheme.fg(statusColor(task.status), t(STATUS_LABEL[task.status]))}`,
      `${label(t('dialogs.tasks.detail.description'))}${value(singleLine(task.description) || '—')}`,
    ];
    if (task.kind === 'process' && task.command && task.command !== task.description) {
      lines.push(`${label(t('dialogs.tasks.detail.command'))}${value(singleLine(task.command))}`);
    }
    if (task.kind === 'agent' && task.agentId !== undefined) {
      lines.push(`${label(t('dialogs.tasks.detail.agentId'))}${value(task.agentId)}`);
    }
    if (task.kind === 'agent' && task.subagentType !== undefined) {
      lines.push(`${label(t('dialogs.tasks.detail.agentType'))}${value(task.subagentType)}`);
    }
    if (task.kind === 'question') {
      lines.push(`${label(t('dialogs.tasks.detail.questions'))}${currentTheme.fg('textMuted', String(task.questionCount))}`);
      if (task.toolCallId !== undefined) {
        lines.push(`${label(t('dialogs.tasks.detail.toolCall'))}${currentTheme.fg('textMuted', task.toolCallId)}`);
      }
    }
    const timing =
      task.status === 'running'
        ? t('dialogs.tasks.timing.running', { time: formatRelativeTime(task.startedAt) })
        : task.endedAt !== null && task.endedAt !== undefined
          ? t('dialogs.tasks.timing.finished', { time: formatRelativeTime(task.endedAt) })
          : '';
    if (timing.length > 0) lines.push(`${label(t('dialogs.tasks.detail.time'))}${currentTheme.fg('textMuted', timing)}`);
    if (task.kind === 'process' && task.pid > 0) {
      lines.push(`${label(t('dialogs.tasks.detail.pid'))}${currentTheme.fg('textMuted', String(task.pid))}`);
    }
    if (task.kind === 'process' && task.exitCode !== null) {
      lines.push(`${label(t('dialogs.tasks.detail.exitCode'))}${currentTheme.fg('textMuted', String(task.exitCode))}`);
    }
    if (task.stopReason !== undefined && task.stopReason.length > 0) {
      lines.push(`${label(t('dialogs.tasks.detail.reason'))}${currentTheme.fg('textMuted', task.stopReason)}`);
    }
    while (lines.length < innerHeight) lines.push('');
    return this.renderFrame(t('dialogs.tasks.detail.title'), lines, width, height);
  }

  private renderPreviewFrame(width: number, height: number): string[] {
    const innerHeight = Math.max(0, height - 2);
    const task = this.sortedVisible[this.selectedIndex];
    if (task === undefined) {
      const lines: string[] = [currentTheme.fg('textMuted', t('dialogs.tasks.preview.noTask'))];
      while (lines.length < innerHeight) lines.push('');
      return this.renderFrame(t('dialogs.tasks.preview.title'), lines, width, height);
    }

    const rawLines = this.previewBody().split('\n');
    // Tail-visible by default; wheel-scrolling moves the window into history.
    // The scroll window is derived here (pure) — the input handlers own the
    // stored state.
    const settled = followScroll(
      { scroll: this.previewScroll, follow: this.previewFollow },
      rawLines.length,
      innerHeight,
    );
    const windowed = rawLines.slice(settled.scroll, settled.scroll + innerHeight);
    const styled = windowed.map((line) => currentTheme.fg('textDim', line));
    while (styled.length < innerHeight) styled.push('');
    return this.renderFrame(t('dialogs.tasks.preview.title'), styled, width, height);
  }
}
