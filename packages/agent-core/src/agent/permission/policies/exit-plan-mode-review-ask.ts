import type { Agent } from '../..';
import type { ExitPlanModeStructured } from '@cloud-code/protocol';
import type { ApprovalResponse, PermissionPolicy, PermissionPolicyContext, PermissionPolicyResult } from '../types';

interface ExitPlanModeOption {
  readonly label: string;
  readonly description: string;
}

interface PlanReviewDisplay {
  readonly plan: string;
  readonly path?: string | undefined;
  readonly options?: readonly ExitPlanModeOption[] | undefined;
}

export class ExitPlanModeReviewAskPermissionPolicy implements PermissionPolicy {
  readonly name = 'exit-plan-mode-review-ask';

  constructor(private readonly agent: Agent) {}

  evaluate(context: PermissionPolicyContext): PermissionPolicyResult | undefined {
    if (context.toolCall.name !== 'ExitPlanMode') return;
    if (this.agent.permission.mode === 'auto') return;
    if (!this.agent.planMode.isActive) return;
    const display = context.execution.display;
    if (display?.kind !== 'plan_review') return;
    if (display.plan.trim().length === 0) return;
    return {
      kind: 'ask',
      reason: {
        has_options: display.options !== undefined,
      },
      resolveApproval: (result) =>
        this.exitPlanModeApprovalResult(result, {
          plan: display.plan,
          path: display.path,
          options: display.options,
        }),
    };
  }

  private exitPlanModeApprovalResult(result: ApprovalResponse, display: PlanReviewDisplay) {
    if (result.decision !== 'approved') {
      return this.rejectedExitPlanModeApprovalResult(result);
    }

    const selected = selectedExitPlanModeOption(display.options, result.selectedLabel);

    const failed = this.exitPlanMode();
    if (failed !== undefined) {
      return { kind: 'result' as const, syntheticResult: failed };
    }

    // "Approve and switch mode" variants carry the target mode on the
    // response; apply it only after plan mode actually exited so a failed
    // exit cannot leave the session in a mode the user did not confirm.
    if (result.mode !== undefined && result.mode !== this.agent.permission.mode) {
      this.agent.permission.setMode(result.mode);
    }

    // Feedback attached to an approval (not a rejection) rides along into the
    // plan handoff — lets the user annotate the plan ("also update the
    // README") without a reject + re-plan round-trip.
    const feedback = result.feedback?.trim() ?? '';
    const feedbackSuffix = feedback.length > 0 ? `\n\nUser feedback on this plan: ${feedback}` : '';
    const optionPrefix =
      selected === undefined
        ? ''
        : `Selected approach: ${selected.label}\nExecute ONLY the selected approach. Do not execute any unselected alternatives.\n\n`;
    const savedTo = display.path !== undefined ? `Plan saved to: ${display.path}\n\n` : '';
    const formattedPlan = `Plan mode deactivated. All tools are now available.\n${savedTo}## Approved Plan:\n${display.plan}`;
    const structured: ExitPlanModeStructured = { outcome: 'approved' };
    if (selected !== undefined) structured.chosen = selected.label;
    if (display.path !== undefined) structured.path = display.path;
    if (feedback.length > 0) structured.feedback = feedback;
    return {
      kind: 'result' as const,
      syntheticResult: {
        isError: false,
        output: `Exited plan mode. ${optionPrefix}${formattedPlan}${feedbackSuffix}`,
        structured,
      },
    };
  }

  private rejectedExitPlanModeApprovalResult(result: ApprovalResponse) {
    if (result.decision === 'cancelled') {
      return {
        kind: 'result' as const,
        syntheticResult: {
          isError: false,
          output: 'Plan approval dismissed. Plan mode remains active.',
          structured: { outcome: 'dismissed' } satisfies ExitPlanModeStructured,
          display: { key: 'toolResult.exitPlanMode.dismissed' },
        },
      };
    }

    if (result.selectedLabel === 'Reject and Exit') {
      const failed = this.exitPlanMode();
      return {
        kind: 'result' as const,
        syntheticResult:
          failed ?? {
            isError: true,
            stopTurn: true,
            output: 'Plan rejected by user. Plan mode deactivated.',
            structured: { outcome: 'rejected' } satisfies ExitPlanModeStructured,
          },
      };
    }

    const feedback = result.feedback ?? '';
    if (result.selectedLabel === 'Revise' || feedback.length > 0) {
      const structured: ExitPlanModeStructured =
        feedback.length > 0
          ? { outcome: 'rejected', feedback }
          : { outcome: 'revise_requested' };
      return {
        kind: 'result' as const,
        syntheticResult: {
          isError: false,
          output:
            feedback.length > 0
              ? `User rejected the plan. Feedback:\n\n${feedback}`
              : 'User requested revisions. Plan mode remains active.',
          structured,
          // The revise-requested text renders raw in clients; point them at
          // the localized form. The feedback variant renders through the
          // structured outcome instead (clients show the feedback itself).
          ...(feedback.length === 0
            ? { display: { key: 'toolResult.exitPlanMode.revisionsRequested' } }
            : {}),
        },
      };
    }

    return {
      kind: 'result' as const,
      syntheticResult: {
        isError: true,
        stopTurn: true,
        output: 'Plan rejected by user. Plan mode remains active.',
        structured: { outcome: 'rejected' } satisfies ExitPlanModeStructured,
      },
    };
  }

  private exitPlanMode():
    | { isError: true; output: string; display: { key: string; params: { error: string } } }
    | undefined {
    try {
      this.agent.planMode.exit();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to exit plan mode.';
      return {
        isError: true,
        output: `Failed to exit plan mode: ${message}`,
        display: { key: 'toolResult.exitPlanMode.exitFailed', params: { error: message } },
      };
    }
  }
}

function selectedExitPlanModeOption(
  options: readonly ExitPlanModeOption[] | undefined,
  label: string | undefined,
): ExitPlanModeOption | undefined {
  if (options === undefined || label === undefined) return;
  return options.find((option) => option.label === label);
}
