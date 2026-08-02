import type { GoalSnapshotStructured } from '@cloud-code/protocol';

import type { GoalSnapshot, GoalToolResult } from '../../../agent/goal';

/**
 * The goalId is a random UUID with no user-facing meaning, and no goal tool
 * takes one (there is only ever one goal at a time). Keep it out of what the
 * model sees so it never echoes the id back to the user as if it mattered.
 * The reason code/detail are UI-only localization aids — the model keeps the
 * human-readable `terminalReason` text.
 */
export type GoalForModel = Omit<
  GoalSnapshot,
  'goalId' | 'terminalReasonCode' | 'terminalReasonDetail'
>;

export function goalForModel(goal: GoalSnapshot): GoalForModel {
  const {
    goalId: _goalId,
    terminalReasonCode: _terminalReasonCode,
    terminalReasonDetail: _terminalReasonDetail,
    ...rest
  } = goal;
  return rest;
}

export function goalResultForModel(
  result: GoalToolResult,
): { goal: GoalForModel | null } {
  return { goal: result.goal === null ? null : goalForModel(result.goal) };
}

/**
 * The structured-channel companion of the goal JSON envelope: the same
 * status and terminal-reason facts, plus their machine form, so clients
 * localize instead of parsing the JSON (kept for the model and for
 * old-session replay).
 */
export function goalSnapshotStructured(goal: GoalSnapshot): GoalSnapshotStructured {
  const structured: GoalSnapshotStructured = { status: goal.status };
  if (goal.terminalReason !== undefined) structured.terminalReason = goal.terminalReason;
  if (goal.terminalReasonCode !== undefined) {
    structured.terminalReasonCode = goal.terminalReasonCode;
  }
  if (goal.terminalReasonDetail !== undefined) {
    structured.terminalReasonDetail = goal.terminalReasonDetail;
  }
  return structured;
}
