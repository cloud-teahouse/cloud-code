import type { GoalTier } from './types';

/** Maximum objective length in characters. */
export const MAX_GOAL_OBJECTIVE_LENGTH = 4000;

/**
 * Maximum completion-criterion length in characters. The criterion is repeated
 * in every active/paused/blocked goal reminder, so an unbounded one would bloat
 * both `state.json` and every continuation prompt. Unlike the objective (which
 * is rejected when too long), this supplementary field is truncated so an
 * over-long criterion never fails goal creation outright.
 */
export const MAX_GOAL_COMPLETION_CRITERION_LENGTH = MAX_GOAL_OBJECTIVE_LENGTH;

/**
 * Maximum evidence receipts kept per goal. FIFO eviction bounds memory; by
 * the time the cap is reached the evicted receipts would be too old to cite
 * anyway (docs/phase5/goal-completion-gate.md §3.1).
 */
export const MAX_GOAL_EVIDENCE_RECEIPTS = 50;

/**
 * Defaults for the `[goal]` completion-gate config (§3.3/§3.6), resolved at
 * each use site from `agent.kimiConfig?.goal` — the same lazy static read as
 * `loopControl` (turn/index.ts), so there is no init-ordering hazard: the
 * Agent constructor assigns `kimiConfig` before it constructs `GoalMode`.
 */
export const DEFAULT_COMPLETION_GATE_ENABLED = true;
export const GOAL_EVIDENCE_LEASE_TURNS_DEFAULT = 5;
export const GOAL_EVIDENCE_LEASE_MS_DEFAULT = 1_800_000;

/** Cap on the usable-receipt summaries embedded in a gate refusal. */
export const MAX_GATE_USABLE_RECEIPT_HINTS = 5;

/** Objective-length heuristic thresholds (§3.4): <=280 small, <=1200 medium, else large. */
export const GOAL_TIER_SMALL_MAX_OBJECTIVE_LENGTH = 280;
export const GOAL_TIER_MEDIUM_MAX_OBJECTIVE_LENGTH = 1200;

/**
 * Built-in per-tier default caps (`[goal.tiers.*]` overrides each slot).
 * Wall-clock deliberately has no tiered default.
 */
export const GOAL_TIER_BUDGET_DEFAULTS: Record<GoalTier, { turns: number; tokens: number }> = {
  small: { turns: 10, tokens: 300_000 },
  medium: { turns: 40, tokens: 1_500_000 },
  large: { turns: 120, tokens: 6_000_000 },
};

export const DEFAULT_TIERED_BUDGETS_ENABLED = true;

export const GOAL_CANCELLED_REMINDER = [
  'The user cancelled the current goal.',
  'Ignore earlier active-goal reminders for that goal.',
  'Handle the next user request normally unless the user starts or resumes a goal.',
].join(' ');

export const GOAL_FORK_CLEARED_REMINDER = [
  'This fork does not have a current goal.',
  'Ignore earlier active-goal reminders from the source session.',
  'Handle requests normally unless the user starts a new goal.',
].join(' ');
