/**
 * TaskStopTool — stop a running background task.
 */

import { z } from 'zod';

import type { BuiltinTool } from '../../agent/tool';
import {
  isBackgroundTaskTerminal,
  type BackgroundManager,
} from '../../agent/background';
import type { ExecutableToolResult, ToolExecution } from '../../loop/types';
import { toInputJsonSchema } from '../support/input-schema';
import { matchesGlobRuleSubject } from '../support/rule-match';
import TASK_STOP_DESCRIPTION from './task-stop.md?raw';

// ── Input schema ─────────────────────────────────────────────────────

export const TaskStopInputSchema = z.object({
  task_id: z.string().describe('The background task ID to stop.'),
  reason: z
    .string()
    .default('Stopped by TaskStop')
    .describe('Short reason recorded when the task is stopped.')
    .optional(),
});

export type TaskStopInput = z.Infer<typeof TaskStopInputSchema>;

// ── Implementation ───────────────────────────────────────────────────

export class TaskStopTool implements BuiltinTool<TaskStopInput> {
  readonly name = 'TaskStop' as const;
  readonly description = TASK_STOP_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(TaskStopInputSchema);

  constructor(private readonly manager: BackgroundManager) {}

  resolveExecution(args: TaskStopInput): ToolExecution {
    return {
      description: `Stopping task ${args.task_id}`,
      approvalRule: this.name,
      matchesRule: (ruleArgs) => matchesGlobRuleSubject(ruleArgs, args.task_id),
      execute: async (): Promise<ExecutableToolResult> => {
        const info = this.manager.getTask(args.task_id);
        if (!info) {
          return {
            isError: true,
            output: `Task not found: ${args.task_id}`,
            display: { key: 'toolResult.taskStop.notFound', params: { taskId: args.task_id } },
          };
        }

        // A blank or whitespace-only reason falls back to the default. `?? default`
        // would not cover the empty-string case, so trim and coalesce explicitly.
        const trimmedReason = args.reason?.trim();
        const reason =
          trimmedReason === undefined || trimmedReason.length === 0
            ? 'Stopped by TaskStop'
            : trimmedReason;

        if (isBackgroundTaskTerminal(info.status)) {
          // Already-terminal tasks report their current state using the same
          // structured multi-line format as the normal stop path below.
          const terminalReason = terminalStopReason(info.stopReason);
          return {
            output:
              `task_id: ${info.taskId}\n` +
              `status: ${info.status}\n` +
              // A task persisted by an older build may carry a blank stopReason;
              // `??` would not coalesce `''`, so trim-and-`||` to the placeholder.
              `reason: ${terminalReason}`,
            isError: false,
            structured: { taskId: info.taskId, status: info.status },
            display: {
              key: 'toolResult.taskStop.stopped',
              params: { taskId: info.taskId, status: info.status, reason: terminalReason },
            },
          };
        }

        await this.manager.suppressTerminalNotification(args.task_id);
        const result = await this.manager.stop(args.task_id, reason);
        if (!result) {
          return {
            isError: true,
            output: `Failed to stop task: ${args.task_id}`,
            display: { key: 'toolResult.taskStop.stopFailed', params: { taskId: args.task_id } },
          };
        }

        const stopReason = result.stopReason ?? reason;
        return {
          output:
            `task_id: ${result.taskId}\n` +
            `status: ${result.status}\n` +
            `reason: ${stopReason}`,
          isError: false,
          structured: { taskId: result.taskId, status: result.status },
          display: {
            key: 'toolResult.taskStop.stopped',
            params: { taskId: result.taskId, status: result.status, reason: stopReason },
          },
        };
      },
    };
  }
}

function terminalStopReason(reason: string | undefined): string {
  const trimmed = reason?.trim();
  return trimmed === undefined || trimmed.length === 0 ? 'Task already in terminal state' : trimmed;
}
