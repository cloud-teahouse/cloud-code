/**
 * TeamTaskClaimTool — `tryClaimNextTask` as a tool: the
 * teammate pulls the next available task off the team's shared list.
 *
 * The claim is atomic at the store (one read-modify-write under the team
 * queue), and the claimer identity comes from the AsyncLocalStorage
 * teammate context — no parameter threading, no forged attribution.
 */

import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import type { TeamStore } from '../../../agent/swarm/team-store';
import { ToolAccesses } from '../../../loop/tool-access';
import type { ExecutableToolResult, ToolExecution } from '../../../loop/types';
import { toInputJsonSchema } from '../../support/input-schema';
import { normalizeName, requireTeammateCaller, resolveTeamName } from './team-task-shared';
import TEAM_TASK_CLAIM_DESCRIPTION from './team-task-claim.md?raw';

export const TeamTaskClaimInputSchema = z
  .object({
    team_name: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe('Team to claim from. Defaults to the calling teammate\'s team.'),
  })
  .strict();

export type TeamTaskClaimInput = z.infer<typeof TeamTaskClaimInputSchema>;

export class TeamTaskClaimTool implements BuiltinTool<TeamTaskClaimInput> {
  readonly name = 'TeamTaskClaim' as const;
  readonly description = TEAM_TASK_CLAIM_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(TeamTaskClaimInputSchema);

  constructor(private readonly teamStore: TeamStore) {}

  resolveExecution(args: TeamTaskClaimInput): ToolExecution {
    return {
      accesses: ToolAccesses.none(),
      description: 'Claiming the next team task',
      approvalRule: this.name,
      execute: () => this.execution(args),
    };
  }

  private async execution(args: TeamTaskClaimInput): Promise<ExecutableToolResult> {
    const { context, error: callerError, display: callerDisplay } = requireTeammateCaller('claim tasks');
    if (context === undefined) return { output: callerError!, isError: true, display: callerDisplay };

    const { teamName, error, display } = resolveTeamName(normalizeName(args.team_name));
    if (teamName === undefined) return { output: error!, isError: true, display };

    const claimed = await this.teamStore.claimNextTask(teamName, context.name);
    if (claimed === undefined) {
      return {
        output:
          `No claimable tasks in team "${teamName}" — the queue is empty, or every pending task ` +
          'already has an owner. Report back to the leader instead of polling in a loop.',
        display: { key: 'toolResult.teamTask.noneClaimable', params: { team: teamName } },
      };
    }

    const lines = [
      `Claimed task #${String(claimed.id)} in team "${teamName}" (owner: ${context.name}, status: in_progress).`,
      '',
      claimed.subject,
    ];
    if (claimed.description !== undefined && claimed.description.length > 0) {
      lines.push('', claimed.description);
    }
    lines.push(
      '',
      'Treat this as your new objective. When the work is done, mark the task completed with TeamTaskUpdate.',
    );
    return {
      output: lines.join('\n'),
      display: {
        key: 'toolResult.teamTask.claimed',
        params: { id: claimed.id, team: teamName, owner: context.name, subject: claimed.subject },
      },
    };
  }
}
