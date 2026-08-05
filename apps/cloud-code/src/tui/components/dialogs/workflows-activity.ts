import { truncateToWidth, visibleWidth } from '@cloud-code/pi-tui';

import { renderRow } from '#/tui/components/primitives';
import { getLocalePreference, t } from '#/tui/i18n';
import { currentTheme } from '#/tui/theme';
import { asWorkflowAgentInfo, singleLine, type WorkflowAgentInfo } from './workflows-agent-content';
import type { WorkflowActivityEntry } from '#/tui/controllers/workflows-tracker';

export interface WorkflowsActivityProps {
  readonly agent: WorkflowAgentInfo;
  readonly expanded: boolean;
}

function clockTime(timestamp: number): string {
  const date = new Date(timestamp);
  // UTC, not local time: render-parity snapshots must render identically on
  // every machine (CI runs in a different timezone than dev boxes).
  const hh = String(date.getUTCHours()).padStart(2, '0');
  const mm = String(date.getUTCMinutes()).padStart(2, '0');
  const ss = String(date.getUTCSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function activityStage(entry: WorkflowActivityEntry): { label: string; summary: string; token: 'text' | 'textDim' | 'success' | 'error' } {
  if (entry.kind === 'thinking') {
    return {
      label: t('workflows.activity.thinking'),
      summary: t('workflows.activity.thinkingSummary'),
      token: 'textDim',
    };
  }
  if (entry.kind === 'text') {
    return {
      label: t('workflows.activity.reply'),
      summary: singleLine(entry.text),
      token: 'text',
    };
  }
  const tool = entry.tool;
  const status = tool.status === 'failed' ? 'error' : tool.status === 'running' ? 'success' : 'text';
  const result = tool.resultText === undefined ? '' : singleLine(tool.resultText);
  return {
    label: tool.name,
    summary:
      result.length > 0
        ? result
        : tool.status === 'running'
          ? t('workflows.activity.running')
          : singleLine(tool.argsText),
    token: status,
  };
}

function progressLabel(agent: WorkflowAgentInfo): string {
  if (agent.progress === undefined || agent.progress.total <= 0) return '';
  return t('workflows.activity.progress', {
    done: Math.max(0, agent.progress.done),
    total: Math.max(0, agent.progress.total),
  });
}

export function workflowActivitySummary(agent: WorkflowAgentInfo): string {
  const info = asWorkflowAgentInfo(agent);
  if (info.lastOutput !== undefined && info.lastOutput.length > 0) {
    return singleLine(info.lastOutput);
  }
  if (info.statusDetail !== undefined && info.statusDetail.length > 0) {
    return singleLine(info.statusDetail);
  }
  if (info.resultSummary !== undefined && info.resultSummary.length > 0) {
    return singleLine(info.resultSummary);
  }
  return '';
}

/** Timeline renderer for the compact, non-chain-of-thought activity feed. */
export class WorkflowsActivity {
  private props: WorkflowsActivityProps;
  private cache:
    | {
        readonly agent: WorkflowAgentInfo;
        readonly revision: number;
        readonly width: number;
        readonly expanded: boolean;
        readonly palette: object;
        readonly locale: string;
        readonly lines: readonly string[];
      }
    | undefined;

  constructor(props: WorkflowsActivityProps) {
    this.props = props;
  }

  setProps(props: WorkflowsActivityProps): void {
    this.props = props;
  }

  render(width: number): readonly string[] {
    const { agent, expanded } = this.props;
    const locale = getLocalePreference();
    const palette = currentTheme.palette;
    const cached = this.cache;
    if (
      cached !== undefined &&
      cached.agent === agent &&
      cached.revision === agent.revision &&
      cached.width === width &&
      cached.expanded === expanded &&
      cached.palette === palette &&
      cached.locale === locale
    ) {
      return cached.lines;
    }

    const entries = agent.activity;
    const timestamp = agent.lastEventAt ?? agent.startedAt;
    const lines: string[] = [];
    if (entries.length === 0) {
      const current = agent.currentActivity;
      const label = current?.label ?? t('workflows.activity.empty');
      lines.push(this.renderTimelineLine(clockTime(timestamp), current?.toolName ?? t('workflows.activity.stage'), label, width, 'textDim'));
    } else {
      for (const entry of entries) {
        const stage = activityStage(entry);
        const summary = stage.summary.length > 0 ? stage.summary : t('workflows.activity.noResult');
        lines.push(this.renderTimelineLine(clockTime(timestamp), stage.label, summary, width, stage.token));
      }
    }

    const progress = progressLabel(agent);
    const last = workflowActivitySummary(agent);
    if (progress.length > 0 || (agent.status === 'done' && last.length > 0)) {
      const summary = progress.length > 0 ? progress : t('workflows.activity.result');
      lines.push(this.renderTimelineLine(clockTime(timestamp), t('workflows.activity.stage'), summary, width, 'success'));
    }
    if ((agent.status === 'failed' || agent.status === 'killed' || agent.status === 'timed_out' || agent.status === 'lost') && last.length > 0) {
      lines.push(this.renderTimelineLine(clockTime(timestamp), t('workflows.activity.errorStage'), last, width, 'error'));
    }
    if (agent.currentActivity?.kind === 'waiting-approval') {
      lines.push(
        this.renderTimelineLine(
          clockTime(timestamp),
          t('workflows.activity.approvalStage'),
          agent.currentActivity.label,
          width,
          'warning',
        ),
      );
    }

    // `expanded` is part of the cache key so toggling `t` invalidates the
    // detail body even though the compact timeline itself stays dense.
    if (expanded && lines.length === 0) lines.push(currentTheme.fg('textDim', t('workflows.activity.empty')));
    this.cache = {
      agent,
      revision: agent.revision,
      width,
      expanded,
      palette,
      locale,
      lines,
    };
    return lines;
  }

  private renderTimelineLine(
    time: string,
    stage: string,
    summary: string,
    width: number,
    token: 'text' | 'textDim' | 'success' | 'error' | 'warning',
  ): string {
    const gap = 2;
    const timeWidth = Math.max(8, visibleWidth(time));
    const stageWidth = Math.max(8, Math.min(24, Math.floor(Math.max(1, width) * 0.25)));
    const summaryWidth = Math.max(1, width - timeWidth - stageWidth - gap * 2);
    return renderRow(
      [
        { text: time, token: 'textMuted', width: timeWidth },
        { text: truncateToWidth(stage, stageWidth, '…'), token: 'textDim', width: stageWidth },
        { text: truncateToWidth(summary, summaryWidth, '…'), token },
      ],
      { gap },
    );
  }
}
