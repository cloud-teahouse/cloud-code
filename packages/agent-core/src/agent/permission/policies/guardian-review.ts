/**
 * Guardian review permission policy (F3). Sits after the deny policies and
 * the session approval history, before `AutoModeApprovePermissionPolicy`:
 * in `auto` mode, the actions that reach it are exactly those no deny rule
 * stopped, no human session grant covers, and auto mode would otherwise
 * silently approve — the guardian's review domain (design doc §1.1).
 * Default-approved read-only tools pass through untouched. `manual` and
 * `yolo` modes never route here.
 *
 * Fail-closed semantics (design doc §1.4, §3):
 * - reviewer allow → approve (never memorized as a session rule — an AI grant
 *   is a one-shot, unlike a human "approve for session");
 * - reviewer deny → deny with the rationale and anti-circumvention
 *   instructions, counted by the circuit breaker;
 * - review failure (timeout/parse/session) → interactive: fall back to a
 *   human `ask`; headless: deny, because the headless `ask` path auto-approves
 *   (fail-open) and must be avoided. Failures never count toward the breaker;
 * - breaker tripped (per turn) → no more model calls this turn: `ask`
 *   interactively, deny headless.
 */

import type { Agent } from '../..';
import type { AgentRecordOf } from '../../records';
import {
  GuardianCircuitBreaker,
  GUARDIAN_DENIAL_WINDOW_SIZE,
  GUARDIAN_MAX_CONSECUTIVE_DENIALS,
  GUARDIAN_MAX_WINDOW_DENIALS,
  type GuardianCircuitBreakerTrip,
} from '../../guardian/circuit-breaker';
import type { GuardianAssessment } from '../../guardian/assessment';
import {
  GuardianReviewer,
  type GuardianReviewFailureKind,
  type GuardianReviewResult,
} from '../../guardian/reviewer';
import type {
  PermissionPolicy,
  PermissionPolicyContext,
  PermissionPolicyResult,
} from '../types';
import { DEFAULT_APPROVE_TOOLS, SESSION_TRANSPORT_TOOLS } from './default-tool-approve';

/** codex `GUARDIAN_REJECTION_INSTRUCTIONS` (review.rs:51-57). */
const GUARDIAN_REJECTION_INSTRUCTIONS =
  'The agent must not attempt to achieve the same outcome via workaround, indirect execution, or policy circumvention. ' +
  'Proceed only with a materially safer alternative, or if the user explicitly approves the action after being informed of the risk. ' +
  'Otherwise, stop and request user input.';

export class GuardianReviewPermissionPolicy implements PermissionPolicy {
  readonly name = 'guardian-review';

  private readonly reviewer: GuardianReviewer;
  private readonly breaker: GuardianCircuitBreaker;
  private lastTurnId: string | undefined;

  constructor(private readonly agent: Agent) {
    this.reviewer = new GuardianReviewer(agent);
    const config = agent.kimiConfig?.guardian;
    this.breaker = new GuardianCircuitBreaker({
      maxConsecutiveDenials: config?.maxConsecutiveDenials ?? GUARDIAN_MAX_CONSECUTIVE_DENIALS,
      maxWindowDenials: config?.maxWindowDenials ?? GUARDIAN_MAX_WINDOW_DENIALS,
      windowSize: config?.windowSize ?? GUARDIAN_DENIAL_WINDOW_SIZE,
    });
  }

  async evaluate(context: PermissionPolicyContext): Promise<PermissionPolicyResult | undefined> {
    if (!this.reviewer.enabled || this.agent.permission.mode !== 'auto') return;
    if (DEFAULT_APPROVE_TOOLS.has(context.toolCall.name)) return;
    // 会话传输工具，创建时已评审 (RFC unified-exec-pty §3.4): WriteStdin
    // only transports bytes into a session whose initial command the
    // guardian already reviewed at ExecSession creation. Reviewing every
    // 250ms poll / control-character write would cost a model call each
    // and judge nothing meaningful.
    if (SESSION_TRANSPORT_TOOLS.has(context.toolCall.name)) return;
    this.pruneBreakerFor(context.turnId);

    const interactive = this.agent.rpc?.requestApproval !== undefined;
    if (this.breaker.tripped(context.turnId)) {
      return interactive
        ? { kind: 'ask', reason: { guardian_fallback: 'circuit_breaker_tripped' } }
        : {
            kind: 'deny',
            reason: { guardian_fallback: 'circuit_breaker_tripped' },
            message:
              `Tool "${context.toolCall.name}" was not run: the guardian approval reviewer was ` +
              'suspended for the rest of this turn after too many denials, and no interactive ' +
              'approval channel is available. Do not retry the same action; adjust your approach.',
          };
    }

    const result = await this.reviewer.review(context);
    if (result.kind === 'completed') {
      return this.applyAssessment(context, result);
    }
    return this.applyFailure(context, result, interactive);
  }

  private applyAssessment(
    context: PermissionPolicyContext,
    result: Extract<GuardianReviewResult, { kind: 'completed' }>,
  ): PermissionPolicyResult {
    const { assessment } = result;
    const record: AgentRecordOf<'guardian.assessment'> = {
      type: 'guardian.assessment',
      turnId: Number(context.turnId),
      toolCallId: context.toolCall.id,
      toolName: context.toolCall.name,
      outcome: assessment.outcome,
      riskLevel: assessment.riskLevel,
      userAuthorization: assessment.userAuthorization,
      rationale: assessment.rationale,
      model: result.model,
      durationMs: result.durationMs,
      traceId: result.traceId,
    };
    this.agent.records.logRecord(record);
    this.agent.replayBuilder.push({ type: 'guardian_assessment', record });

    if (assessment.outcome === 'allow') {
      this.breaker.recordNonDenial(context.turnId);
      return {
        kind: 'approve',
        reason: {
          guardian: 'allow',
          risk_level: assessment.riskLevel,
          user_authorization: assessment.userAuthorization,
        },
      };
    }

    const trip = this.breaker.recordDenial(context.turnId);
    if (trip.tripped) {
      this.onBreakerTripped(Number(context.turnId), trip);
    }
    return {
      kind: 'deny',
      reason: {
        guardian: 'deny',
        risk_level: assessment.riskLevel,
        user_authorization: assessment.userAuthorization,
      },
      message: guardianRejectionMessage(assessment),
    };
  }

  private applyFailure(
    context: PermissionPolicyContext,
    result: Extract<GuardianReviewResult, { kind: 'failed' }>,
    interactive: boolean,
  ): PermissionPolicyResult {
    // Review failures never count toward the circuit breaker (codex parity):
    // a flaky model service must not trip it.
    this.breaker.recordNonDenial(context.turnId);
    const fallback = interactive ? 'ask' : 'deny';
    this.agent.records.logRecord({
      type: 'guardian.review_failed',
      turnId: Number(context.turnId),
      toolCallId: context.toolCall.id,
      toolName: context.toolCall.name,
      failureKind: result.failureKind,
      fallback,
      durationMs: result.durationMs,
    });
    if (interactive) {
      return { kind: 'ask', reason: { guardian_fallback: result.failureKind } };
    }
    return {
      kind: 'deny',
      reason: { guardian_fallback: result.failureKind },
      message: guardianFailClosedMessage(context.toolCall.name, result.failureKind),
    };
  }

  private onBreakerTripped(turnId: number, trip: GuardianCircuitBreakerTrip): void {
    this.agent.records.logRecord({
      type: 'guardian.circuit_breaker_tripped',
      turnId,
      consecutiveDenials: trip.consecutiveDenials,
      windowDenials: trip.windowDenials,
    });
    try {
      const delivery = this.agent.rpc?.emitEvent?.({
        type: 'warning',
        code: 'guardian-circuit-breaker-tripped',
        message:
          'The guardian approval reviewer denied too many actions this turn ' +
          `(${String(trip.consecutiveDenials)} consecutive, ${String(trip.windowDenials)} in the recent window). ` +
          'Automatic review is suspended for the rest of this turn; actions fall back to manual approval.',
      });
      void delivery?.catch(() => {});
    } catch {
      // diagnostics must never block a permission decision
    }
  }

  /**
   * Breaker state is per turn. There is no turn-end hook on this path, so
   * prune conservatively when the observed turnId changes (design doc §3.2.3).
   */
  private pruneBreakerFor(turnId: string): void {
    if (this.lastTurnId === turnId) return;
    this.lastTurnId = turnId;
    this.breaker.pruneExcept(turnId);
  }
}

/** codex `guardian_rejection_message` (review.rs:71-88). */
function guardianRejectionMessage(assessment: GuardianAssessment): string {
  const rationale =
    assessment.rationale.trim().length > 0
      ? assessment.rationale.trim()
      : 'Auto-reviewer denied the action without a specific rationale.';
  return `This action was rejected due to unacceptable risk.\nReason: ${rationale}\n${GUARDIAN_REJECTION_INSTRUCTIONS}`;
}

/**
 * Headless fail-closed deny. Distinguished from an explicit reviewer denial
 * (codex `GUARDIAN_TIMEOUT_INSTRUCTIONS`, review.rs:59-63): the failure alone
 * says nothing about the action's safety.
 */
function guardianFailClosedMessage(
  toolName: string,
  failureKind: GuardianReviewFailureKind,
): string {
  if (failureKind === 'timeout') {
    return (
      `Tool "${toolName}" was not run: the automatic permission approval review did not finish ` +
      'before its deadline, and no interactive approval channel is available. Do not assume the ' +
      'action is unsafe based on the timeout alone. You may retry once.'
    );
  }
  return (
    `Tool "${toolName}" was not run: the automatic permission approval review failed ` +
    `(${failureKind} error), and no interactive approval channel is available. Do not assume the ` +
    'action is unsafe based on this failure alone. You may retry once, or adjust your approach.'
  );
}
