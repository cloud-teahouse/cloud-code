/**
 * UpdateGoalTool — the model's single lever over the goal lifecycle. It updates
 * the goal's status directly; the turn driver reads the status at each turn
 * boundary and stops (`complete` / `blocked`) or keeps going (`active`).
 *
 * The argument is a status enum plus an optional `evidence` list: when the
 * completion gate enforces (docs/phase5/goal-completion-gate.md §3.2),
 * `complete` must cite usable verification receipts by tool call id or the
 * tool returns an error and the goal stays active. The tool stays visible to
 * the main agent even when no goal is active; goal-store operations decide
 * whether a requested transition is valid.
 */

import type { Agent } from '#/agent';
import { z } from 'zod';

import {
  buildGoalBlockedReasonPrompt,
  buildGoalCompletionGateRejectionPrompt,
  buildGoalCompletionSummaryPrompt,
} from './outcome-prompts';
import type { BuiltinTool } from '../../../agent/tool';
import type { ToolExecution } from '../../../loop/types';
import { toInputJsonSchema } from '../../support/input-schema';
import DESCRIPTION from './update-goal.md?raw';

export const UpdateGoalToolInputSchema = z
  .object({
    status: z
      .enum(['active', 'complete', 'blocked'])
      .describe(
        'The lifecycle status to set for the current goal. Use `blocked` for impossible, unsafe, or contradictory objectives, or after the same non-terminal blocking condition repeats for at least 3 consecutive goal turns.',
      ),
    evidence: z
      .array(z.string())
      .optional()
      .describe(
        'Tool call ids of verification results cited when completing a goal (for example, a passing test run). Required when the goal set a completion criterion, involved code changes, or produced tool receipts: the runtime rejects completion that cites unknown, failed, out-of-date, or expired receipts.',
      ),
  })
  .strict();

export type UpdateGoalToolInput = z.infer<typeof UpdateGoalToolInputSchema>;

export class UpdateGoalTool implements BuiltinTool<UpdateGoalToolInput> {
  readonly name = 'UpdateGoal' as const;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(UpdateGoalToolInputSchema);

  constructor(private readonly agent: Agent) {}

  resolveExecution(args: UpdateGoalToolInput): ToolExecution {
    if (!isUpdateGoalStatus(args.status)) {
      return {
        isError: true,
        output: 'Invalid goal status. Use `active`, `complete`, or `blocked`.',
        display: { key: 'toolResult.goal.invalidStatus' },
      };
    }

    const status = args.status;
    const goal = this.agent.goal;
    const currentGoal = goal.getGoal().goal;
    const goalIsActive = currentGoal?.status === 'active';

    return {
      description: `Setting goal status: ${status}`,
      stopBatchAfterThis: status !== 'active' && goalIsActive,
      approvalRule: this.name,
      execute: async () => {
        if (status === 'active') {
          if (currentGoal === null) {
            return { output: 'Goal not resumed: no current goal.' };
          }
          await goal.resumeGoal({}, 'model');
          return { output: 'Goal resumed.' };
        }
        if (status === 'complete') {
          // Completion gate (C2 P2): when the gate enforces, completion must
          // cite usable evidence receipts. A rejection is an ordinary tool
          // error — the goal stays active and the model can re-verify and
          // re-cite later in the same turn.
          const verdict = goal.evaluateCompletionGate(args.evidence ?? []);
          if (!verdict.allowed) {
            return {
              isError: true,
              output: buildGoalCompletionGateRejectionPrompt(verdict),
              // The output is model-facing recovery instructions; users get
              // the concise localized summary instead.
              display: { key: 'toolResult.goal.completionGateRejected' },
            };
          }
          const completed = await goal.markComplete({}, 'model');
          if (completed === null) {
            return { output: 'Goal not completed: no active goal.' };
          }
          const output =
            buildGoalCompletionSummaryPrompt(completed);
          return { output, stopTurn: true };
        }
        if (status === 'blocked') {
          const blocked = await goal.markBlocked({}, 'model');
          if (blocked === null) {
            return { output: 'Goal not blocked: no active goal.' };
          }
          const output =
            buildGoalBlockedReasonPrompt(blocked);
          return { output, stopTurn: true };
        }
        return {
          isError: true,
          output: 'Invalid goal status. Use `active`, `complete`, or `blocked`.',
          display: { key: 'toolResult.goal.invalidStatus' },
        };
      },
    };
  }
}

function isUpdateGoalStatus(status: unknown): status is UpdateGoalToolInput['status'] {
  return status === 'active' || status === 'complete' || status === 'blocked';
}
