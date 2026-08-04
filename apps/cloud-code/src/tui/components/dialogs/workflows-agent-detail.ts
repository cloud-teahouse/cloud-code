import { truncateToWidth } from '@cloud-code/pi-tui';

import { formatTokenCount } from '#/utils/usage/usage-format';
import { t } from '#/tui/i18n';
import { currentTheme } from '#/tui/theme';
import {
  asWorkflowAgentInfo,
  displayName,
  formatDuration,
  pushActivityLines,
  singleLine,
  STATUS_LABEL,
  type WorkflowAgentInfo,
} from './workflows-agent-content';
import { workflowNodeTotalTokens } from '#/tui/controllers/workflows-tracker';
import { WorkflowsActivity } from './workflows-activity';

export interface WorkflowsAgentDetailProps {
  readonly agent: WorkflowAgentInfo | undefined;
  readonly thinkingExpanded: boolean;
}

export class WorkflowsAgentDetail {
  private props: WorkflowsAgentDetailProps;
  private readonly activity = new WorkflowsActivity({
    agent: undefined as unknown as WorkflowAgentInfo,
    expanded: false,
  });

  constructor(props: WorkflowsAgentDetailProps) {
    this.props = props;
  }

  setProps(props: WorkflowsAgentDetailProps): void {
    this.props = props;
  }

  render(width: number, height: number): string[] {
    const content = this.renderContent(width);
    const lines = content.slice(0, Math.max(0, height));
    while (lines.length < height) lines.push('');
    return lines;
  }

  contentRows(width: number): number {
    return this.renderContent(width).length;
  }

  private renderContent(width: number): string[] {
    const agent = this.props.agent;
    if (agent === undefined) {
      return [currentTheme.fg('textMuted', t('workflows.detail.empty'))];
    }

    const info = asWorkflowAgentInfo(agent);
    const innerWidth = Math.max(1, width);
    const lines: string[] = [];
    const status = currentTheme.fg(
      info.status === 'failed' || info.status === 'killed' || info.status === 'timed_out' || info.status === 'lost'
        ? 'error'
        : info.currentActivity?.kind === 'waiting-approval'
          ? 'warning'
          : 'textStrong',
      t(STATUS_LABEL[info.status]),
    );
    lines.push(
      currentTheme.boldFg('textStrong', `@${displayName(info)}`) +
        currentTheme.fg('textDim', ' ') +
        status +
        currentTheme.fg('textDim', ` · ${formatDuration(info)}`),
    );

    const task = info.taskSubject ?? info.description ?? t('workflows.detail.noTask');
    lines.push(
      currentTheme.fg('textDim', t('workflows.detail.taskLabel')) +
        currentTheme.fg('text', ` ${truncateToWidth(singleLine(task), Math.max(1, innerWidth - 7), '…')}`),
    );

    const activity = info.currentActivity;
    const now = activity?.label ?? t('workflows.activity.idle');
    lines.push(
      currentTheme.fg('textDim', t('workflows.detail.nowLabel')) +
        currentTheme.fg('text', ` ${truncateToWidth(singleLine(now), Math.max(1, innerWidth - 6), '…')}`),
    );

    const lastOutput = info.lastOutput ?? t('workflows.detail.noOutput');
    lines.push(
      currentTheme.fg('textDim', t('workflows.detail.lastOutputLabel')) +
        currentTheme.fg('text', ` ${truncateToWidth(singleLine(lastOutput), Math.max(1, innerWidth - 13), '…')}`),
    );

    const tokens = workflowNodeTotalTokens(info);
    const context = info.contextTokens === undefined ? t('workflows.detail.notAvailable') : formatTokenCount(info.contextTokens);
    const stats = [
      t('workflows.detail.statStep', { step: info.step }),
      t('workflows.detail.statTools', { count: info.toolCallCount }),
      t('workflows.detail.statTokens', { tokens: formatTokenCount(tokens) }),
      t('workflows.detail.statContext', { tokens: context }),
    ].join(' · ');
    lines.push(currentTheme.fg('textMuted', stats));

    lines.push('');
    lines.push(currentTheme.boldFg('primary', t('workflows.activity.title')));
    this.activity.setProps({ agent: info, expanded: this.props.thinkingExpanded });
    lines.push(...this.activity.render(Math.max(1, innerWidth)));

    if (this.props.thinkingExpanded) {
      lines.push('');
      lines.push(currentTheme.boldFg('primary', t('workflows.detail.chainTitle')));
      const chainLines: string[] = [];
      pushActivityLines(chainLines, info, Math.max(1, innerWidth), true);
      lines.push(...chainLines);
      if (info.thinkingTruncated || info.activityTruncated || info.toolCallCount > info.tools.length) {
        lines.push(currentTheme.fg('textMuted', t('workflows.detail.truncatedHint')));
      }
    }
    if (info.status === 'done' && info.resultSummary !== undefined && info.resultSummary.length > 0) {
      lines.push(currentTheme.fg('success', t('workflows.detail.result', { summary: singleLine(info.resultSummary) })));
    }
    if (
      (info.status === 'failed' || info.status === 'killed' || info.status === 'timed_out' || info.status === 'lost') &&
      info.statusDetail !== undefined &&
      info.statusDetail.length > 0
    ) {
      lines.push(currentTheme.fg('error', t('workflows.detail.error', { message: singleLine(info.statusDetail) })));
    }
    return lines;
  }
}
