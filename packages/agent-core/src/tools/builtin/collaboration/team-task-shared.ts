/**
 * Shared helpers for the TeamTask* tools: team-name resolution
 * and caller identity for the shared team task list.
 *
 * Identity comes from the AsyncLocalStorage teammate context — never from
 * tool arguments — so a caller cannot claim or complete work under another
 * teammate's name by passing strings. Outside a teammate the caller is the
 * leader (unrestricted, attributes as 'leader').
 */

import {
  getTeammateContext,
  type TeammateContext,
} from '../../../agent/swarm/teammate-context';
import { TEAM_NAME_PATTERN } from '../../../agent/swarm/team-store';
import type { TeamTask } from '../../../agent/swarm/team-store';
import type { ToolResultDisplayRef } from '../../display';

export interface TeamNameResolution {
  readonly teamName?: string;
  readonly error?: string;
  /** Localization pointer paired with `error`; undefined when there is none. */
  readonly display?: ToolResultDisplayRef;
}

/**
 * Resolve the effective team for a TeamTask* call: the explicit `team_name`
 * argument wins; inside a teammate it defaults to that teammate's team.
 */
export function resolveTeamName(argsTeamName: string | undefined): TeamNameResolution {
  const context = getTeammateContext();
  const teamName = normalizeName(argsTeamName) ?? context?.teamName;
  if (teamName === undefined) {
    return {
      error:
        'team_name is required: pass the team explicitly, or call from a teammate that belongs to one.',
      display: { key: 'toolResult.team.teamNameRequired' },
    };
  }
  if (!TEAM_NAME_PATTERN.test(teamName)) {
    return {
      error: `Invalid team name "${teamName}": use letters, digits, dashes, or underscores, starting with a letter or digit.`,
      display: { key: 'toolResult.team.teamNameInvalid', params: { team: teamName } },
    };
  }
  return { teamName };
}

/** The calling teammate's context, or an error for teammate-only verbs. */
export function requireTeammateCaller(verb: string): {
  context?: TeammateContext;
  error?: string;
  display?: ToolResultDisplayRef;
} {
  const context = getTeammateContext();
  if (context === undefined) {
    return {
      error: `Only a teammate can ${verb} — the claimer identity comes from the teammate runtime context, not from arguments. Leaders assign work at creation time (TeamTaskCreate owner) instead.`,
      display: { key: 'toolResult.teamTask.claimNotTeammate' },
    };
  }
  if (context.teamName === undefined) {
    return {
      error: `Teammate "${context.name}" does not belong to a team, so it cannot ${verb}. Spawn teammates with team_name to give them access to a shared task list.`,
      display: { key: 'toolResult.teamTask.claimNoTeam', params: { name: context.name } },
    };
  }
  return { context };
}

/** Creator attribution for task records. */
export function callerName(): string {
  return getTeammateContext()?.name ?? 'leader';
}

export function normalizeName(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

/** `key: value` record rendering, matching the other list-style tools. */
export function formatTeamTask(task: TeamTask): string {
  const lines = [
    `task_id: ${String(task.id)}`,
    `subject: ${task.subject}`,
    `status: ${task.status}`,
    `owner: ${task.owner ?? ''}`,
    `created_by: ${task.createdBy}`,
  ];
  if (task.description !== undefined && task.description.length > 0) {
    lines.push(`description: ${task.description}`);
  }
  return lines.join('\n');
}

export function formatTeamTaskList(teamName: string, tasks: readonly TeamTask[]): string {
  if (tasks.length === 0) {
    return `Team "${teamName}" has no tasks.`;
  }
  const counts = {
    pending: tasks.filter((task) => task.status === 'pending').length,
    in_progress: tasks.filter((task) => task.status === 'in_progress').length,
    completed: tasks.filter((task) => task.status === 'completed').length,
  };
  const header =
    `Team "${teamName}" tasks ` +
    `(pending: ${String(counts.pending)}, in_progress: ${String(counts.in_progress)}, ` +
    `completed: ${String(counts.completed)}):`;
  return [header, ...tasks.map(formatTeamTask)].join('\n---\n');
}
