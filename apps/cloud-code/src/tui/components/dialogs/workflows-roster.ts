import {
  Container,
  truncateToWidth,
  visibleWidth,
} from '@cloud-code/pi-tui';

import { SELECT_POINTER } from '#/tui/constant/symbols';
import { fitExactly, renderRow } from '#/tui/components/primitives';
import { getLocalePreference, t } from '#/tui/i18n';
import { currentTheme } from '#/tui/theme';
import { highlightBgIf } from '#/tui/utils/mouse-hover';
import { wrapHint } from '#/tui/utils/hint';
import {
  asWorkflowAgentInfo,
  displayName,
  formatDuration,
  isWorkflowAgentAttention,
  isWorkflowAgentTerminal,
  STATUS_ICON,
  statusColor,
  type WorkflowAgentInfo,
} from './workflows-agent-content';
import type { WorkflowAgentNode } from '#/tui/controllers/workflows-tracker';

export type WorkflowsRosterRow =
  | {
      readonly kind: 'team';
      readonly teamName: string;
      readonly collapsed: boolean;
      readonly agentCount: number;
      readonly attentionCount: number;
    }
  | {
      readonly kind: 'done-group';
      readonly teamName: string;
      readonly collapsed: boolean;
      readonly agentCount: number;
    }
  | {
      readonly kind: 'agent';
      readonly teamName: string;
      readonly agent: WorkflowAgentInfo;
    };

export interface WorkflowsRosterProps {
  readonly agents: readonly WorkflowAgentNode[];
  readonly selectedAgentId: string | undefined;
  readonly collapsedTeams: ReadonlySet<string>;
  readonly collapsedDoneTeams: ReadonlySet<string>;
}

export interface WorkflowsRosterRenderOptions {
  readonly width: number;
  readonly height: number;
  readonly hoveredRow?: number | undefined;
}

const DEFAULT_TEAM_KEY = '__workflow_default_team__';

export function workflowTeamName(agent: WorkflowAgentNode): string {
  const teamName = asWorkflowAgentInfo(agent).teamName;
  return teamName === undefined || teamName.length === 0 ? t('workflows.roster.defaultTeam') : teamName;
}

function rowPriority(agent: WorkflowAgentInfo): number {
  if (isWorkflowAgentAttention(agent)) return 0;
  if (isWorkflowAgentTerminal(agent)) return 2;
  return 1;
}

export function buildWorkflowsRosterRows(
  agents: readonly WorkflowAgentNode[],
  collapsedTeams: ReadonlySet<string>,
  collapsedDoneTeams: ReadonlySet<string>,
): WorkflowsRosterRow[] {
  const groups = new Map<string, { name: string; agents: WorkflowAgentInfo[] }>();
  for (const agent of agents) {
    const name = workflowTeamName(agent);
    const key = name === t('workflows.roster.defaultTeam') ? DEFAULT_TEAM_KEY : name;
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, { name, agents: [asWorkflowAgentInfo(agent)] });
    } else {
      existing.agents.push(asWorkflowAgentInfo(agent));
    }
  }

  const rows: WorkflowsRosterRow[] = [];
  for (const { name, agents: groupAgents } of groups.values()) {
    const ordered = groupAgents
      .map((agent, index) => ({ agent, index }))
      .sort((a, b) => {
        const priority = rowPriority(a.agent) - rowPriority(b.agent);
        if (priority !== 0) return priority;
        const aEvent = a.agent.lastEventAt ?? a.agent.startedAt;
        const bEvent = b.agent.lastEventAt ?? b.agent.startedAt;
        return bEvent - aEvent || a.index - b.index;
      })
      .map(({ agent }) => agent);
    const attentionCount = ordered.filter(isWorkflowAgentAttention).length;
    rows.push({
      kind: 'team',
      teamName: name,
      collapsed: collapsedTeams.has(name),
      agentCount: ordered.length,
      attentionCount,
    });
    if (collapsedTeams.has(name)) continue;

    const attention = ordered.filter(isWorkflowAgentAttention);
    const active = ordered.filter(
      (agent) => !isWorkflowAgentTerminal(agent) && !isWorkflowAgentAttention(agent),
    );
    const done = ordered.filter((agent) => agent.status === 'done');
    for (const agent of attention) {
      rows.push({ kind: 'agent', teamName: name, agent });
    }
    for (const agent of active) {
      rows.push({ kind: 'agent', teamName: name, agent });
    }
    if (done.length > 0) {
      const doneCollapsed = collapsedDoneTeams.has(name);
      rows.push({
        kind: 'done-group',
        teamName: name,
        collapsed: doneCollapsed,
        agentCount: done.length,
      });
      if (!doneCollapsed) {
        for (const agent of done) rows.push({ kind: 'agent', teamName: name, agent });
      }
    }
  }
  return rows;
}

export function workflowRosterSelectableRows(
  rows: readonly WorkflowsRosterRow[],
): readonly Extract<WorkflowsRosterRow, { kind: 'agent' }>[] {
  return rows.filter(
    (row): row is Extract<WorkflowsRosterRow, { kind: 'agent' }> => row.kind === 'agent',
  );
}

export function workflowRosterAgentAt(
  rows: readonly WorkflowsRosterRow[],
  rowIndex: number,
): WorkflowAgentInfo | undefined {
  const row = rows[rowIndex];
  return row?.kind === 'agent' ? row.agent : undefined;
}

export class WorkflowsRoster extends Container {
  private props: WorkflowsRosterProps;
  private rows: WorkflowsRosterRow[];
  private hoveredRow: number | undefined;
  private lastRender:
    | {
        readonly width: number;
        readonly height: number;
        readonly nowSecond: number;
        readonly rows: WorkflowsRosterRow[];
        readonly selectedAgentId: string | undefined;
        readonly palette: object;
        readonly locale: string;
        readonly lines: readonly string[];
      }
    | undefined;

  constructor(props: WorkflowsRosterProps) {
    super();
    this.props = props;
    this.rows = buildWorkflowsRosterRows(
      props.agents,
      props.collapsedTeams,
      props.collapsedDoneTeams,
    );
  }

  setProps(props: WorkflowsRosterProps): void {
    const rowsChanged =
      props.agents !== this.props.agents ||
      props.collapsedTeams !== this.props.collapsedTeams ||
      props.collapsedDoneTeams !== this.props.collapsedDoneTeams;
    this.props = props;
    if (rowsChanged) {
      this.rows = buildWorkflowsRosterRows(
        props.agents,
        props.collapsedTeams,
        props.collapsedDoneTeams,
      );
      this.lastRender = undefined;
    }
  }

  setHoveredRow(row: number | undefined): boolean {
    if (this.hoveredRow === row) return false;
    this.hoveredRow = row;
    this.lastRender = undefined;
    return true;
  }

  getRows(): readonly WorkflowsRosterRow[] {
    return this.rows;
  }

  getSelectedAgent(): WorkflowAgentInfo | undefined {
    return this.props.agents.find((agent) => agent.agentId === this.props.selectedAgentId) as
      | WorkflowAgentInfo
      | undefined;
  }

  override render(width: number, height = this.rows.length): string[] {
    const nowSecond = Math.floor(Date.now() / 1000);
    const locale = getLocalePreference();
    const palette = currentTheme.palette;
    const cached = this.lastRender;
    if (
      cached !== undefined &&
      cached.width === width &&
      cached.height === height &&
      cached.nowSecond === nowSecond &&
      cached.rows === this.rows &&
      cached.selectedAgentId === this.props.selectedAgentId &&
      cached.palette === palette &&
      cached.locale === locale
    ) {
      return cached.lines as string[];
    }

    const innerWidth = Math.max(1, width);
    const lines: string[] = [];
    if (this.rows.length === 0) {
      lines.push(currentTheme.fg('textMuted', t('workflows.roster.empty')));
      const hint = t('workflows.roster.emptyHint');
      lines.push(...wrapHint(hint.split(' ').map((word) => currentTheme.fg('textDim', word)), innerWidth, ' '));
    } else {
      for (const [rowIndex, row] of this.rows.entries()) {
        const line =
          row.kind === 'team'
            ? this.renderTeamRow(row, innerWidth)
            : row.kind === 'done-group'
              ? this.renderDoneGroupRow(row, innerWidth)
              : this.renderAgentRow(row.agent, innerWidth);
        lines.push(highlightBgIf(line, this.hoveredRow === rowIndex));
      }
    }
    while (lines.length < height) lines.push('');
    const result = lines.slice(0, Math.max(0, height));
    this.lastRender = {
      width,
      height,
      nowSecond,
      rows: this.rows,
      selectedAgentId: this.props.selectedAgentId,
      palette,
      locale,
      lines: result,
    };
    return result as string[];
  }

  private renderTeamRow(
    row: Extract<WorkflowsRosterRow, { kind: 'team' }>,
    width: number,
  ): string {
    const arrow = row.collapsed ? '▸' : '▾';
    const attention =
      row.attentionCount > 0
        ? currentTheme.fg('warning', ` ${t('workflows.roster.attention', { count: row.attentionCount })}`)
        : '';
    const count = currentTheme.fg('textMuted', ` ${t('workflows.roster.agentCount', { count: row.agentCount })}`);
    return fitExactly(
      `${currentTheme.fg('primary', `${arrow} `)}${currentTheme.boldFg('primary', row.teamName)}${count}${attention}`,
      width,
    );
  }

  private renderDoneGroupRow(
    row: Extract<WorkflowsRosterRow, { kind: 'done-group' }>,
    width: number,
  ): string {
    const arrow = row.collapsed ? '▸' : '▾';
    return fitExactly(
      `  ${currentTheme.fg('textDim', `${arrow} ${t('workflows.roster.doneGroup', { count: row.agentCount })}`)}`,
      width,
    );
  }

  private renderAgentRow(agent: WorkflowAgentInfo, width: number): string {
    const selected = agent.agentId === this.props.selectedAgentId;
    const name = `@${displayName(agent)}`;
    const action = agent.currentActivity?.label ?? t('workflows.activity.idle');
    const subject = agent.taskSubject ?? agent.description ?? t('workflows.roster.noTask');
    const duration = formatDuration(agent);
    const prefix = selected ? `${SELECT_POINTER} ` : '  ';
    const icon = currentTheme.fg(statusColor(agent.status), STATUS_ICON[agent.status]);
    const nameText = `${prefix}${icon} ${name}`;
    const available = Math.max(1, width - 2);
    const gap = 2;
    const durationWidth = Math.max(5, visibleWidth(duration));
    const nameWidth = Math.max(12, Math.min(available - 3 * gap - durationWidth, Math.floor(available * 0.28)));
    const actionWidth = Math.max(8, Math.floor(available * 0.24));
    const subjectWidth = Math.max(
      1,
      available - nameWidth - actionWidth - durationWidth - gap * 3,
    );
    const line = renderRow(
      [
        {
          text: truncateToWidth(nameText, nameWidth, '…'),
          token: selected ? undefined : 'text',
          bold: selected,
          width: nameWidth,
        },
        {
          text: truncateToWidth(action, actionWidth, '…'),
          token: agent.currentActivity?.kind === 'waiting-approval' ? 'warning' : 'text',
          width: actionWidth,
        },
        {
          text: truncateToWidth(subject, subjectWidth, '…'),
          token: 'textDim',
          width: subjectWidth,
        },
        { text: duration, token: 'textMuted', align: 'right', width: durationWidth },
      ],
      { gap },
    );
    return fitExactly(line, width);
  }
}

export function workflowRosterRowIsToggle(row: WorkflowsRosterRow): boolean {
  return row.kind === 'team' || row.kind === 'done-group';
}

export function workflowRosterRowKey(row: WorkflowsRosterRow, index: number): string {
  if (row.kind === 'agent') return row.agent.agentId;
  return `${row.kind}:${row.teamName}:${String(index)}`;
}
