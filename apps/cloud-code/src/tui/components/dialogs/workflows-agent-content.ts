/**
 * workflows-agent-content — shared rendering idioms for the `/workflows`
 * browser: status icon/label/colour maps (aligned with the teams browser's
 * liveness idioms), the per-agent header block (status line with step,
 * tokens, tool count, model and elapsed time plus task/result/error
 * detail) and the chain-of-thought activity stream (thinking segments
 * interleaved with tool calls, replayed by `WorkflowTracker`).
 *
 * Both consumers live in `workflows-browser.ts`: the list-mode preview
 * pane renders the "flat" variant (dense, one line per piece — the frame
 * truncates), the full-width detail view renders the "wrapped" variant.
 * Pure string builders, no layout or input state, so they stay trivially
 * unit-testable.
 */

import { visibleWidth, wrapTextWithAnsi } from '@cloud-code/pi-tui';

import { formatTokenCount } from '#/utils/usage/usage-format';
import { MAIN_AGENT_ID } from '#/tui/constant/cloud-code-tui';
import { t, type MessageKey } from '#/tui/i18n';
import { currentTheme } from '#/tui/theme';
import {
  workflowNodeTotalTokens,
  type WorkflowAgentNode,
  type WorkflowAgentStatus,
  type WorkflowToolEntry,
} from '#/tui/controllers/workflows-tracker';

/** Glyph marking a thinking line in the activity stream. */
const THINKING_GLYPH = '✻';

/** Most recent activity entries shown by the flat (preview) variant. */
const ACTIVITY_FLAT_ENTRIES = 8;

export const STATUS_LABEL: Record<WorkflowAgentStatus, MessageKey> = {
  idle: 'workflows.status.idle',
  waiting: 'workflows.status.waiting',
  running: 'workflows.status.running',
  suspended: 'workflows.status.suspended',
  done: 'workflows.status.done',
  failed: 'workflows.status.failed',
  killed: 'workflows.status.killed',
  timed_out: 'workflows.status.timed_out',
  lost: 'workflows.status.lost',
};

export const STATUS_ICON: Record<WorkflowAgentStatus, string> = {
  idle: '○',
  waiting: '◌',
  running: '●',
  suspended: '◐',
  done: '✓',
  failed: '✗',
  killed: '✗',
  timed_out: '◐',
  lost: '◌',
};

export function statusColor(
  status: WorkflowAgentStatus,
): 'success' | 'textMuted' | 'error' | 'warning' {
  switch (status) {
    case 'running':
      return 'success';
    case 'suspended':
    case 'timed_out':
    case 'lost':
      return 'warning';
    case 'failed':
    case 'killed':
      return 'error';
    case 'done':
      return 'success';
    case 'idle':
    case 'waiting':
      return 'textMuted';
  }
}

export function singleLine(text: string): string {
  return text.replaceAll(/\s+/g, ' ').trim();
}

export function formatDuration(node: WorkflowAgentNode): string {
  const end = node.endedAt ?? Date.now();
  const totalSeconds = Math.floor(Math.max(0, end - node.startedAt) / 1000);
  if (totalSeconds < 60) return t('workflows.duration.seconds', { count: totalSeconds });
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) {
    return t('workflows.duration.minutes', { minutes, seconds: totalSeconds % 60 });
  }
  return t('workflows.duration.hours', { hours: Math.floor(minutes / 60), minutes: minutes % 60 });
}

export function displayName(node: WorkflowAgentNode): string {
  return node.agentId === MAIN_AGENT_ID ? t('workflows.tree.mainLabel') : node.name;
}

/** The stream no longer shows everything the tracker kept. */
export function activityTruncationHintNeeded(node: WorkflowAgentNode): boolean {
  return (
    node.thinkingTruncated || node.activityTruncated || node.toolCallCount > node.tools.length
  );
}

function pushWrapped(lines: string[], text: string, innerWidth: number, indent: string): void {
  const budget = Math.max(1, innerWidth - visibleWidth(indent));
  for (const wrapped of wrapTextWithAnsi(text, budget)) {
    lines.push(indent + wrapped);
  }
}

/** Emit one logical line, wrapped in detail mode, frame-truncated otherwise. */
function pushLine(lines: string[], text: string, innerWidth: number, wrap: boolean): void {
  if (wrap) {
    pushWrapped(lines, text, innerWidth, '');
    return;
  }
  lines.push(text);
}

// ── agent header block ─────────────────────────────────────────────────

/**
 * Name line + status line (`● running · step 2 · 4k tok · 8 tools · 1m 5s ·
 * model-id`) + optional task/result/error/suspend/terminate detail lines.
 */
export function pushAgentHeaderLines(
  lines: string[],
  node: WorkflowAgentNode,
  innerWidth: number,
  wrap: boolean,
): void {
  const swarmBadge = node.swarmIndex === undefined ? '' : `#${node.swarmIndex} `;
  pushLine(lines, currentTheme.boldFg('textStrong', swarmBadge + displayName(node)), innerWidth, wrap);

  const statusSegments: string[] = [
    currentTheme.fg(
      statusColor(node.status),
      `${STATUS_ICON[node.status]} ${t(STATUS_LABEL[node.status])}`,
    ),
  ];
  if (node.step > 0) {
    statusSegments.push(currentTheme.fg('text', t('workflows.detail.step', { step: node.step })));
  }
  const tokens = workflowNodeTotalTokens(node);
  if (tokens > 0) {
    statusSegments.push(
      currentTheme.fg('text', t('workflows.detail.tokens', { tokens: formatTokenCount(tokens) })),
    );
  }
  if (node.toolCallCount > 0) {
    statusSegments.push(
      currentTheme.fg('text', t('workflows.detail.toolCount', { count: node.toolCallCount })),
    );
  }
  statusSegments.push(currentTheme.fg('textMuted', formatDuration(node)));
  if (node.model !== undefined && node.model.length > 0) {
    statusSegments.push(currentTheme.fg('textDim', node.model));
  }
  lines.push(statusSegments.join(currentTheme.fg('textDim', ' · ')));

  if (node.description !== undefined && node.description.length > 0) {
    pushLine(
      lines,
      currentTheme.fg(
        'textMuted',
        t('workflows.detail.task', { description: singleLine(node.description) }),
      ),
      innerWidth,
      wrap,
    );
  }
  if (node.status === 'done' && node.resultSummary !== undefined && node.resultSummary.length > 0) {
    pushLine(
      lines,
      currentTheme.fg(
        'textMuted',
        t('workflows.detail.result', { summary: singleLine(node.resultSummary) }),
      ),
      innerWidth,
      wrap,
    );
  }
  if (node.statusDetail !== undefined && node.status === 'failed') {
    pushLine(
      lines,
      currentTheme.fg('error', t('workflows.detail.error', { message: singleLine(node.statusDetail) })),
      innerWidth,
      wrap,
    );
  }
  if (node.statusDetail !== undefined && node.status === 'suspended') {
    pushLine(
      lines,
      currentTheme.fg(
        'warning',
        t('workflows.detail.suspendedReason', { reason: singleLine(node.statusDetail) }),
      ),
      innerWidth,
      wrap,
    );
  }
  // killed / timed_out / lost carry a free-form stop reason with no label.
  if (
    node.statusDetail !== undefined &&
    (node.status === 'killed' || node.status === 'timed_out' || node.status === 'lost')
  ) {
    pushLine(
      lines,
      currentTheme.fg(statusColor(node.status), singleLine(node.statusDetail)),
      innerWidth,
      wrap,
    );
  }
}

// ── chain-of-thought activity stream ───────────────────────────────────

/**
 * The agent's recent activity, oldest first: thinking segments (dim, `✻`)
 * interleaved with tool calls (status icon, name, compact args, tree-gutter
 * result). Flat mode keeps the last few entries dense for the preview
 * pane; wrapped mode renders the full kept stream for the detail view.
 */
export function pushActivityLines(
  lines: string[],
  node: WorkflowAgentNode,
  innerWidth: number,
  wrap: boolean,
): void {
  if (node.activity.length === 0) {
    lines.push(currentTheme.fg('textDim', t('workflows.detail.activityEmpty')));
    return;
  }
  const entries = wrap ? node.activity : node.activity.slice(-ACTIVITY_FLAT_ENTRIES);
  for (const entry of entries) {
    if (entry.kind === 'thinking') {
      pushThinkingSegment(lines, entry.text, innerWidth, wrap);
    } else {
      pushToolActivity(lines, entry.tool, innerWidth, wrap);
    }
  }
}

function pushThinkingSegment(
  lines: string[],
  text: string,
  innerWidth: number,
  wrap: boolean,
): void {
  const segment = text.trim();
  if (segment.length === 0) return;
  const rawLines = segment.split('\n');
  // Flat mode shows just the segment's last line: the preview is a dense
  // tail, and the full segment is one keystroke away in the detail view.
  const visible = wrap ? rawLines : rawLines.slice(-1);
  let first = true;
  for (const rawLine of visible) {
    const prefix = first ? `${THINKING_GLYPH} ` : '  ';
    first = false;
    pushLine(
      lines,
      currentTheme.fg('textDim', prefix + singleLine(rawLine)),
      innerWidth,
      wrap,
    );
  }
}

function pushToolActivity(
  lines: string[],
  entry: WorkflowToolEntry,
  innerWidth: number,
  wrap: boolean,
): void {
  const icon = entry.status === 'running' ? '●' : entry.status === 'failed' ? '✗' : '✓';
  const color =
    entry.status === 'running' ? 'success' : entry.status === 'failed' ? 'error' : 'textMuted';
  const argsSummary = singleLine(entry.argsText);
  const suffix = entry.status === 'running' ? ` (${t('workflows.detail.toolRunning')})` : '';
  if (wrap) {
    pushWrapped(
      lines,
      `${currentTheme.fg(color, icon)} ${currentTheme.fg('text', entry.name)}${currentTheme.fg('textDim', suffix)}`,
      innerWidth,
      '',
    );
    if (argsSummary.length > 0) {
      pushWrapped(lines, currentTheme.fg('textDim', argsSummary), innerWidth, '   ');
    }
  } else {
    const argsSegment = argsSummary.length > 0 ? ` ${argsSummary}` : '';
    lines.push(
      `${currentTheme.fg(color, icon)} ${currentTheme.fg('text', `${entry.name}${argsSegment}`)}${currentTheme.fg('textDim', suffix)}`,
    );
  }
  if (entry.status !== 'running' && entry.resultText !== undefined) {
    const result = singleLine(entry.resultText);
    if (result.length > 0) {
      pushLine(lines, currentTheme.fg('textDim', `  └─ ${result}`), innerWidth, wrap);
    }
  }
}
