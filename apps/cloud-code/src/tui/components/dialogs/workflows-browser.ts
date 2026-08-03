/**
 * WorkflowsBrowserApp — full-screen takeover for the `/workflows` command.
 * Two-pane layout: a collapsible agent tree on the left (main agent plus
 * every subagent / swarm worker seen this session, with live status,
 * step, token and elapsed-time readouts) and a read-only chain-of-thought
 * pane on the right (agent header + recent activity stream — thinking
 * segments interleaved with tool calls — replayed from the session event
 * stream by `WorkflowTracker`). Per-agent rendering idioms live in
 * `workflows-agent-content.ts`, shared with the full-width detail view.
 *
 * Mounting follows the tasks-browser pattern: `cloud-code-tui.ts` swaps the
 * root container's children for this component and restores them on
 * close. Data flows in via `setProps`; user actions fire the `on*`
 * callbacks back to the controller.
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

import { formatTokenCount } from '#/utils/usage/usage-format';
import { SELECT_POINTER } from '#/tui/constant/symbols';
import { MAIN_AGENT_ID } from '#/tui/constant/cloud-code-tui';
import { fitExactly } from '#/tui/components/primitives';
import { getLocalePreference, t } from '#/tui/i18n';
import { currentTheme } from '#/tui/theme';
import type { ColorPalette } from '#/tui/theme/colors';
import { createScrollbarStyle } from '#/tui/theme/pi-tui-theme';
import { wrapHint } from '#/tui/utils/hint';
import { HoverState, underlineText } from '#/tui/utils/mouse-hover';
import { printableChar } from '#/tui/utils/printable-key';
import { followScroll, scrolledToSelection } from '#/tui/utils/scroll-window';
import {
  workflowNodeTotalTokens,
  type WorkflowAgentNode,
} from '#/tui/controllers/workflows-tracker';
import {
  activityTruncationHintNeeded,
  displayName,
  formatDuration,
  pushActivityLines,
  pushAgentHeaderLines,
  statusColor,
  STATUS_ICON,
  STATUS_LABEL,
} from './workflows-agent-content';
import { DialogFrame } from './frame/dialog-frame';

const ELLIPSIS = '…';

/** Zone id of the scroll panes' hover-revealed scrollbar (right border of
 * the list-mode preview frame and of the full-width detail frame). */
const SCROLLBAR_ZONE = 'scrollbar';

export interface WorkflowsBrowserProps {
  readonly agents: readonly WorkflowAgentNode[];
  readonly selectedAgentId: string | undefined;
  readonly onSelect: (agentId: string) => void;
  readonly onCancel: () => void;
}

/** Minimum dimensions before we just print a "too small" message. */
const MIN_WIDTH = 48;
const MIN_HEIGHT = 10;

/** Hard caps so a tiny / huge terminal still gets a sensible left-column width. */
const TREE_COL_MIN = 28;
const TREE_COL_MAX = 48;
const TREE_COL_RATIO = 0.36;

interface TreeRow {
  readonly node: WorkflowAgentNode;
  readonly depth: number;
  readonly hasChildren: boolean;
}

/**
 * Flatten the forest into display order. Roots are nodes without a parent
 * id or whose parent is not part of the snapshot (defensive: events of a
 * parent that predates the tracker's attach). Children of collapsed nodes
 * are skipped.
 */
function buildTreeRows(
  agents: readonly WorkflowAgentNode[],
  collapsedIds: ReadonlySet<string>,
): TreeRow[] {
  const known = new Set(agents.map((a) => a.agentId));
  const childrenOf = new Map<string, WorkflowAgentNode[]>();
  const roots: WorkflowAgentNode[] = [];
  for (const agent of agents) {
    const parent = agent.parentAgentId;
    if (parent === undefined || !known.has(parent)) {
      roots.push(agent);
      continue;
    }
    const siblings = childrenOf.get(parent);
    if (siblings === undefined) {
      childrenOf.set(parent, [agent]);
    } else {
      siblings.push(agent);
    }
  }
  const rows: TreeRow[] = [];
  const walk = (node: WorkflowAgentNode, depth: number): void => {
    const children = childrenOf.get(node.agentId) ?? [];
    rows.push({ node, depth, hasChildren: children.length > 0 });
    if (collapsedIds.has(node.agentId)) return;
    for (const child of children) {
      walk(child, depth + 1);
    }
  };
  for (const root of roots) {
    walk(root, 0);
  }
  return rows;
}

export class WorkflowsBrowserApp extends Container implements Focusable {
  focused = false;

  private props: WorkflowsBrowserProps;
  private readonly terminal: Terminal;
  private rows: TreeRow[];
  private selectedIndex = 0;
  private listScroll = 0;
  private readonly collapsedIds = new Set<string>();
  /**
   * Master-detail navigation (Claude's AgentsList → AgentDetail pattern):
   * `list` shows the two-pane tree + chain preview; `detail` gives the
   * selected agent the full width with wrapped, scrollable content.
   */
  private mode: 'list' | 'detail' = 'list';
  private detailScroll = 0;
  private detailFollow = true;
  /** Preview pane (list mode) scroll position; pinned to the tail by default. */
  private previewScroll = 0;
  private previewFollow = true;
  /** Hover-revealed scrollbar on the scroll pane's right border (both modes). */
  private readonly paneScrollbar = new Scrollbar();
  /** Hovered tree row index (mouse motion); null when the pointer is elsewhere. */
  private readonly hover = new HoverState();
  /** The shared frame, used here only for its too-small fallback — the
   * takeover's own ┌─┐ pane chrome renders byte-identically without it. */
  private readonly frame: DialogFrame;
  /** Component-relative hit zones of the last render (tree rows, collapse
   * toggles, and the two wheel-routing panes) — served from hitZones(). */
  private frameZones: HitZone[] = [];
  /** Tree-row and toggle zones recorded by renderTreeFrame during the
   * current render. */
  private rowZones: HitZone[] = [];
  /** Width of the last render; scroll handlers re-derive content heights and
   * the zones from the current state at this width (a render always runs
   * before dispatched input). */
  private lastRenderWidth = 80;
  /** Footer rows of the last render (the key hint wraps at narrow widths);
   * paneInnerRows consults this cache outside render. */
  private lastFooterRows = 1;
  /** Inputs the declared zones depend on, captured by each render. A mouse
   * event whose inputs all match skips the zone re-derivation render:
   * render is pure, so unchanged inputs mean the cached zones are exact. */
  private zoneInputs:
    | {
        treeRows: TreeRow[];
        mode: 'list' | 'detail';
        selectedIndex: number;
        listScroll: number;
        screenRows: number;
        locale: string;
      }
    | undefined;

  // ── render memoization ───────────────────────────────────────────────
  //
  // The controller repaints on every tracker change and on a 1s tick (to
  // advance elapsed times), but a full render rebuilds the selected agent's
  // whole activity stream even when only a duration string changed. The two
  // caches below memoize the expensive, time-independent pieces per node:
  // nodes are mutated in place by the tracker, so validity is keyed on the
  // tracker's per-node `revision` counter rather than field comparison.
  // Keys also pin the theme palette and locale — the two global inputs that
  // change rendered strings without touching the node.
  private activityCache = new WeakMap<
    WorkflowAgentNode,
    {
      readonly palette: ColorPalette;
      readonly locale: string;
      readonly revision: number;
      readonly innerWidth: number;
      readonly wrap: boolean;
      readonly lines: readonly string[];
    }
  >();
  private treeRowCache = new WeakMap<
    WorkflowAgentNode,
    {
      readonly palette: ColorPalette;
      readonly locale: string;
      readonly revision: number;
      readonly duration: string;
      readonly selected: boolean;
      readonly innerWidth: number;
      readonly depth: number;
      readonly hasChildren: boolean;
      readonly collapsed: boolean;
      readonly line: string;
    }
  >();

  /**
   * Theme changes reach this component through the root invalidate()
   * recursion; the memoized strings embed palette colors, so the caches must
   * go. (This component has no child components, so the base-class
   * invalidation traversal is a no-op and internal state mutations drive
   * re-renders through pi-tui's post-input render and the controller's
   * requestRender — the previous internal invalidate() calls were no-ops.)
   */
  override invalidate(): void {
    this.activityCache = new WeakMap();
    this.treeRowCache = new WeakMap();
    super.invalidate();
  }

  // ── mouse ────────────────────────────────────────────────────────────

  /**
   * Mouse: in detail mode the wheel scrolls the chain anywhere; in list mode
   * the left tree pane scrolls the agent selection and the right chain pane
   * scrolls its preview. Left-press on a tree row moves the selection to that
   * agent; a press on the expand/collapse glyph toggles it (Enter
   * equivalent); a press on the already-selected row drills into its detail
   * view (→ equivalent — see utils/mouse-hover for the uniform click
   * semantics). Motion underlines the hovered tree row. Press/hover
   * targeting is declared as hit zones (see render); the TUI dispatches zone
   * presses to {@link onHitZone} and tracks the hovered zone via
   * {@link setHoveredZone}. This handler keeps the zone-routed wheel and
   * routes presses/motion arriving outside the zone dispatch (e.g. direct
   * component-relative events) through the same zones.
   */
  handleMouse(event: MouseEvent): void | boolean {
    // A scrollbar drag owns the pointer until the release and maps against
    // the session the press captured — the zones and the content metrics
    // (a full content rebuild) are NOT re-derived per motion event.
    if (event.type === 'motion' && this.paneScrollbar.dragging) {
      if (event.button === 0) {
        this.scrollPaneTo(this.paneScrollbar.drag(event.row - this.scrollbarTrack().top));
        return;
      }
      // Defensive: a button-free motion without a release ends the drag.
      this.paneScrollbar.release();
      this.settleScrollPanes();
      return;
    }
    if (event.type === 'release' && this.paneScrollbar.dragging) {
      this.paneScrollbar.release();
      // The drag mapped against the press-time snapshot; re-settle against
      // the live content now that it ended.
      this.settleScrollPanes();
      return;
    }
    // Re-derived from the current state: direct callers (unit tests) may fire
    // events without an intervening render, so the render cache can be stale.
    const zones = this.currentZones();
    if (event.type === 'motion') {
      // Hover underline is applied outside the memoized tree rows, and pi-tui
      // re-renders whenever a mouse handler returns non-false — no cache
      // interaction needed here.
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
    if (this.mode === 'detail') {
      this.scrollDetail(delta);
      return;
    }
    if (this.rows.length === 0) return false;
    // Takeover wheel events carry a 1-based screen row (the TUI only
    // translates press/motion into the component frame) — subtract one for
    // the zone lookup.
    const zone = hitZoneAt(zones, event.row - 1, event.col, 'action');
    if (zone === null) return false;
    if (zone.id === 'pane:detail' || zone.id === SCROLLBAR_ZONE) {
      this.scrollPreview(delta);
      return;
    }
    this.moveTreeSelection(delta);
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
      last.treeRows !== this.rows ||
      last.mode !== this.mode ||
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
   * Zone press: a `toggle:<row>` zone collapses/expands the row's subtree
   * (Enter equivalent); a tree row takes the selection; a press on the
   * already-selected row drills into its full-width detail view. The pane
   * zones exist for wheel routing — a press on them is a no-op. A press on
   * the scrollbar starts a drag: anchored on the thumb (no jump), jumping
   * to the pointed fraction on the bare track (button-held motion continues
   * it in handleMouse).
   */
  onHitZone(id: HitZoneId, event: MouseEvent): void | boolean {
    if (id === SCROLLBAR_ZONE) {
      const track = this.scrollbarTrack();
      this.scrollPaneTo(
        this.paneScrollbar.press(event.row - track.top, this.scrollbarMetrics(), track.height),
      );
      return;
    }
    if (typeof id === 'string' && id.startsWith('toggle:')) {
      const index = Number(id.slice('toggle:'.length));
      const row = this.rows[index];
      if (row === undefined || !row.hasChildren) return false;
      this.toggleCollapsed(row.node.agentId);
      return;
    }
    if (typeof id !== 'number' || id < 0 || id >= this.rows.length) return false;
    if (id === this.selectedIndex) {
      // Re-click on the selected row drills into the detail view (→ / l).
      this.mode = 'detail';
      this.detailScroll = 0;
      this.detailFollow = true;
      this.hover.update(null);
      return;
    }
    this.selectTreeIndex(id);
  }

  /** Zone hover: the hovered tree row underlines; the scrollbar reveals
   * while its column is hovered; null clears. */
  setHoveredZone(id: HitZoneId | null): void | boolean {
    const barChanged = this.paneScrollbar.hover(id === SCROLLBAR_ZONE);
    const changed = this.hover.update(typeof id === 'number' ? id : null);
    return changed || barChanged ? undefined : false;
  }

  /** Component-frame geometry of the scrollbar's track: the inner rows of
   * the scroll frame (right border = the screen's last column) — identical
   * in both modes (header row 0, frame top border row 1). */
  private scrollbarTrack(): { top: number; height: number } {
    return { top: 2, height: this.paneInnerRows() };
  }

  /** Scroll metrics of the active mode's pane (the same settle the render
   * derives — stored state is the input handlers'). */
  private scrollbarMetrics(): ScrollbarMetrics {
    const viewport = this.paneInnerRows();
    const detail = this.mode === 'detail';
    const content = detail ? this.detailContentRows() : this.previewContentRows();
    const settled = followScroll(
      detail
        ? { scroll: this.detailScroll, follow: this.detailFollow }
        : { scroll: this.previewScroll, follow: this.previewFollow },
      content,
      viewport,
    );
    return { scrollTop: settled.scroll, viewport, content };
  }

  /** Absolute counterpart of scrollPreview/scrollDetail: the scrollbar's
   * press/drag target lands here; parking at the bottom re-engages follow.
   * During a drag the settle reuses the session's geometry snapshot instead
   * of re-deriving the content height per motion event. */
  private scrollPaneTo(target: number): void {
    const session = this.paneScrollbar.dragSession;
    const viewport = session?.viewport ?? this.paneInnerRows();
    const content =
      session?.content ?? (this.mode === 'detail' ? this.detailContentRows() : this.previewContentRows());
    const settled = followScroll({ scroll: target, follow: false }, content, viewport);
    if (this.mode === 'detail') {
      this.detailScroll = settled.scroll;
      this.detailFollow = settled.follow;
      return;
    }
    this.previewScroll = settled.scroll;
    this.previewFollow = settled.follow;
  }

  /** Expand/collapse a tree row's subtree (Enter / glyph-click). */
  private toggleCollapsed(agentId: string): void {
    if (this.collapsedIds.has(agentId)) {
      this.collapsedIds.delete(agentId);
    } else {
      this.collapsedIds.add(agentId);
    }
    this.rows = buildTreeRows(this.props.agents, this.collapsedIds);
    this.syncSelectionFromProps();
  }

  private moveTreeSelection(delta: number): void {
    const next = Math.max(0, Math.min(this.rows.length - 1, this.selectedIndex + delta));
    if (next === this.selectedIndex) return;
    this.selectTreeIndex(next);
  }

  private scrollPreview(delta: number): void {
    // Settle the stored position against the current content and geometry
    // (render is pure now), then apply the tick — parking at the bottom
    // re-engages the tail follow.
    const contentRows = this.previewContentRows();
    const visible = this.paneInnerRows();
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
  }

  constructor(props: WorkflowsBrowserProps, terminal: Terminal) {
    super();
    this.props = props;
    this.terminal = terminal;
    this.frame = new DialogFrame({
      minSize: {
        width: MIN_WIDTH,
        height: MIN_HEIGHT,
        message: t('workflows.tooSmall', { width: MIN_WIDTH, height: MIN_HEIGHT }),
      },
    });
    this.rows = buildTreeRows(props.agents, this.collapsedIds);
    this.syncSelectionFromProps();
  }

  setProps(next: WorkflowsBrowserProps): void {
    this.props = next;
    this.rows = buildTreeRows(next.agents, this.collapsedIds);
    this.syncSelectionFromProps();
    // The content behind the scroll panes may have changed with the props —
    // re-settle the stored scroll/follow the way the render pass used to
    // (render is pure now, so this is where content-driven clamping lives).
    this.settleScrollPanes();
    // No invalidate() here: the controller's repaint always follows with a
    // requestRender, and the memo caches are keyed on node revisions.
  }

  private syncSelectionFromProps(): void {
    if (this.rows.length === 0) {
      this.selectedIndex = 0;
      this.listScroll = 0;
      return;
    }
    if (this.props.selectedAgentId !== undefined) {
      const idx = this.rows.findIndex((r) => r.node.agentId === this.props.selectedAgentId);
      if (idx !== -1) {
        this.selectedIndex = idx;
        this.listScroll = scrolledToSelection(
          this.listScroll,
          this.selectedIndex,
          this.paneInnerRows(),
          this.rows.length,
        );
        return;
      }
    }
    if (this.selectedIndex >= this.rows.length) {
      this.selectedIndex = this.rows.length - 1;
    }
    this.listScroll = scrolledToSelection(
      this.listScroll,
      this.selectedIndex,
      this.paneInnerRows(),
      this.rows.length,
    );
  }

  /** Inner content rows of the body frames (body = rows-2, borders eat 2). */
  private paneInnerRows(): number {
    // header(1) + footer(lastFooterRows — the key hint wraps when narrow)
    // + the pane frame's two borders.
    return Math.max(0, Math.max(1, this.terminal.rows) - 3 - this.lastFooterRows);
  }

  /** Tree column width for a render width (the render's own split). */
  private treeWidthFor(width: number): number {
    return Math.max(TREE_COL_MIN, Math.min(TREE_COL_MAX, Math.floor(width * TREE_COL_RATIO)));
  }

  /** Content height of the list-mode preview pane at the last render width. */
  private previewContentRows(): number {
    const node = this.props.agents.find((a) => a.agentId === this.props.selectedAgentId);
    if (node === undefined) return 0;
    const detailWidth = this.lastRenderWidth - this.treeWidthFor(this.lastRenderWidth);
    return this.buildAgentContent(node, detailWidth - 2, false).length;
  }

  /** Content height of the full-width detail view at the last render width. */
  private detailContentRows(): number {
    const node = this.props.agents.find((a) => a.agentId === this.props.selectedAgentId);
    if (node === undefined) return 0;
    return this.buildAgentContent(node, this.lastRenderWidth - 2, true).length;
  }

  /** Re-settle both scroll panes against the current content and geometry. */
  private settleScrollPanes(): void {
    const visible = this.paneInnerRows();
    const preview = followScroll(
      { scroll: this.previewScroll, follow: this.previewFollow },
      this.previewContentRows(),
      visible,
    );
    this.previewScroll = preview.scroll;
    this.previewFollow = preview.follow;
    const detail = followScroll(
      { scroll: this.detailScroll, follow: this.detailFollow },
      this.detailContentRows(),
      visible,
    );
    this.detailScroll = detail.scroll;
    this.detailFollow = detail.follow;
  }

  private emitSelect(): void {
    const row = this.rows[this.selectedIndex];
    if (row !== undefined) this.props.onSelect(row.node.agentId);
    // A different agent's chain replaces the preview — re-pin to its tail.
    // Kept here (not in moveTreeSelection) so the keyboard path resets too.
    this.previewScroll = 0;
    this.previewFollow = true;
  }

  /**
   * Selection change with the scroll normalization the render pass used to
   * own: settle the stored scroll against the current geometry, change the
   * selection, settle again (render is pure now — it derives the same window
   * for display without storing it).
   */
  private selectTreeIndex(next: number): void {
    const visible = this.paneInnerRows();
    this.listScroll = scrolledToSelection(this.listScroll, this.selectedIndex, visible, this.rows.length);
    this.selectedIndex = next;
    this.listScroll = scrolledToSelection(this.listScroll, this.selectedIndex, visible, this.rows.length);
    this.emitSelect();
  }

  handleInput(data: string): void {
    const k = printableChar(data);

    if (this.mode === 'detail') {
      // ← / h / Tab / Esc / q returns to the agent list (Esc goes back first,
      // the browser itself only closes from list mode).
      if (
        matchesKey(data, Key.left) ||
        k === 'h' ||
        matchesKey(data, Key.tab) ||
        matchesKey(data, Key.escape) ||
        k === 'q' ||
        k === 'Q'
      ) {
        this.mode = 'list';
        this.detailScroll = 0;
        this.detailFollow = true;
        return;
      }
      if (matchesKey(data, Key.up) || k === 'k') {
        this.scrollDetail(-1);
        return;
      }
      if (matchesKey(data, Key.down) || k === 'j') {
        this.scrollDetail(1);
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
      // Home/End (or g/G) jump to the top/bottom — the scroll-viewer idiom.
      if (matchesKey(data, Key.home) || k === 'g') {
        this.detailFollow = false;
        this.detailScroll = 0;
        return;
      }
      if (matchesKey(data, Key.end) || k === 'G') {
        // Follow pins the window to the tail.
        this.detailFollow = true;
        return;
      }
      return;
    }

    if (matchesKey(data, Key.escape) || k === 'q' || k === 'Q') {
      this.props.onCancel();
      return;
    }
    // → / l / Tab drills into the selected agent's full-width detail view.
    if (matchesKey(data, Key.right) || k === 'l' || matchesKey(data, Key.tab)) {
      if (this.rows.length === 0) return;
      this.mode = 'detail';
      this.detailScroll = 0;
      this.detailFollow = true;
      return;
    }
    if (matchesKey(data, Key.up) || k === 'k') {
      if (this.rows.length === 0) return;
      this.selectTreeIndex(Math.max(0, this.selectedIndex - 1));
      return;
    }
    if (matchesKey(data, Key.down) || k === 'j') {
      if (this.rows.length === 0) return;
      this.selectTreeIndex(Math.min(this.rows.length - 1, this.selectedIndex + 1));
      return;
    }
    // Home/End jump the selection to the first/last tree row.
    if (matchesKey(data, Key.home)) {
      if (this.rows.length === 0) return;
      this.selectTreeIndex(0);
      return;
    }
    if (matchesKey(data, Key.end)) {
      if (this.rows.length === 0) return;
      this.selectTreeIndex(this.rows.length - 1);
      return;
    }
    // Same paging idiom as the teams browser: PgUp/PgDn scrolls the pane.
    if (matchesKey(data, Key.pageUp)) {
      this.scrollPreview(-this.detailPageSize());
      return;
    }
    if (matchesKey(data, Key.pageDown)) {
      this.scrollPreview(this.detailPageSize());
      return;
    }
    if (matchesKey(data, Key.enter)) {
      const row = this.rows[this.selectedIndex];
      if (row === undefined || !row.hasChildren) return;
      this.toggleCollapsed(row.node.agentId);
      return;
    }
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
  }

  /**
   * Render the entire screen as `terminal.rows` lines of `width` cols.
   * Layout: header(1) + body(rows-2) + footer(1). Pure: the scroll windows
   * are derived from state (see scrolledToSelection / followScroll), never
   * stored back. Records the render's hit zones as a by-product: one zone
   * per visible tree row (plus a `toggle:` zone on rows with children) and
   * the two full-height panes the wheel handler routes on — list mode only;
   * detail mode declares none (its wheel scrolls anywhere, presses no-op).
   */
  override render(width: number): string[] {
    this.lastRenderWidth = width;
    const rows = Math.max(1, this.terminal.rows);
    this.zoneInputs = {
      treeRows: this.rows,
      mode: this.mode,
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

    if (this.mode === 'detail') {
      const detailFrame = this.renderDetailFrame(width, bodyHeight);
      const lines = [header, ...detailFrame, ...footerLines];
      const scrollbarZone = this.applyScrollbar(lines, width);
      this.frameZones = scrollbarZone === null ? [] : [scrollbarZone];
      this.rowZones = [];
      return lines;
    }

    const treeWidth = this.treeWidthFor(width);
    const detailWidth = width - treeWidth;

    this.rowZones = [];
    const treeFrame = this.renderTreeFrame(treeWidth, bodyHeight);
    const detailFrame = this.renderDetailFrame(detailWidth, bodyHeight);

    const lines: string[] = [header];
    for (let i = 0; i < bodyHeight; i++) {
      lines.push(
        (treeFrame[i] ?? ' '.repeat(treeWidth)) + (detailFrame[i] ?? ' '.repeat(detailWidth)),
      );
    }
    lines.push(...footerLines);
    // The scrollbar's zone comes first so it wins its column over the pane
    // zone (the bar itself is drawn by applyScrollbar while engaged).
    const scrollbarZone = this.applyScrollbar(lines, width);
    this.frameZones = [
      ...(scrollbarZone === null ? [] : [scrollbarZone]),
      ...this.rowZones,
      // Full-height panes for wheel routing (presses on them are no-ops).
      { id: 'pane:tree', row: 0, col: 1, width: treeWidth, height: rows, semantics: { hover: false } },
      { id: 'pane:detail', row: 0, col: treeWidth + 1, width: detailWidth, height: rows, semantics: { hover: false } },
    ];
    return lines;
  }

  /**
   * Hover-revealed scrollbar for the active mode's scroll pane: overlays the
   * bar on the frame's right border while engaged and reports the zone to
   * declare — null when the pane fits its window (nothing to scroll).
   */
  private applyScrollbar(lines: string[], width: number): HitZone | null {
    const track = this.scrollbarTrack();
    const thumb = scrollbarThumb(this.scrollbarMetrics(), track.height);
    if (thumb === null) return null;
    if (this.paneScrollbar.engaged) {
      const barred = drawScrollbar(lines.slice(track.top, track.top + track.height), width, thumb, createScrollbarStyle());
      for (let i = 0; i < barred.length; i++) lines[track.top + i] = barred[i]!;
    }
    return { id: SCROLLBAR_ZONE, row: track.top, col: width, width: 1, height: track.height };
  }

  // ── header / footer ──────────────────────────────────────────────────

  private renderHeader(width: number): string {
    const title = currentTheme.boldFg('primary', t('workflows.title'));
    let running = 0;
    let done = 0;
    let failed = 0;
    for (const agent of this.props.agents) {
      if (agent.status === 'running') running += 1;
      else if (agent.status === 'done') done += 1;
      // killed / timed_out / lost roll up into the failed tally.
      else if (agent.status !== 'idle' && agent.status !== 'waiting' && agent.status !== 'suspended') {
        failed += 1;
      }
    }
    const segments: string[] = [];
    if (running > 0) {
      segments.push(
        currentTheme.fg('success', t('workflows.count.running', { count: running })),
      );
    }
    if (done > 0) {
      segments.push(currentTheme.fg('textDim', t('workflows.count.done', { count: done })));
    }
    if (failed > 0) {
      segments.push(currentTheme.fg('error', t('workflows.count.failed', { count: failed })));
    }
    segments.push(
      currentTheme.fg('textMuted', t('workflows.count.total', { count: this.props.agents.length })),
    );
    return fitExactly(`${title} ${segments.join('')}`, width);
  }

  private renderFooter(width: number): string[] {
    const key = (text: string): string => currentTheme.boldFg('primary', text);
    const dim = (text: string): string => currentTheme.fg('textMuted', text);
    if (this.mode === 'detail') {
      const parts = [
        ` ${key('←/Tab')} ${dim(t('workflows.hint.back'))}`,
        `${key('↑↓')} ${dim(t('workflows.hint.scroll'))}`,
        `${key('PgUp/PgDn')} ${dim(t('workflows.hint.page'))}`,
        `${key('Q/Esc')} ${dim(t('workflows.hint.back'))} `,
      ];
      return wrapHint(parts, width, '  ').map((line) => fitExactly(line, width));
    }
    const parts = [
      ` ${key('↑↓')} ${dim(t('workflows.hint.select'))}`,
      `${key('Enter')} ${dim(t('workflows.hint.expand'))}`,
      `${key('→/Tab')} ${dim(t('workflows.hint.detail'))}`,
      `${key('PgUp/PgDn')} ${dim(t('workflows.hint.page'))}`,
      `${key('Q/Esc')} ${dim(t('workflows.hint.close'))} `,
    ];
    // Wrap at segment boundaries: narrow widths keep every key instead of
    // clipping the tail segments off the single line.
    return wrapHint(parts, width, '  ').map((line) => fitExactly(line, width));
  }

  // ── frame primitive ──────────────────────────────────────────────────

  /**
   * Render a framed box: `┌─ Title ─┐` top, `│ <content> │` sides, `└─┘`
   * bottom. Result is exactly `width × height` cells.
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
      lines.push(
        currentTheme.fg('border', '│') +
          fitExactly(inner, innerWidth) +
          currentTheme.fg('border', '│'),
      );
    }
    lines.push(bottom);
    return lines;
  }

  // ── left: agent tree frame ───────────────────────────────────────────

  private renderTreeFrame(width: number, height: number): string[] {
    const title = t('workflows.tree.title');
    const innerHeight = Math.max(0, height - 2);

    if (this.rows.length === 0) {
      const lines: string[] = [currentTheme.fg('textMuted', t('workflows.tree.empty'))];
      while (lines.length < innerHeight) lines.push('');
      return this.renderFrame(title, lines, width, height);
    }

    const start = scrolledToSelection(
      this.listScroll,
      this.selectedIndex,
      innerHeight,
      this.rows.length,
    );
    const window = this.rows.slice(start, start + innerHeight);

    const innerWidth = width - 2;
    const lines: string[] = [];
    for (const [vi, row] of window.entries()) {
      const index = start + vi;
      // Hover underline marks the tree row's text under the pointer (mouse
      // motion); padding stays plain so the underline tracks text width.
      lines.push(
        underlineText(
          this.renderTreeRow(row, index === this.selectedIndex, innerWidth),
          this.hover.isHovered(index),
        ),
      );
      // The collapse glyph occupies the two cells right after the frame
      // border, the selection pointer and the depth indent (see
      // renderTreeRow); its zone is declared first so it wins the overlap.
      // The row zone spans the whole tree column: header(1) + frame top
      // border(1) + vi.
      if (row.hasChildren) {
        this.rowZones.push({
          id: `toggle:${String(index)}`,
          row: 2 + vi,
          col: 4 + row.depth * 2,
          width: 2,
          height: 1,
          semantics: { hover: false },
        });
      }
      this.rowZones.push({ id: index, row: 2 + vi, col: 1, width, height: 1 });
    }
    // Only the main agent in the tree → hint that subagents will appear.
    if (this.rows.every((r) => r.node.agentId === MAIN_AGENT_ID)) {
      if (lines.length < innerHeight) lines.push('');
      if (lines.length < innerHeight) {
        lines.push(currentTheme.fg('textMuted', t('workflows.tree.noSubagents')));
      }
    }
    while (lines.length < innerHeight) lines.push('');

    return this.renderFrame(title, lines, width, height);
  }

  private renderTreeRow(row: TreeRow, selected: boolean, innerWidth: number): string {
    const { node } = row;
    const palette = currentTheme.palette;
    const locale = getLocalePreference();
    // The only time-dependent cell: the elapsed duration string. Computing
    // it is cheap; it joins the cache key so frozen (ended) agents hit the
    // cache on every tick and only running agents rebuild their row.
    const duration = formatDuration(node);
    const collapsed = this.collapsedIds.has(node.agentId);
    const cached = this.treeRowCache.get(node);
    if (
      cached !== undefined &&
      cached.palette === palette &&
      cached.locale === locale &&
      cached.revision === node.revision &&
      cached.duration === duration &&
      cached.selected === selected &&
      cached.innerWidth === innerWidth &&
      cached.depth === row.depth &&
      cached.hasChildren === row.hasChildren &&
      cached.collapsed === collapsed
    ) {
      return cached.line;
    }
    const line = this.buildTreeRow(row, selected, innerWidth, duration);
    this.treeRowCache.set(node, {
      palette,
      locale,
      revision: node.revision,
      duration,
      selected,
      innerWidth,
      depth: row.depth,
      hasChildren: row.hasChildren,
      collapsed,
      line,
    });
    return line;
  }

  private buildTreeRow(
    row: TreeRow,
    selected: boolean,
    innerWidth: number,
    duration: string,
  ): string {
    const pointer = selected ? `${SELECT_POINTER} ` : '  ';
    const pointerStyled = currentTheme.fg(selected ? 'primary' : 'textDim', pointer);

    const indent = '  '.repeat(row.depth);
    const glyph = row.hasChildren
      ? this.collapsedIds.has(row.node.agentId)
        ? '▸ '
        : '▾ '
      : '  ';
    const glyphStyled = currentTheme.fg('textDim', glyph);

    const { node } = row;
    const icon = currentTheme.fg(statusColor(node.status), STATUS_ICON[node.status]);
    const nameColor = selected ? 'primary' : 'text';
    const swarmBadge = node.swarmIndex === undefined ? '' : `#${node.swarmIndex} `;
    const bgBadge = node.runInBackground
      ? currentTheme.fg('textDim', ` [${t('workflows.tree.backgroundBadge')}]`)
      : '';
    const nameText = selected
      ? currentTheme.boldFg(nameColor, swarmBadge + displayName(node))
      : currentTheme.fg(nameColor, swarmBadge + displayName(node));

    const infoSegments: string[] = [t(STATUS_LABEL[node.status])];
    if (node.step > 0) infoSegments.push(t('workflows.detail.step', { step: node.step }));
    const tokens = workflowNodeTotalTokens(node);
    if (tokens > 0) {
      infoSegments.push(t('workflows.detail.tokens', { tokens: formatTokenCount(tokens) }));
    }
    infoSegments.push(duration);
    const info = currentTheme.fg('textMuted', infoSegments.join(' '));

    const prefix = `${pointerStyled}${indent}${glyphStyled}${icon} ${nameText}${bgBadge}`;
    const prefixWidth = visibleWidth(prefix);
    const infoBudget = Math.max(0, innerWidth - prefixWidth - 1);
    if (infoBudget < 4) return fitExactly(prefix, innerWidth);
    return fitExactly(`${prefix} ${truncateToWidth(info, infoBudget, ELLIPSIS)}`, innerWidth);
  }

  // ── right: chain-of-thought frame ────────────────────────────────────

  private renderDetailFrame(width: number, height: number): string[] {
    const innerHeight = Math.max(0, height - 2);
    const node = this.props.agents.find((a) => a.agentId === this.props.selectedAgentId);
    if (node === undefined) {
      const lines: string[] = [currentTheme.fg('textMuted', t('workflows.detail.empty'))];
      while (lines.length < innerHeight) lines.push('');
      return this.renderFrame(t('workflows.detail.title'), lines, width, height);
    }

    if (this.mode === 'detail') {
      // Full-width detail: content is wrapped to the inner width (never
      // overflows the screen) and scrollable; at the bottom we follow new
      // chain entries as they stream in. The scroll window is derived here
      // (pure) — the input handlers own the stored state.
      const content = this.buildAgentContent(node, width - 2, true);
      const settled = followScroll(
        { scroll: this.detailScroll, follow: this.detailFollow },
        content.length,
        innerHeight,
      );
      const visible = content.slice(settled.scroll, settled.scroll + innerHeight);
      while (visible.length < innerHeight) visible.push('');
      const title =
        content.length > innerHeight
          ? t('workflows.detail.title') +
            t('workflows.detail.scrollInfo', {
              from: settled.scroll + 1,
              to: Math.min(content.length, settled.scroll + innerHeight),
              total: content.length,
            })
          : t('workflows.detail.title');
      return this.renderFrame(title, visible, width, height);
    }

    // List-mode preview pane: tail-visible by default (most recent entries
    // win); scrolling the pane moves the window back into history. The scroll
    // window is derived here (pure) — the input handlers own the stored state.
    const lines = this.buildAgentContent(node, width - 2, false);

    const settled = followScroll(
      { scroll: this.previewScroll, follow: this.previewFollow },
      lines.length,
      innerHeight,
    );
    const visible = lines.slice(settled.scroll, settled.scroll + innerHeight);
    while (visible.length < innerHeight) visible.push('');
    return this.renderFrame(t('workflows.detail.title'), visible, width, height);
  }

  // ── per-agent content (header + activity stream) ──────────────────────

  /**
   * Header block plus the chain-of-thought activity stream. `wrap` selects
   * the detail view's wrapped variant; the preview pane renders the dense
   * flat variant and lets the frame truncate.
   */
  private buildAgentContent(
    node: WorkflowAgentNode,
    innerWidth: number,
    wrap: boolean,
  ): string[] {
    const lines: string[] = [];
    // The header is cheap (a handful of segments) and carries the ticking
    // duration, so it is rebuilt every render; the activity stream is the
    // expensive part and is memoized below.
    pushAgentHeaderLines(lines, node, innerWidth, wrap);
    lines.push('');
    for (const line of this.getActivityLines(node, innerWidth, wrap)) {
      lines.push(line);
    }
    return lines;
  }

  /**
   * Activity stream + truncation hint, memoized per node. Output depends
   * only on the palette, locale, node content (tracked by `revision`), and
   * geometry — none of the time-dependent header fields feed into it.
   */
  private getActivityLines(
    node: WorkflowAgentNode,
    innerWidth: number,
    wrap: boolean,
  ): readonly string[] {
    const palette = currentTheme.palette;
    const locale = getLocalePreference();
    const cached = this.activityCache.get(node);
    if (
      cached !== undefined &&
      cached.palette === palette &&
      cached.locale === locale &&
      cached.revision === node.revision &&
      cached.innerWidth === innerWidth &&
      cached.wrap === wrap
    ) {
      return cached.lines;
    }
    const lines: string[] = [];
    pushActivityLines(lines, node, innerWidth, wrap);
    if (activityTruncationHintNeeded(node)) {
      lines.push('');
      lines.push(currentTheme.fg('textMuted', t('workflows.detail.truncatedHint')));
    }
    this.activityCache.set(node, {
      palette,
      locale,
      revision: node.revision,
      innerWidth,
      wrap,
      lines,
    });
    return lines;
  }
}
