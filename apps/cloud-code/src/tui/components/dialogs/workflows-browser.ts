import {
  Container,
  drawScrollbar,
  hitZoneAt,
  Key,
  matchesKey,
  Scrollbar,
  scrollbarThumb,
  type HitZone,
  type HitZoneId,
  type MouseEvent,
  type ScrollbarMetrics,
  type Terminal,
  visibleWidth,
} from '@cloud-code/pi-tui';
import type { BackgroundTaskInfo } from '@cloud-code/sdk';

import { fitExactly } from '#/tui/components/primitives';
import { t } from '#/tui/i18n';
import { currentTheme } from '#/tui/theme';
import { createScrollbarStyle } from '#/tui/theme/pi-tui-theme';
import { HoverState } from '#/tui/utils/mouse-hover';
import { normalizeLegacyMetaKey } from '#/tui/utils/legacy-meta-key';
import { printableChar } from '#/tui/utils/printable-key';
import { followScroll, scrolledToSelection } from '#/tui/utils/scroll-window';
import { wrapHint } from '#/tui/utils/hint';
import type { WorkflowAgentNode } from '#/tui/controllers/workflows-tracker';
import {
  asWorkflowAgentInfo,
  isWorkflowAgentAttention,
  isWorkflowAgentTerminal,
  type WorkflowAgentInfo,
} from './workflows-agent-content';
import {
  buildWorkflowsRosterRows,
  workflowRosterRowIsToggle,
  workflowTeamName,
  type WorkflowsRosterRow,
  WorkflowsRoster,
} from './workflows-roster';
import { WorkflowsAgentDetail } from './workflows-agent-detail';
import { DialogFrame } from './frame/dialog-frame';

const MIN_WIDTH = 48;
const MIN_HEIGHT = 10;
const ROSTER_MIN_WIDTH = 34;
const ROSTER_MAX_WIDTH = 56;
const ROSTER_RATIO = 0.38;
const SCROLLBAR_ZONE = 'scrollbar';

type WorkflowAction = 'stop' | 'output' | 'foreground';

export interface WorkflowsBrowserProps {
  readonly agents: readonly WorkflowAgentNode[];
  readonly selectedAgentId: string | undefined;
  /** Team or swarm scope displayed in the summary line. */
  readonly scope?: string | undefined;
  /** Background task map is used to gate actions to supported task kinds. */
  readonly backgroundTasks?: ReadonlyMap<string, BackgroundTaskInfo>;
  readonly onSelect: (agentId: string) => void;
  readonly onCancel: () => void;
  /** Stop callback is called with the backing background task id. */
  readonly onStopConfirmed?: (taskId: string) => void;
  /** Open the existing task-output viewer for the selected task. */
  readonly onOpenOutput?: (taskId: string) => void;
  /** Foreground callback supplied by the existing task RPC bridge. */
  readonly onForeground?: (taskId: string) => void;
  readonly onActionIgnored?: (action: WorkflowAction, agentId: string) => void;
}

function activeAgent(agent: WorkflowAgentInfo): boolean {
  return !isWorkflowAgentTerminal(agent);
}

function resolveScope(props: WorkflowsBrowserProps): string {
  if (props.scope !== undefined && props.scope.length > 0) return props.scope;
  const teamNames = new Set(
    props.agents
      .map((agent) => asWorkflowAgentInfo(agent).teamName)
      .filter((name): name is string => name !== undefined && name.length > 0),
  );
  if (teamNames.size === 1) return [...teamNames][0]!;
  return props.agents.some((agent) => asWorkflowAgentInfo(agent).swarmIndex !== undefined)
    ? t('workflows.scope.swarm')
    : t('workflows.scope.session');
}

function formatSummary(props: WorkflowsBrowserProps): string {
  let alive = 0;
  let waiting = 0;
  let attention = 0;
  let done = 0;
  for (const raw of props.agents) {
    const agent = asWorkflowAgentInfo(raw);
    if (activeAgent(agent)) alive += 1;
    if (agent.status === 'waiting' || agent.currentActivity?.kind === 'waiting-approval') waiting += 1;
    if (isWorkflowAgentAttention(agent)) attention += 1;
    if (agent.status === 'done') done += 1;
  }
  const segments = [
    currentTheme.boldFg('primary', resolveScope(props)),
    currentTheme.fg('textDim', ' · '),
    currentTheme.fg('success', t('workflows.summary.alive', { count: alive })),
    currentTheme.fg('textDim', ' · '),
    currentTheme.fg(waiting > 0 ? 'warning' : 'textMuted', t('workflows.summary.waiting', { count: waiting })),
    currentTheme.fg('textDim', ' · '),
    currentTheme.fg(attention > 0 ? 'error' : 'textMuted', t('workflows.summary.attention', { count: attention })),
    currentTheme.fg('textDim', ' · '),
    currentTheme.fg('textMuted', t('workflows.summary.done', { count: done })),
  ];
  return segments.join('');
}

export class WorkflowsBrowserApp extends Container {
  focused = false;

  private props: WorkflowsBrowserProps;
  private selectedAgentId: string | undefined;
  private readonly terminal: Terminal;
  private readonly frame: DialogFrame;
  private roster: WorkflowsRoster;
  private detail: WorkflowsAgentDetail;
  private rows: WorkflowsRosterRow[] = [];
  private cursorRowIndex = 0;
  private mode: 'list' | 'detail' = 'list';
  private thinkingExpanded = false;
  private rosterScroll = 0;
  private detailScroll = 0;
  private detailFollow = true;
  private previewScroll = 0;
  private previewFollow = true;
  private readonly scrollbar = new Scrollbar();
  private readonly hover = new HoverState<number>();
  private frameZones: HitZone[] = [];
  private lastRenderWidth = 80;
  private lastBodyHeight = 1;
  private lastFooterRows = 1;
  private pendingStopTaskId: string | undefined;
  private pendingStopTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(props: WorkflowsBrowserProps, terminal: Terminal) {
    super();
    this.props = props;
    this.selectedAgentId = props.selectedAgentId;
    this.initializeDoneGroups(props.agents);
    this.terminal = terminal;
    this.frame = new DialogFrame({
      minSize: {
        width: MIN_WIDTH,
        height: MIN_HEIGHT,
        message: t('workflows.tooSmall', { width: MIN_WIDTH, height: MIN_HEIGHT }),
      },
    });
    this.roster = new WorkflowsRoster({
      agents: props.agents,
      selectedAgentId: props.selectedAgentId,
      collapsedTeams: new Set(this.collapsedTeams),
      collapsedDoneTeams: new Set(this.collapsedDoneTeams),
    });
    this.detail = new WorkflowsAgentDetail({
      agent: this.selectedAgent(),
      thinkingExpanded: this.thinkingExpanded,
    });
    this.syncRows();
  }

  setProps(props: WorkflowsBrowserProps): void {
    this.props = props;
    this.selectedAgentId = props.selectedAgentId;
    this.initializeDoneGroups(props.agents);
    this.syncRows();
    this.roster.setProps({
      agents: props.agents,
      selectedAgentId: this.selectedAgentId,
      collapsedTeams: new Set(this.collapsedTeams),
      collapsedDoneTeams: new Set(this.collapsedDoneTeams),
    });
    this.detail.setProps({ agent: this.selectedAgent(), thinkingExpanded: this.thinkingExpanded });
    this.settleScrolls();
  }

  override invalidate(): void {
    super.invalidate();
  }

  handleInput(data: string): void {
    if (this.pendingStopTaskId !== undefined) {
      const key = printableChar(data);
      if (key === 'y' || key === 'Y') {
        const taskId = this.pendingStopTaskId;
        this.clearStopConfirmation();
        this.props.onStopConfirmed?.(taskId);
      } else {
        this.clearStopConfirmation();
      }
      return;
    }

    const normalized = normalizeLegacyMetaKey(data);
    const key = printableChar(data);
    const altX = matchesKey(normalized, Key.alt('x'));
    const altO = matchesKey(normalized, Key.alt('o'));
    const altF = matchesKey(normalized, Key.alt('f'));
    if (altX || key === 'x' || key === 'X') {
      this.armAction('stop');
      return;
    }
    if (altO || key === 'o' || key === 'O') {
      this.runAction('output');
      return;
    }
    if (altF || key === 'f' || key === 'F') {
      this.runAction('foreground');
      return;
    }
    if (key === 't' || key === 'T') {
      this.thinkingExpanded = !this.thinkingExpanded;
      this.detail.setProps({ agent: this.selectedAgent(), thinkingExpanded: this.thinkingExpanded });
      return;
    }

    if (this.mode === 'detail') {
      if (matchesKey(data, Key.escape) || matchesKey(data, Key.left) || key === 'h' || key === 'q' || key === 'Q' || matchesKey(data, Key.tab)) {
        this.mode = 'list';
        this.detailScroll = 0;
        this.detailFollow = true;
        return;
      }
      if (matchesKey(data, Key.up) || key === 'k') {
        this.scrollDetail(-1);
        return;
      }
      if (matchesKey(data, Key.down) || key === 'j') {
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
      if (matchesKey(data, Key.home) || key === 'g') {
        this.detailFollow = false;
        this.detailScroll = 0;
        return;
      }
      if (matchesKey(data, Key.end) || key === 'G') {
        this.detailFollow = true;
        return;
      }
      return;
    }

    if (matchesKey(data, Key.escape) || key === 'q' || key === 'Q') {
      this.props.onCancel();
      return;
    }
    if (matchesKey(data, Key.enter)) {
      const agent = this.selectedAgent();
      if (agent !== undefined) this.toggleGroup(false, workflowTeamName(agent));
      return;
    }
    if (matchesKey(data, Key.right) || key === 'l' || matchesKey(data, Key.tab)) {
      if (this.selectedAgent() !== undefined) {
        this.mode = 'detail';
        this.frameZones = [];
        this.detailScroll = 0;
        this.detailFollow = true;
      }
      return;
    }
    if (matchesKey(data, Key.up) || key === 'k') {
      this.moveCursor(-1);
      return;
    }
    if (matchesKey(data, Key.down) || key === 'j') {
      this.moveCursor(1);
      return;
    }
    if (matchesKey(data, Key.home)) {
      this.selectAgentByOffset(0);
      return;
    }
    if (matchesKey(data, Key.end)) {
      this.selectAgentByOffset(-1);
      return;
    }
    if (matchesKey(data, Key.pageUp)) {
      this.moveCursor(-this.detailPageSize());
      return;
    }
    if (matchesKey(data, Key.pageDown)) {
      this.moveCursor(this.detailPageSize());
    }
  }

  handleMouse(event: MouseEvent): void | boolean {
    if (event.type === 'motion' && this.scrollbar.dragging) {
      if (event.button === 0) {
        this.scrollPaneTo(this.scrollbar.drag(event.row - this.scrollbarTrack().top));
        return;
      }
      this.scrollbar.release();
      return;
    }
    if (event.type === 'release' && this.scrollbar.dragging) {
      this.scrollbar.release();
      return;
    }
    const zones = this.frameZones;
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
    if (delta === 0) return false;
    if (this.mode === 'detail') {
      this.scrollDetail(delta * 3);
      return;
    }
    const zone = hitZoneAt(zones, event.row - 1, event.col, 'action');
    if (zone === null) return false;
    if (zone.id === 'pane:detail' || zone.id === SCROLLBAR_ZONE) {
      this.scrollPreview(delta * 3);
      return;
    }
    this.moveCursor(delta);
  }

  hitZones(): Iterable<HitZone> {
    return this.frameZones;
  }

  onHitZone(id: HitZoneId, event: MouseEvent): void | boolean {
    if (id === SCROLLBAR_ZONE) {
      const track = this.scrollbarTrack();
      const target = this.scrollbar.press(event.row - track.top, this.scrollbarMetrics(), track.height);
      if (target !== null) this.scrollPaneTo(target);
      return;
    }
    if (typeof id !== 'string') return false;
    if (id.startsWith('toggle:')) {
      const encoded = id.slice('toggle:'.length);
      const [kind, ...rest] = encoded.split(':');
      const teamName = rest.join(':');
      this.toggleGroup(kind === 'done', teamName);
      return;
    }
    if (id.startsWith('row:')) {
      const rowIndex = Number(id.slice('row:'.length));
      const row = this.rows[rowIndex];
      if (row === undefined) return false;
      if (workflowRosterRowIsToggle(row)) {
        this.toggleGroup(row.kind === 'done-group', row.teamName);
        return;
      }
      if (row.kind !== 'agent') return false;
      if (row.agent.agentId === this.selectedAgentId) {
        this.mode = 'detail';
        this.frameZones = [];
        this.detailScroll = 0;
        this.detailFollow = true;
      } else {
        this.selectAgent(row.agent.agentId);
      }
      return;
    }
    return false;
  }

  setHoveredZone(id: HitZoneId | null): void | boolean {
    const rowIndex = typeof id === 'string' && id.startsWith('row:') ? Number(id.slice(4)) : undefined;
    const changed = this.hover.update(rowIndex ?? null);
    const rosterChanged = this.roster.setHoveredRow(rowIndex);
    const barChanged = this.scrollbar.hover(id === SCROLLBAR_ZONE);
    return changed || rosterChanged || barChanged ? undefined : false;
  }

  override render(width: number): string[] {
    this.lastRenderWidth = width;
    const rows = Math.max(1, this.terminal.rows);
    const tooSmall = this.frame.tooSmall(width, rows);
    if (tooSmall !== null) {
      this.frameZones = [];
      return tooSmall;
    }

    const header = fitExactly(formatSummary(this.props), width);
    const footerLines = this.renderFooter(width);
    this.lastFooterRows = footerLines.length;
    const bodyHeight = Math.max(0, rows - 1 - footerLines.length);
    this.lastBodyHeight = bodyHeight;

    let body: string[];
    if (this.mode === 'detail') {
      const frame = this.renderDetailFrame(width, bodyHeight);
      body = frame;
      const lines = [header, ...body, ...footerLines];
      const scrollbarZone = this.applyScrollbar(lines, width);
      this.frameZones = scrollbarZone === null ? [] : [scrollbarZone];
      return lines.map((line) => fitExactly(line, width));
    }

    const rosterWidth = Math.max(ROSTER_MIN_WIDTH, Math.min(ROSTER_MAX_WIDTH, Math.floor(width * ROSTER_RATIO)));
    const detailWidth = Math.max(1, width - rosterWidth);
    const rosterFrame = this.renderRosterFrame(rosterWidth, bodyHeight);
    const detailFrame = this.renderDetailPreviewFrame(detailWidth, bodyHeight);
    body = [];
    for (let row = 0; row < bodyHeight; row++) {
      body.push(fitExactly((rosterFrame[row] ?? '') + (detailFrame[row] ?? ''), width));
    }
    const lines = [header, ...body, ...footerLines];
    const scrollbarZone = this.applyScrollbar(lines, width);
    this.frameZones = [
      ...(scrollbarZone === null ? [ ] : [scrollbarZone]),
      ...this.rosterZones(rosterWidth, bodyHeight),
      { id: 'pane:tree', row: 0, col: 1, width: rosterWidth, height: rows, semantics: { hover: false } },
      { id: 'pane:detail', row: 0, col: rosterWidth + 1, width: detailWidth, height: rows, semantics: { hover: false } },
    ];
    return lines.map((line) => fitExactly(line, width));
  }

  private readonly collapsedTeams = new Set<string>();
  private readonly collapsedDoneTeams = new Set<string>();
  private readonly initializedDoneGroups = new Set<string>();

  private initializeDoneGroups(agents: readonly WorkflowAgentNode[]): void {
    for (const agent of agents) {
      if (agent.status !== 'done') continue;
      const teamName = workflowTeamName(agent);
      if (this.initializedDoneGroups.has(teamName)) continue;
      this.collapsedDoneTeams.add(teamName);
      this.initializedDoneGroups.add(teamName);
    }
  }

  private syncRows(): void {
    this.rows = buildWorkflowsRosterRows(this.props.agents, this.collapsedTeams, this.collapsedDoneTeams);
    const selected = this.selectedAgentId;
    const selectedIndex = selected === undefined ? -1 : this.rows.findIndex((row) => row.kind === 'agent' && row.agent.agentId === selected);
    if (selectedIndex >= 0) {
      this.cursorRowIndex = selectedIndex;
    } else {
      const first = this.rows.findIndex((row) => row.kind === 'agent');
      this.cursorRowIndex = first >= 0 ? first : 0;
    }
  }

  private selectedAgent(): WorkflowAgentInfo | undefined {
    const selected = this.selectedAgentId;
    const raw = this.props.agents.find((agent) => agent.agentId === selected);
    return raw === undefined ? undefined : asWorkflowAgentInfo(raw);
  }

  private selectAgent(agentId: string): void {
    if (this.selectedAgentId === agentId) return;
    this.selectedAgentId = agentId;
    this.props.onSelect(agentId);
    this.previewScroll = 0;
    this.previewFollow = true;
    this.roster.setProps({
      agents: this.props.agents,
      selectedAgentId: this.selectedAgentId,
      collapsedTeams: new Set(this.collapsedTeams),
      collapsedDoneTeams: new Set(this.collapsedDoneTeams),
    });
    this.detail.setProps({ agent: this.selectedAgent(), thinkingExpanded: this.thinkingExpanded });
    this.syncRows();
  }

  private selectAgentByOffset(offset: number): void {
    const agents = this.rows.filter((row): row is Extract<WorkflowsRosterRow, { kind: 'agent' }> => row.kind === 'agent');
    if (agents.length === 0) return;
    const index = offset < 0 ? agents.length - 1 : Math.min(agents.length - 1, offset);
    this.selectAgent(agents[index]!.agent.agentId);
    this.cursorRowIndex = this.rows.findIndex((row) => row.kind === 'agent' && row.agent.agentId === agents[index]!.agent.agentId);
  }

  private moveCursor(delta: number): void {
    if (this.rows.length === 0) return;
    let next = Math.max(0, Math.min(this.rows.length - 1, this.cursorRowIndex + delta));
    if (this.rows[next]?.kind !== 'agent') {
      const direction = delta >= 0 ? 1 : -1;
      while (next >= 0 && next < this.rows.length && this.rows[next]?.kind !== 'agent') next += direction;
      next = Math.max(0, Math.min(this.rows.length - 1, next));
    }
    const row = this.rows[next];
    if (row?.kind !== 'agent') return;
    this.cursorRowIndex = next;
    this.selectAgent(row.agent.agentId);
  }

  private toggleGroup(done: boolean, teamName: string): void {
    const target = done ? this.collapsedDoneTeams : this.collapsedTeams;
    if (target.has(teamName)) target.delete(teamName);
    else target.add(teamName);
    this.syncRows();
    this.roster.setProps({
      agents: this.props.agents,
      selectedAgentId: this.selectedAgentId,
      collapsedTeams: new Set(this.collapsedTeams),
      collapsedDoneTeams: new Set(this.collapsedDoneTeams),
    });
  }

  private armAction(action: 'stop'): void {
    const agent = this.selectedAgent();
    if (agent === undefined || agent.taskId === undefined || !activeAgent(agent)) {
      if (agent !== undefined) this.props.onActionIgnored?.(action, agent.agentId);
      return;
    }
    this.pendingStopTaskId = agent.taskId;
    if (this.pendingStopTimer !== undefined) clearTimeout(this.pendingStopTimer);
    this.pendingStopTimer = setTimeout(() => {
      this.clearStopConfirmation();
    }, 5000);
  }

  private runAction(action: 'output' | 'foreground'): void {
    const agent = this.selectedAgent();
    if (agent === undefined || agent.taskId === undefined) {
      if (agent !== undefined) this.props.onActionIgnored?.(action, agent.agentId);
      return;
    }
    const task = this.props.backgroundTasks?.get(agent.taskId);
    if (task !== undefined && task.kind !== 'agent') {
      this.props.onActionIgnored?.(action, agent.agentId);
      return;
    }
    if (action === 'output') {
      this.props.onOpenOutput?.(agent.taskId);
      return;
    }
    if (task !== undefined && task.detached === false) {
      this.props.onActionIgnored?.(action, agent.agentId);
      return;
    }
    if (this.props.onForeground === undefined) {
      this.props.onActionIgnored?.(action, agent.agentId);
      return;
    }
    this.props.onForeground(agent.taskId);
  }

  private clearStopConfirmation(): void {
    this.pendingStopTaskId = undefined;
    if (this.pendingStopTimer !== undefined) clearTimeout(this.pendingStopTimer);
    this.pendingStopTimer = undefined;
  }

  private renderRosterFrame(width: number, height: number): string[] {
    const innerHeight = Math.max(0, height - 2);
    const innerWidth = Math.max(1, width - 2);
    const lineCount = Math.max(3, this.rows.length);
    const allLines = this.roster.render(innerWidth, lineCount);
    const selectedRow = this.rows.findIndex((row) => row.kind === 'agent' && row.agent.agentId === this.selectedAgentId);
    this.rosterScroll = scrolledToSelection(this.rosterScroll, selectedRow < 0 ? this.cursorRowIndex : selectedRow, innerHeight, lineCount);
    const visible = allLines.slice(this.rosterScroll, this.rosterScroll + innerHeight);
    while (visible.length < innerHeight) visible.push('');
    return this.renderFrame(t('workflows.roster.title'), visible, width, height);
  }

  private renderDetailPreviewFrame(width: number, height: number): string[] {
    const innerHeight = Math.max(0, height - 2);
    const contentWidth = Math.max(1, width - 2);
    const content = this.detail.render(contentWidth, this.detail.contentRows(contentWidth));
    const settled = followScroll({ scroll: this.previewScroll, follow: this.previewFollow }, content.length, innerHeight);
    this.previewScroll = settled.scroll;
    this.previewFollow = settled.follow;
    const visible = content.slice(settled.scroll, settled.scroll + innerHeight);
    while (visible.length < innerHeight) visible.push('');
    return this.renderFrame(t('workflows.detail.title'), visible, width, height);
  }

  private renderDetailFrame(width: number, height: number): string[] {
    const innerHeight = Math.max(0, height - 2);
    const contentWidth = Math.max(1, width - 2);
    const content = this.detail.render(contentWidth, this.detail.contentRows(contentWidth));
    const settled = followScroll({ scroll: this.detailScroll, follow: this.detailFollow }, content.length, innerHeight);
    this.detailScroll = settled.scroll;
    this.detailFollow = settled.follow;
    const visible = content.slice(settled.scroll, settled.scroll + innerHeight);
    while (visible.length < innerHeight) visible.push('');
    const title = t('workflows.detail.title');
    return this.renderFrame(title, visible, width, height);
  }

  private rosterZones(width: number, height: number): HitZone[] {
    const innerHeight = Math.max(0, height - 2);
    const zones: HitZone[] = [];
    const visible = this.rows.slice(this.rosterScroll, this.rosterScroll + innerHeight);
    for (const [offset, row] of visible.entries()) {
      const rowIndex = this.rosterScroll + offset;
      if (workflowRosterRowIsToggle(row)) {
        zones.push({
          id: `toggle:${row.kind === 'done-group' ? 'done:' : 'team:'}${row.teamName}`,
          row: 2 + offset,
          col: 3,
          width: 2,
          height: 1,
          semantics: { hover: false },
        });
      }
      zones.push({ id: `row:${String(rowIndex)}`, row: 2 + offset, col: 1, width, height: 1 });
    }
    return zones;
  }

  private detailPageSize(): number {
    return Math.max(1, this.lastBodyHeight - 3);
  }

  private settleScrolls(): void {
    const viewport = Math.max(1, this.lastBodyHeight - 2);
    const detailRows = this.detail.contentRows(Math.max(1, this.lastRenderWidth - 2));
    const detail = followScroll({ scroll: this.detailScroll, follow: this.detailFollow }, detailRows, viewport);
    this.detailScroll = detail.scroll;
    this.detailFollow = detail.follow;
    const rosterRows = this.rows.length;
    this.rosterScroll = scrolledToSelection(this.rosterScroll, this.cursorRowIndex, viewport, rosterRows);
  }

  private scrollDetail(delta: number): void {
    const content = this.detail.contentRows(Math.max(1, this.lastRenderWidth - 2));
    const viewport = Math.max(1, this.lastBodyHeight - 2);
    const settled = followScroll(
      { scroll: followScroll({ scroll: this.detailScroll, follow: this.detailFollow }, content, viewport).scroll + delta, follow: false },
      content,
      viewport,
    );
    this.detailScroll = settled.scroll;
    this.detailFollow = settled.follow;
  }

  private scrollPreview(delta: number): void {
    const content = this.detail.contentRows(Math.max(1, this.lastRenderWidth - this.rosterWidthFor(this.lastRenderWidth) - 2));
    const viewport = Math.max(1, this.lastBodyHeight - 2);
    const settled = followScroll(
      { scroll: followScroll({ scroll: this.previewScroll, follow: this.previewFollow }, content, viewport).scroll + delta, follow: false },
      content,
      viewport,
    );
    this.previewScroll = settled.scroll;
    this.previewFollow = settled.follow;
  }

  private rosterWidthFor(width: number): number {
    return Math.max(ROSTER_MIN_WIDTH, Math.min(ROSTER_MAX_WIDTH, Math.floor(width * ROSTER_RATIO)));
  }

  private scrollbarTrack(): { top: number; height: number } {
    return { top: 2, height: Math.max(0, this.lastBodyHeight - 2) };
  }

  private scrollbarMetrics(): ScrollbarMetrics {
    const viewport = Math.max(1, this.lastBodyHeight - 2);
    const content = this.mode === 'detail'
      ? this.detail.contentRows(Math.max(1, this.lastRenderWidth - 2))
      : this.detail.contentRows(Math.max(1, this.lastRenderWidth - this.rosterWidthFor(this.lastRenderWidth) - 2));
    const state = this.mode === 'detail'
      ? { scroll: this.detailScroll, follow: this.detailFollow }
      : { scroll: this.previewScroll, follow: this.previewFollow };
    const settled = followScroll(state, content, viewport);
    return { scrollTop: settled.scroll, viewport, content };
  }

  private scrollPaneTo(target: number): void {
    const metrics = this.scrollbarMetrics();
    const settled = followScroll({ scroll: target, follow: false }, metrics.content, metrics.viewport);
    if (this.mode === 'detail') {
      this.detailScroll = settled.scroll;
      this.detailFollow = settled.follow;
    } else {
      this.previewScroll = settled.scroll;
      this.previewFollow = settled.follow;
    }
  }

  private applyScrollbar(lines: string[], width: number): HitZone | null {
    const track = this.scrollbarTrack();
    const thumb = scrollbarThumb(this.scrollbarMetrics(), track.height);
    if (thumb === null) return null;
    if (this.scrollbar.engaged) {
      const replaced = drawScrollbar(lines.slice(track.top, track.top + track.height), width, thumb, createScrollbarStyle());
      for (const [index, line] of replaced.entries()) lines[track.top + index] = line!;
    }
    return { id: SCROLLBAR_ZONE, row: track.top, col: width, width: 1, height: track.height };
  }

  private renderFooter(width: number): string[] {
    const key = (value: string): string => currentTheme.boldFg('primary', value);
    const dim = (value: string): string => currentTheme.fg('textMuted', value);
    const selected = this.selectedAgent();
    const actionHints = [
      `${key('Alt+X')} ${dim(t('workflows.hint.stop'))}`,
      `${key('Alt+O')} ${dim(t('workflows.hint.output'))}`,
      ...(this.props.onForeground !== undefined && selected?.taskId !== undefined && this.canForeground(selected)
        ? [`${key('Alt+F')} ${dim(t('workflows.hint.foreground'))}`]
        : []),
      `${key('t')} ${dim(t('workflows.hint.thinking'))}`,
    ];
    if (this.pendingStopTaskId !== undefined) {
      actionHints.unshift(currentTheme.fg('warning', t('workflows.intervention.confirmStop')));
    }
    const nav = this.mode === 'detail'
      ? [`${key('←/Esc')} ${dim(t('workflows.hint.back'))}`, `${key('↑↓')} ${dim(t('workflows.hint.scroll'))}`, `${key('q')} ${dim(t('workflows.hint.close'))}`]
      : [`${key('↑↓')} ${dim(t('workflows.hint.select'))}`, `${key('Enter/→')} ${dim(t('workflows.hint.detail'))}`, `${key('q/Esc')} ${dim(t('workflows.hint.close'))}`];
    return [...wrapHint([...nav, ...actionHints], width, '  ').map((line) => fitExactly(line, width))];
  }

  private canForeground(agent: WorkflowAgentInfo): boolean {
    if (agent.taskId === undefined) return false;
    const task = this.props.backgroundTasks?.get(agent.taskId);
    return task === undefined || (task.kind === 'agent' && task.detached !== false);
  }

  private renderFrame(title: string, content: readonly string[], width: number, height: number): string[] {
    if (height < 2 || width < 4) return Array.from({ length: Math.max(0, height) }, () => ' '.repeat(Math.max(0, width)));
    const innerWidth = width - 2;
    const innerHeight = height - 2;
    const titleStyled = currentTheme.boldFg('textStrong', title);
    const titleSegment = `─ ${titleStyled} `;
    const topMid = visibleWidth(titleSegment) <= innerWidth
      ? currentTheme.fg('border', '─ ') + titleStyled + currentTheme.fg('border', ` ${'─'.repeat(Math.max(0, innerWidth - visibleWidth(titleSegment)))}`)
      : currentTheme.fg('border', '─'.repeat(innerWidth));
    const lines = [currentTheme.fg('border', '┌') + topMid + currentTheme.fg('border', '┐')];
    for (let index = 0; index < innerHeight; index++) {
      const line = content[index] ?? '';
      lines.push(currentTheme.fg('border', '│') + fitExactly(line, innerWidth) + currentTheme.fg('border', '│'));
    }
    lines.push(currentTheme.fg('border', `└${'─'.repeat(innerWidth)}┘`));
    return lines;
  }
}
