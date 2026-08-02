/**
 * TeamTaskUpdateTool — mutate one task on a team's shared task list.
 *
 * Status transitions are deliberately permissive (any enum value may be
 * set); the guardrail is ownership: a teammate may only touch tasks it owns
 * and may never reassign, while the leader is unrestricted. Ownership is
 * read from the AsyncLocalStorage teammate context, so it cannot be forged
 * through arguments.
 */

import { z } from 'zod';

import { getTeammateContext } from '../../../agent/swarm/teammate-context';
import type { BuiltinTool } from '../../../agent/tool';
import type { TeamStore } from '../../../agent/swarm/team-store';
import { ToolAccesses } from '../../../loop/tool-access';
import type { ExecutableToolResult, ToolExecution } from '../../../loop/types';
import { toInputJsonSchema } from '../../support/input-schema';
import { formatTeamTask, normalizeName, resolveTeamName } from './team-task-shared';
import TEAM_TASK_UPDATE_DESCRIPTION from './team-task-update.md?raw';

export const TeamTaskUpdateInputSchema = z
  .object({
    team_name: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe('Team owning the task. Defaults to the calling teammate\'s team.'),
    task_id: z.number().int().positive().describe('Id of the task to update (the `#N` from TeamTaskList).'),
    status: z
      .enum(['pending', 'in_progress', 'completed'])
      .optional()
      .describe('New status for the task.'),
    owner: z
      .string()
      .optional()
      .describe(
        'Reassign the task to another teammate name (leader only). Pass an empty string to clear the owner.',
      ),
    subject: z.string().trim().min(1).optional().describe('Replacement task title.'),
    description: z.string().optional().describe('Replacement task spec.'),
  })
  .strict();

export type TeamTaskUpdateInput = z.infer<typeof TeamTaskUpdateInputSchema>;

export class TeamTaskUpdateTool implements BuiltinTool<TeamTaskUpdateInput> {
  readonly name = 'TeamTaskUpdate' as const;
  readonly description = TEAM_TASK_UPDATE_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(TeamTaskUpdateInputSchema);

  constructor(private readonly teamStore: TeamStore) {}

  resolveExecution(args: TeamTaskUpdateInput): ToolExecution {
    return {
      accesses: ToolAccesses.none(),
      description: `Updating team task #${String(args.task_id)}`,
      approvalRule: this.name,
      execute: () => this.execution(args),
    };
  }

  private async execution(args: TeamTaskUpdateInput): Promise<ExecutableToolResult> {
    const { teamName, error, display } = resolveTeamName(args.team_name);
    if (teamName === undefined) return { output: error!, isError: true, display };

    if (
      args.status === undefined &&
      args.owner === undefined &&
      args.subject === undefined &&
      args.description === undefined
    ) {
      return {
        output: 'Nothing to update: pass at least one of status, owner, subject, description.',
        isError: true,
        display: { key: 'toolResult.teamTask.nothingToUpdate' },
      };
    }

    const task = await this.teamStore.getTask(teamName, args.task_id);
    if (task === undefined) {
      return {
        output: `Task #${String(args.task_id)} was not found in team "${teamName}".`,
        isError: true,
        display: {
          key: 'toolResult.teamTask.notFound',
          params: { id: args.task_id, team: teamName },
        },
      };
    }

    // Ownership guard: a teammate operates only on its own tasks and never
    // reassigns; everyone else (the leader) is unrestricted.
    const caller = getTeammateContext();
    if (caller !== undefined) {
      if (task.owner !== caller.name) {
        return {
          output: `Task #${String(args.task_id)} is owned by "${task.owner ?? 'nobody'}", not by you ("${caller.name}"). Teammates can only update their own tasks.`,
          isError: true,
          display: {
            key: 'toolResult.teamTask.ownedByOther',
            params: { id: args.task_id, owner: task.owner ?? 'nobody', caller: caller.name },
          },
        };
      }
      if (args.owner !== undefined && normalizeName(args.owner) !== caller.name) {
        return {
          output: 'Teammates cannot reassign task ownership. Ask the leader to reassign it.',
          isError: true,
          display: { key: 'toolResult.teamTask.cannotReassign' },
        };
      }
    }

    const updated = await this.teamStore.updateTask(teamName, args.task_id, {
      status: args.status,
      // Explicit owner '' clears the assignment (store-level null sentinel);
      // an absent owner field leaves it untouched.
      owner: args.owner === undefined ? undefined : (normalizeName(args.owner) ?? null),
      subject: args.subject,
      description: args.description,
    });
    if (updated === undefined) {
      return {
        output: `Task #${String(args.task_id)} was not found in team "${teamName}".`,
        isError: true,
        display: {
          key: 'toolResult.teamTask.notFound',
          params: { id: args.task_id, team: teamName },
        },
      };
    }
    return {
      output: `Updated task #${String(updated.id)} in team "${teamName}":\n${formatTeamTask(updated)}`,
      display: {
        key: 'toolResult.teamTask.updated',
        params: { id: updated.id, team: teamName, subject: updated.subject },
      },
    };
  }
}
