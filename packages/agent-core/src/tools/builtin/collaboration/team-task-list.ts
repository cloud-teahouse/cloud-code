/**
 * TeamTaskListTool — read a team's shared task list.
 *
 * Read-only and side-effect-free. The output renders one `key: value`
 * record per task (matching the CronList/TaskList layout) so the model can
 * scan status and ownership at a glance.
 */

import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import type { TeamStore } from '../../../agent/swarm/team-store';
import { ToolAccesses } from '../../../loop/tool-access';
import type { ExecutableToolResult, ToolExecution } from '../../../loop/types';
import { toInputJsonSchema } from '../../support/input-schema';
import { formatTeamTaskList, resolveTeamName } from './team-task-shared';
import TEAM_TASK_LIST_DESCRIPTION from './team-task-list.md?raw';

export const TeamTaskListInputSchema = z
  .object({
    team_name: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe('Team whose task list to read. Defaults to the calling teammate\'s team.'),
  })
  .strict();

export type TeamTaskListInput = z.infer<typeof TeamTaskListInputSchema>;

export class TeamTaskListTool implements BuiltinTool<TeamTaskListInput> {
  readonly name = 'TeamTaskList' as const;
  readonly description = TEAM_TASK_LIST_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(TeamTaskListInputSchema);

  constructor(private readonly teamStore: TeamStore) {}

  resolveExecution(args: TeamTaskListInput): ToolExecution {
    return {
      accesses: ToolAccesses.none(),
      description: 'Listing team tasks',
      approvalRule: this.name,
      execute: () => this.execution(args),
    };
  }

  private async execution(args: TeamTaskListInput): Promise<ExecutableToolResult> {
    const { teamName, error, display } = resolveTeamName(args.team_name);
    if (teamName === undefined) return { output: error!, isError: true, display };

    const tasks = await this.teamStore.listTasks(teamName);
    if (tasks === undefined) {
      return {
        output: `Team "${teamName}" does not exist yet. Create tasks with TeamTaskCreate to start its shared task list.`,
        isError: true,
        display: { key: 'toolResult.teamTask.noTeam', params: { team: teamName } },
      };
    }
    // The record dump (and its empty form) renders raw: per-task `key: value`
    // rows are data for the model, not prose to translate. Only the empty
    // list gets a localized rendering.
    if (tasks.length === 0) {
      return {
        output: formatTeamTaskList(teamName, tasks),
        display: { key: 'toolResult.teamTask.listEmpty', params: { team: teamName } },
      };
    }
    return { output: formatTeamTaskList(teamName, tasks) };
  }
}
