import {
  GOAL_TIER_MEDIUM_MAX_OBJECTIVE_LENGTH,
  GOAL_TIER_SMALL_MAX_OBJECTIVE_LENGTH,
  MAX_GOAL_COMPLETION_CRITERION_LENGTH,
} from './constants';
import type { GoalBudgetReport, GoalEvidenceState, GoalState, GoalTier } from './types';

export function createGoalEvidenceState(): GoalEvidenceState {
  return {
    receipts: new Map(),
    toolMutationIndex: 0,
    pendingReceiptIds: [],
    pendingTurnId: -1,
    pendingStep: -1,
  };
}

/**
 * Objective-length tier heuristic used when the model gave no `sizeHint`
 * (§3.4): <=280 characters small, <=1200 medium, else large.
 */
export function inferGoalTier(objective: string): GoalTier {
  if (objective.length <= GOAL_TIER_SMALL_MAX_OBJECTIVE_LENGTH) return 'small';
  if (objective.length <= GOAL_TIER_MEDIUM_MAX_OBJECTIVE_LENGTH) return 'medium';
  return 'large';
}

/**
 * Live active-pursuit time: the accumulated total plus the in-flight `active`
 * interval. Correct even when read mid-turn (the interval isn't folded into
 * `wallClockMs` until the goal leaves `active`).
 */
export function liveWallClockMs(state: GoalState, now: number = Date.now()): number {
  if (state.status === 'active' && state.wallClockResumedAt !== undefined) {
    return state.wallClockMs + Math.max(0, now - state.wallClockResumedAt);
  }
  return state.wallClockMs;
}

export function computeBudgetReport(
  state: GoalState,
  now: number = Date.now(),
): GoalBudgetReport {
  const limits = state.budgetLimits;
  const tokenBudget = limits.tokenBudget ?? null;
  const turnBudget = limits.turnBudget ?? null;
  const wallClockBudgetMs = limits.wallClockBudgetMs ?? null;
  const wallClockMs = liveWallClockMs(state, now);

  const tokenBudgetReached = tokenBudget !== null && state.tokensUsed >= tokenBudget;
  const turnBudgetReached = turnBudget !== null && state.turnsUsed >= turnBudget;
  const wallClockBudgetReached =
    wallClockBudgetMs !== null && wallClockMs >= wallClockBudgetMs;

  return {
    tokenBudget,
    turnBudget,
    wallClockBudgetMs,
    remainingTokens: tokenBudget === null ? null : Math.max(0, tokenBudget - state.tokensUsed),
    remainingTurns: turnBudget === null ? null : Math.max(0, turnBudget - state.turnsUsed),
    remainingWallClockMs:
      wallClockBudgetMs === null ? null : Math.max(0, wallClockBudgetMs - wallClockMs),
    tokenBudgetReached,
    turnBudgetReached,
    wallClockBudgetReached,
    overBudget: tokenBudgetReached || turnBudgetReached || wallClockBudgetReached,
  };
}

export function normalizeCompletionCriterion(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed?.length) return undefined;
  return trimmed.length > MAX_GOAL_COMPLETION_CRITERION_LENGTH
    ? trimmed.slice(0, MAX_GOAL_COMPLETION_CRITERION_LENGTH)
    : trimmed;
}
