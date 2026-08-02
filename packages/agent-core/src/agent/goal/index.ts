/**
 * Goal mode: the durable current-goal store ({@link GoalMode}) plus its public
 * snapshot, budget, and completion-gate types. Split across sibling modules by
 * responsibility — `goal-mode.ts` holds the state machine, `types.ts` the
 * declarations, `constants.ts` the limits/defaults, `helpers.ts` the budget and
 * wall-clock math, and `completion-gate.ts` the P2 evidence-gate checks; this
 * barrel keeps the historical import surface intact.
 */
export { GoalMode } from './goal-mode';
export {
  GOAL_EVIDENCE_LEASE_MS_DEFAULT,
  GOAL_EVIDENCE_LEASE_TURNS_DEFAULT,
  GOAL_TIER_BUDGET_DEFAULTS,
} from './constants';
export type {
  CreateGoalInput,
  GoalActor,
  GoalBudgetLimits,
  GoalBudgetReport,
  GoalChange,
  GoalChangeKind,
  GoalChangeStats,
  GoalCompletionGateBasis,
  GoalCompletionGateRejection,
  GoalCompletionGateRejectionCode,
  GoalCompletionGateSnapshot,
  GoalCompletionGateVerdict,
  GoalEvidenceReceipt,
  GoalGateReceiptSummary,
  GoalReasonCode,
  GoalReasonInput,
  GoalSnapshot,
  GoalStatus,
  GoalTier,
  GoalToolResult,
} from './types';
