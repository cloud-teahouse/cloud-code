/**
 * EnterWorktreeTool — create an isolated git worktree and switch the session
 * into it. All state and git orchestration lives in `agent.worktree`
 * (WorktreeMode); the cwd switch rides `ConfigState.update({cwd})`, which
 * rebinds kaos, rebuilds every builtin tool against the new root, and
 * journals the replayable records that make the switch resume-safe.
 */

import type { Agent } from '#/agent';
import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import { validateWorktreeSlug } from '../../../agent/worktree/git';
import type { ToolExecution } from '../../../loop/types';
import type { ToolResultDisplayRef } from '../../display';
import { toInputJsonSchema } from '../../support/input-schema';
import DESCRIPTION from './enter-worktree.md?raw';

export const EnterWorktreeInputSchema = z
  .object({
    name: z
      .string()
      .superRefine((value, ctx) => {
        try {
          validateWorktreeSlug(value);
        } catch (error) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      })
      .optional()
      .describe(
        'Optional name for the worktree. Each "/"-separated segment may contain only letters, digits, dots, underscores, and dashes; max 64 chars total. A random name is generated if not provided.',
      ),
    base: z
      .string()
      .optional()
      .describe(
        'Optional git ref (branch, tag, or commit) to start the worktree branch from. Defaults to the current HEAD.',
      ),
  })
  .strict();
export type EnterWorktreeInput = z.infer<typeof EnterWorktreeInputSchema>;

export class EnterWorktreeTool implements BuiltinTool<EnterWorktreeInput> {
  readonly name = 'EnterWorktree' as const;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(EnterWorktreeInputSchema);

  constructor(private readonly agent: Agent) {}

  resolveExecution(args: EnterWorktreeInput): ToolExecution {
    const slug = args.name?.trim();
    return {
      description: slug ? `Creating worktree "${slug}"` : 'Creating a new worktree',
      approvalRule: this.name,
      execute: async () => {
        try {
          const { state, resumed, carriedFiles } = await this.agent.worktree.enter({
            name: args.name,
            base: args.base,
          });
          return {
            output: enteredMessage(state, resumed, carriedFiles),
            display: enteredDisplay(state, resumed, carriedFiles),
          };
        } catch (error) {
          return {
            isError: true,
            output:
              error instanceof Error ? error.message : `Failed to enter worktree: ${String(error)}`,
          };
        }
      },
    };
  }
}

function enteredMessage(
  state: {
    readonly path: string;
    readonly branch: string;
    readonly headCommit: string;
  },
  resumed: boolean,
  carriedFiles: readonly string[],
): string {
  const carried =
    carriedFiles.length > 0
      ? ` Carried ${carriedFiles.length} gitignored ${carriedFiles.length === 1 ? 'file' : 'files'} from the original checkout (.worktreeinclude).`
      : '';
  if (resumed) {
    return (
      `Re-attached to existing worktree at ${state.path} on branch ${state.branch}. ` +
      'The session is now working in the worktree — all tools run there. ' +
      'Use ExitWorktree to leave (keep or remove).'
    );
  }
  return (
    `Created worktree at ${state.path} on branch ${state.branch} ` +
    `(based on ${state.headCommit.slice(0, 12)}).${carried} ` +
    'The session is now working in the worktree — all tools run there. ' +
    'Use ExitWorktree to leave mid-session (keep or remove). If the session ends while inside, ' +
    'the worktree stays on disk with its branch, and resuming the session restores it.'
  );
}

/**
 * Localization pointer for the user-facing rendering of `enteredMessage`.
 * The message above stays English for the model; UIs render the keyed form.
 */
function enteredDisplay(
  state: {
    readonly path: string;
    readonly branch: string;
    readonly headCommit: string;
  },
  resumed: boolean,
  carriedFiles: readonly string[],
): ToolResultDisplayRef {
  if (resumed) {
    return {
      key: 'toolResult.worktree.enter.resumed',
      params: { path: state.path, branch: state.branch },
    };
  }
  const params = {
    path: state.path,
    branch: state.branch,
    base: state.headCommit.slice(0, 12),
  };
  if (carriedFiles.length > 0) {
    return {
      key: 'toolResult.worktree.enter.createdCarried',
      params: { ...params, count: carriedFiles.length },
    };
  }
  return { key: 'toolResult.worktree.enter.created', params };
}
