/**
 * TeamTaskCreateTool — add a task to a team's shared task list.
 *
 * The leader uses it to seed the work queue (optionally pre-assigned via
 * `owner`); teammates may also file follow-up tasks into their own team.
 * The team file is created on first write, so task creation never depends
 * on a separate team-setup step.
 */

import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import type { MailboxService } from '../../../agent/swarm/mailbox-service';
import type { TeamStore } from '../../../agent/swarm/team-store';
import { ToolAccesses } from '../../../loop/tool-access';
import type { ExecutableToolResult, ToolExecution } from '../../../loop/types';
import { toInputJsonSchema } from '../../support/input-schema';
import {
  callerName,
  formatTeamTask,
  normalizeName,
  resolveTeamName,
} from './team-task-shared';
import TEAM_TASK_CREATE_DESCRIPTION from './team-task-create.md?raw';

export const TeamTaskCreateInputSchema = z
  .object({
    team_name: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe('Team owning the task list. Defaults to the calling teammate\'s team.'),
    subject: z.string().trim().min(1).describe('Short task title (one line).'),
    description: z
      .string()
      .optional()
      .describe('Full task spec for whoever picks it up — they have not seen this conversation.'),
    owner: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        'Teammate name to assign the task to directly. Omit to leave the task claimable by any teammate.',
      ),
  })
  .strict();

export type TeamTaskCreateInput = z.infer<typeof TeamTaskCreateInputSchema>;

export class TeamTaskCreateTool implements BuiltinTool<TeamTaskCreateInput> {
  readonly name = 'TeamTaskCreate' as const;
  readonly description = TEAM_TASK_CREATE_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(TeamTaskCreateInputSchema);

  constructor(
    private readonly teamStore: TeamStore,
    private readonly mailbox?: MailboxService | undefined,
  ) {}

  resolveExecution(args: TeamTaskCreateInput): ToolExecution {
    return {
      accesses: ToolAccesses.none(),
      description: `Creating team task: ${args.subject}`,
      approvalRule: this.name,
      execute: () => this.execution(args),
    };
  }

  private async execution(args: TeamTaskCreateInput): Promise<ExecutableToolResult> {
    const { teamName, error, display } = resolveTeamName(args.team_name);
    if (teamName === undefined) return { output: error!, isError: true, display };

    const createdBy = callerName();
    const owner = normalizeName(args.owner);
    const task = await this.teamStore.createTask(teamName, {
      subject: args.subject.trim(),
      description: normalizeName(args.description),
      owner,
      createdBy,
    });
    // A directly-assigned task reaches the assignee
    // through their mailbox instead of waiting for them to re-list the queue.
    // The task itself is already durable — a delivery failure must not fail
    // the create, so the notification is best-effort.
    if (owner !== undefined && this.mailbox !== undefined) {
      await this.mailbox
        .sendTaskAssignment(teamName, createdBy, owner, {
          taskId: task.id,
          subject: task.subject,
          description: task.description,
          assignedBy: createdBy,
        })
        .catch(() => {});
    }
    return {
      output: `Created task #${String(task.id)} in team "${teamName}":\n${formatTeamTask(task)}`,
      display: {
        key: 'toolResult.teamTask.created',
        params: { id: task.id, team: teamName, subject: task.subject },
      },
    };
  }
}
