import { MAX_GATE_USABLE_RECEIPT_HINTS } from './constants';
import type {
  GoalCompletionGateBasis,
  GoalCompletionGateRejectionCode,
  GoalCompletionGateVerdict,
  GoalEvidenceReceipt,
  GoalGateReceiptSummary,
  GoalState,
} from './types';

/**
 * Whether the completion gate would enforce a `complete` on this goal (§3.2):
 * a completion criterion, an observed mutation, or any tree-stamped receipt.
 * All three absent means a pure Q&A/research goal, which keeps the pre-gate
 * behavior. (A tree observation lives on receipts, not steps: a goal whose
 * model never ran a receipt-producing tool stays ungated even with shadow-git
 * on, which is what keeps bare UpdateGoal(complete) flows working.)
 */
export function completionGateEnforced(state: GoalState): boolean {
  if (state.completionCriterion !== undefined) return true;
  if (state.evidence.toolMutationIndex > 0) return true;
  for (const receipt of state.evidence.receipts.values()) {
    if (receipt.treeAtCapture !== undefined) return true;
  }
  return false;
}

/** Everything the per-receipt gate checks read, captured once per evaluation. */
export interface GateCheck {
  readonly toolMutationIndex: number;
  readonly latestTree: string | undefined;
  readonly turnsUsed: number;
  readonly now: number;
  readonly leaseTurns: number;
  readonly leaseMs: number;
}

export function gateCheckContext(
  state: GoalState,
  gate: { readonly leaseTurns: number; readonly leaseMs: number },
  now: number,
): GateCheck {
  return {
    toolMutationIndex: state.evidence.toolMutationIndex,
    latestTree: state.evidence.latestTree,
    turnsUsed: state.turnsUsed,
    now,
    leaseTurns: gate.leaseTurns,
    leaseMs: gate.leaseMs,
  };
}

/** Rejection codes a per-receipt check can produce (never `no_evidence`/`unknown_receipt`). */
export type GateReceiptCheckCode = Exclude<
  GoalCompletionGateRejectionCode,
  'no_evidence' | 'unknown_receipt'
>;

/**
 * The §3.2 per-receipt checks in order: success, tool-axis ordering,
 * tree-axis ordering, then the dual lease clocks (§3.3). The tree axis is
 * skipped per receipt when the receipt carries no tree (shadow-git off, an
 * unsealed-step abort edge, or a same-step receipt whose step has not sealed
 * yet — changes made after a capture inside the same step are invisible to
 * the step-end tree either way). Returns the rejection code, or null when the
 * receipt may sign off completion.
 */
export function checkGateReceipt(
  receipt: GoalEvidenceReceipt,
  check: GateCheck,
): GateReceiptCheckCode | null {
  if (!receipt.ok) return 'receipt_failed';
  if (receipt.mutationIndexAtCapture < check.toolMutationIndex) return 'stale_after_mutation';
  if (receipt.treeAtCapture !== undefined && receipt.treeAtCapture !== check.latestTree) {
    return 'stale_tree';
  }
  if (check.turnsUsed - receipt.goalTurnAtCapture > check.leaseTurns) {
    return 'lease_expired_turns';
  }
  if (check.now - receipt.capturedAtMs > check.leaseMs) return 'lease_expired_wall_clock';
  return null;
}

/** Model-facing one-line detail for one rejected receipt (UpdateGoal error output). */
export function gateRejectionReason(
  receipt: GoalEvidenceReceipt,
  code: GateReceiptCheckCode,
  check: GateCheck,
): string {
  const what = `Receipt "${receipt.receiptId}" (${receipt.toolName}: ${receipt.summary})`;
  switch (code) {
    case 'receipt_failed':
      return `${what} captured a failed tool result; failed results can never sign off completion.`;
    case 'stale_after_mutation':
      return `${what} was captured before your latest code change.`;
    case 'stale_tree':
      return `${what} was captured before the workspace last changed on disk.`;
    case 'lease_expired_turns': {
      const age = check.turnsUsed - receipt.goalTurnAtCapture;
      return `${what} is ${String(age)} goal turns old, beyond the ${String(check.leaseTurns)}-turn evidence lease.`;
    }
    case 'lease_expired_wall_clock': {
      const ageS = Math.round((check.now - receipt.capturedAtMs) / 1000);
      return `${what} is ${String(ageS)}s old, beyond the ${String(check.leaseMs)}ms wall-clock evidence lease.`;
    }
  }
}

/** The most recent receipts passing every gate check, capped for refusal text. */
export function listUsableGateReceipts(
  state: GoalState,
  check: GateCheck,
): readonly GoalGateReceiptSummary[] {
  const usable: GoalGateReceiptSummary[] = [];
  for (const receipt of state.evidence.receipts.values()) {
    if (checkGateReceipt(receipt, check) !== null) continue;
    usable.push({
      receiptId: receipt.receiptId,
      toolName: receipt.toolName,
      summary: receipt.summary,
    });
    if (usable.length > MAX_GATE_USABLE_RECEIPT_HINTS) usable.shift();
  }
  return usable;
}

export function allowCompletionGate(basis: GoalCompletionGateBasis): GoalCompletionGateVerdict {
  return { allowed: true, basis, rejections: [], usableReceipts: [] };
}
