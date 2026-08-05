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

export interface WorkflowsAgentDetailProps {
  readonly agent: WorkflowAgentInfo | undefined;
}

/**
 * The detail view is a read-only conversation: the parent's prompt opens as
 * the first user message, then the agent's reply stream (text / thinking /
 * tool cards) in the main transcript's visual language. Model and context
 * bars are pinned separately by the host frame (renderAgentStatusBars).
 */
export class WorkflowsAgentDetail {
  private props: WorkflowsAgentDetailProps;

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

    // The parent's prompt opens the conversation as the "user message".
    if (info.prompt !== undefined && info.prompt.trim().length > 0) {
      lines.push('');
      lines.push(currentTheme.fg('textDim', t('workflows.detail.promptLabel')));
      for (const rawLine of info.prompt.trim().split('\n')) {
        lines.push(
          currentTheme.fg('text', truncateToWidth(`❯ ${rawLine}`, innerWidth, '…')),
        );
      }
    } else {
      const task = info.taskSubject ?? info.description;
      if (task !== undefined && task.length > 0) {
        lines.push('');
        lines.push(currentTheme.fg('textDim', t('workflows.detail.promptLabel')));
        lines.push(currentTheme.fg('text', truncateToWidth(`❯ ${singleLine(task)}`, innerWidth, '…')));
      }
    }

    // The approval note stays a pointer to the main UI: approving from here
    // would split the permission surface across two interaction paths.
    if (info.currentActivity?.kind === 'waiting-approval') {
      lines.push('');
      lines.push(
        currentTheme.fg(
          'warning',
          truncateToWidth(t('workflows.detail.approvalReadonly'), innerWidth, '…'),
        ),
      );
    }
    const activity = info.currentActivity;
    if (activity !== undefined && activity.label.length > 0) {
      lines.push(
        currentTheme.fg('textDim', t('workflows.detail.nowLabel')) +
          currentTheme.fg('text', ` ${truncateToWidth(singleLine(activity.label), Math.max(1, innerWidth - 6), '…')}`),
      );
    }

    lines.push('');
    const stream: string[] = [];
    pushActivityLines(stream, info, innerWidth, true);
    lines.push(...stream);
    if (info.thinkingTruncated || info.activityTruncated || info.toolCallCount > info.tools.length) {
      lines.push(currentTheme.fg('textMuted', t('workflows.detail.truncatedHint')));
    }
    if (info.status === 'done' && info.resultSummary !== undefined && info.resultSummary.length > 0) {
      lines.push('');
      lines.push(currentTheme.fg('success', t('workflows.detail.result', { summary: singleLine(info.resultSummary) })));
    }
    if (
      (info.status === 'failed' || info.status === 'killed' || info.status === 'timed_out' || info.status === 'lost') &&
      info.statusDetail !== undefined &&
      info.statusDetail.length > 0
    ) {
      lines.push('');
      lines.push(currentTheme.fg('error', t('workflows.detail.error', { message: singleLine(info.statusDetail) })));
    }
    return lines;
  }
}

/**
 * The two bottom bars of the detail view — model and context of the SELECTED
 * agent (not the main session), mirroring the main status line's vocabulary.
 */
export function renderAgentStatusBars(agent: WorkflowAgentInfo, width: number): string[] {
  const info = asWorkflowAgentInfo(agent);
  const innerWidth = Math.max(1, width);

  const model = info.model ?? t('workflows.detail.notAvailable');
  const modelLine = currentTheme.fg('textDim', t('workflows.detail.statusModel')) +
    currentTheme.fg('text', ` ${truncateToWidth(model, Math.max(1, innerWidth - 8), '…')}`);

  const tokens = workflowNodeTotalTokens(info);
  const context = info.contextTokens;
  const contextText =
    context !== undefined && context > 0
      ? `${formatTokenCount(context)}`
      : tokens > 0
        ? formatTokenCount(tokens)
        : t('workflows.detail.notAvailable');
  const contextLine = currentTheme.fg('textDim', t('workflows.detail.statusContext')) +
    currentTheme.fg('text', ` ${contextText}`);

  return [
    truncateToWidth(modelLine, innerWidth, '…'),
    truncateToWidth(contextLine, innerWidth, '…'),
  ];
}
