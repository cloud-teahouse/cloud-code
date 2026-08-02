/**
 * `<task-notification>` rendering: while coordinator mode is
 * active, a finished worker (background agent task) reports back to the main
 * thread as a user-role message carrying this XML — Claude Code's
 * coordinatorMode.ts schema, reusing the BackgroundManager notification
 * delivery path (steer / restore / dedup) unchanged.
 *
 * The `<task-notification>` opening tag is load-bearing: the coordinator
 * system prompt teaches the model to distinguish these from real user
 * messages by it. Statuses collapse onto the schema's three values —
 * `timed_out` and `lost` are reported as `failed`, with the summary keeping
 * the precise cause.
 */

import { inputTotal, type TokenUsage } from '@cloud-code/kosong';

import { escapeXmlTags } from '#/utils/xml-escape';
import type { BackgroundTaskStatus } from '../background/task';

export type TaskNotificationStatus = 'completed' | 'failed' | 'killed';

export interface TaskNotificationData {
  /** Worker agent id — the value Agent's `resume` parameter accepts. */
  readonly agentId: string;
  readonly status: BackgroundTaskStatus;
  /** Human-readable outcome line, e.g. `Agent "..." completed` or `failed: {error}`. */
  readonly summary: string;
  /** Worker's final text response; omitted when empty. */
  readonly result?: string | undefined;
  readonly usage?: TokenUsage | undefined;
  /** Tool calls the worker dispatched; rendered as `<tool_uses>` alongside tokens. */
  readonly toolUses?: number | undefined;
  /** Wall-clock runtime; omitted when the task never started. */
  readonly durationMs?: number | undefined;
}

export function mapTaskNotificationStatus(status: BackgroundTaskStatus): TaskNotificationStatus {
  switch (status) {
    case 'completed':
      return 'completed';
    case 'killed':
      return 'killed';
    default:
      // failed / timed_out / lost — the summary carries the precise cause.
      return 'failed';
  }
}

export function renderTaskNotification(data: TaskNotificationData): string {
  const lines = [
    '<task-notification>',
    `<task-id>${escapeXmlTags(data.agentId)}</task-id>`,
    `<status>${mapTaskNotificationStatus(data.status)}</status>`,
    `<summary>${escapeXmlTags(data.summary)}</summary>`,
  ];
  if (data.result !== undefined && data.result.length > 0) {
    lines.push(`<result>${escapeXmlTags(data.result)}</result>`);
  }
  const usageLines = renderUsage(data.usage, data.toolUses, data.durationMs);
  lines.push(...usageLines, '</task-notification>');
  return lines.join('\n');
}

function renderUsage(
  usage: TokenUsage | undefined,
  toolUses: number | undefined,
  durationMs: number | undefined,
): string[] {
  const totalTokens = usage === undefined ? undefined : totalTokenCount(usage);
  if (totalTokens === undefined && toolUses === undefined && durationMs === undefined) return [];
  const lines = ['<usage>'];
  if (totalTokens !== undefined) lines.push(`<total_tokens>${String(totalTokens)}</total_tokens>`);
  // Field order matches Claude Code's schema: tokens, tool uses, duration.
  if (toolUses !== undefined) lines.push(`<tool_uses>${String(toolUses)}</tool_uses>`);
  if (durationMs !== undefined) lines.push(`<duration_ms>${String(durationMs)}</duration_ms>`);
  lines.push('</usage>');
  return lines;
}

function totalTokenCount(usage: TokenUsage): number {
  return inputTotal(usage) + usage.output;
}
