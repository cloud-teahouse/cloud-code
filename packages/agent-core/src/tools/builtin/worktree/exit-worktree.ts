/**
 * ExitWorktreeTool — leave the worktree entered via EnterWorktree and restore
 * the original session cwd. The dirty-removal gate runs here in the tool
 * layer (before any mutation); `WorktreeMode.exit` then executes the chosen
 * action atomically enough for the sequential tool loop: a failed
 * `git worktree remove` leaves state and cwd untouched.
 */

import type { Agent } from '#/agent';
import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import type { ToolExecution } from '../../../loop/types';
import type { ToolResultDisplayRef } from '../../display';
import { toInputJsonSchema } from '../../support/input-schema';
import DESCRIPTION from './exit-worktree.md?raw';

export const ExitWorktreeInputSchema = z
  .object({
    action: z
      .enum(['keep', 'remove'])
      .describe('"keep" leaves the worktree and branch on disk; "remove" deletes both.'),
    discard_changes: z
      .boolean()
      .optional()
      .describe(
        'Required true when action is "remove" and the worktree has uncommitted files or unmerged commits. The tool will refuse and list them otherwise.',
      ),
  })
  .strict();
export type ExitWorktreeInput = z.infer<typeof ExitWorktreeInputSchema>;

export class ExitWorktreeTool implements BuiltinTool<ExitWorktreeInput> {
  readonly name = 'ExitWorktree' as const;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(ExitWorktreeInputSchema);

  constructor(private readonly agent: Agent) {}

  resolveExecution(args: ExitWorktreeInput): ToolExecution {
    return {
      description:
        args.action === 'remove'
          ? 'Exiting and removing the worktree'
          : 'Exiting the worktree (keeping it on disk)',
      approvalRule: this.name,
      execute: async () => {
        // Scope guard: WorktreeMode.state is set only by EnterWorktree in
        // THIS session (or restored from this session's own wire records on
        // resume). Manually created worktrees never populate it.
        const session = this.agent.worktree.current;
        if (session === null) {
          return {
            isError: true,
            output:
              'No-op: there is no active EnterWorktree session to exit. This tool only operates on ' +
              'worktrees created by EnterWorktree in the current session — it will not touch worktrees ' +
              'created manually or in a previous session. No filesystem changes were made.',
          };
        }

        if (args.action === 'remove' && args.discard_changes !== true) {
          const summary = await this.agent.worktree.countChanges();
          if (summary === null) {
            return {
              isError: true,
              output:
                `Could not verify worktree state at ${session.path}. Refusing to remove without ` +
                'explicit confirmation. Re-invoke with discard_changes: true to proceed — or use ' +
                'action: "keep" to preserve the worktree.',
            };
          }
          const { changedFiles, commits } = summary;
          if (changedFiles > 0 || commits > 0) {
            const parts: string[] = [];
            if (changedFiles > 0) {
              parts.push(`${changedFiles} uncommitted ${changedFiles === 1 ? 'file' : 'files'}`);
            }
            if (commits > 0) {
              parts.push(`${commits} ${commits === 1 ? 'commit' : 'commits'} on ${session.branch}`);
            }
            return {
              isError: true,
              output:
                `Worktree has ${parts.join(' and ')}. Removing will discard this work permanently. ` +
                'Confirm with the user, then re-invoke with discard_changes: true — or use action: ' +
                '"keep" to preserve the worktree.',
            };
          }
        }

        if (args.action === 'remove') {
          // A subagent anchored inside the worktree keeps working from its
          // spawn-time cwd snapshot; removing the directory would strand it.
          // Unlike the dirty gate this one has no override flag — the fix is
          // to stop the agents or keep the worktree, never to confirm anyway.
          const anchored = await this.agent.subagentHost?.listAgentsAnchoredAt(session.path);
          if (anchored !== undefined && anchored.length > 0) {
            const names = anchored.map((entry) => entry.teammateName ?? entry.agentId).join(', ');
            return {
              isError: true,
              output:
                `Refusing to remove worktree at ${session.path}: ${anchored.length} ` +
                `${anchored.length === 1 ? 'subagent is' : 'subagents are'} still anchored inside ` +
                `it (${names}) and would lose their working directory. Stop them first, or use ` +
                'action: "keep" to preserve the worktree.',
              display: {
                key: 'toolResult.worktree.exit.blockedByAgents',
                params: { path: session.path, count: anchored.length, agents: names },
              },
            };
          }
        }

        try {
          const result = await this.agent.worktree.exit({
            action: args.action,
            discardChanges: args.discard_changes,
          });
          if (result.action === 'keep') {
            return {
              output:
                `Exited worktree. Your work is preserved at ${result.path} on branch ${result.branch}. ` +
                `Session is now back in ${result.originalCwd}.`,
              display: {
                key: 'toolResult.worktree.exit.kept',
                params: {
                  path: result.path,
                  branch: result.branch,
                  cwd: result.originalCwd,
                },
              },
            };
          }
          const discardParts: string[] = [];
          if (result.discardedCommits > 0) {
            discardParts.push(
              `${result.discardedCommits} ${result.discardedCommits === 1 ? 'commit' : 'commits'}`,
            );
          }
          if (result.discardedFiles > 0) {
            discardParts.push(
              `${result.discardedFiles} uncommitted ${result.discardedFiles === 1 ? 'file' : 'files'}`,
            );
          }
          const discardNote =
            discardParts.length > 0 ? ` Discarded ${discardParts.join(' and ')}.` : '';
          return {
            output:
              `Exited and removed worktree at ${result.path}.${discardNote} ` +
              `Session is now back in ${result.originalCwd}.`,
            display: removedDisplay(result, discardParts.length > 0),
          };
        } catch (error) {
          return {
            isError: true,
            output:
              error instanceof Error ? error.message : `Failed to exit worktree: ${String(error)}`,
          };
        }
      },
    };
  }
}

/**
 * Localization pointer for the remove-branch rendering. The emitted output
 * stays English for the model; UIs render the keyed form, with the discard
 * counts riding as params (label-style in the templates, so no English
 * plural agreement is needed).
 */
function removedDisplay(
  result: {
    readonly path: string;
    readonly originalCwd: string;
    readonly discardedCommits: number;
    readonly discardedFiles: number;
  },
  hasDiscards: boolean,
): ToolResultDisplayRef {
  if (!hasDiscards) {
    return {
      key: 'toolResult.worktree.exit.removed',
      params: { path: result.path, cwd: result.originalCwd },
    };
  }
  return {
    key: 'toolResult.worktree.exit.removedWithDiscards',
    params: {
      path: result.path,
      cwd: result.originalCwd,
      commits: result.discardedCommits,
      files: result.discardedFiles,
    },
  };
}
