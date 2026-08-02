/**
 * Goal-mode type declarations: the durable {@link GoalState}, its public
 * snapshot/budget projections, and the completion-gate verdict shapes.
 */

import type { GoalReasonCode } from '@cloud-code/protocol';

/**
 * Goal size tier for the C2 tiered budgets (docs/phase5/goal-completion-gate.md
 * §3.4): the model supplies it as `sizeHint`, else an objective-length
 * heuristic assigns it. The tier only picks the default budget caps filled in
 * at creation; explicit budgets set later always override.
 */
export type GoalTier = 'small' | 'medium' | 'large';

/**
 * Lifecycle status of a goal — deliberately minimal. The durable record only
 * ever holds `active`, `paused`, or `blocked`; `complete` is transient
 * (announce-then-clear) and never rests on disk. There is exactly one running
 * state, two resumable "stopped" states, and one success outcome:
 *
 * | Status     | Persisted | Resumable | Set by                          | Meaning                                          |
 * |------------|-----------|-----------|---------------------------------|--------------------------------------------------|
 * | `active`   | yes       | (running) | createGoal / resumeGoal         | The goal driver may run continuation turns.      |
 * | `paused`   | yes       | yes       | pauseGoal / pauseActiveGoal /   | User, interrupt, resume, or retryable runtime    |
 * |            |           |           | pauseOnInterrupt /              | stop parked it; intact.                          |
 * |            |           |           | normalizeAfterReplay            |                                                  |
 * | `blocked`  | yes       | yes       | markBlocked                     | The system stopped it for some `reason`.         |
 * | `complete` | no        | —         | markComplete                    | Success — announced in a message, then cleared.  |
 *
 * Only an `active` goal advances: accounting and continuation turns all gate on
 * `status === 'active'`. `paused` and `blocked` are the same kind of
 * thing — "the driver is not running continuation turns, but the goal is intact
 * and resumable via `/goal resume`" — differing only in *who* stopped it (the
 * user vs the system) and the human-readable `reason`. There is no separate
 * `impossible`, `budget_limited`, `error`, or `cancelled` status: an
 * unachievable goal or an exhausted budget becomes `blocked(+reason)`,
 * runtime/model/provider failures become `paused(+reason)`, and `cancelGoal`
 * discards the record entirely. See {@link GoalMode}
 * for the setters and the per-status notes below.
 */
export type GoalStatus =
  /**
   * The goal is live and the goal driver may run continuation turns toward it.
   * Set on creation (`createGoal`) and when a paused/blocked goal is resumed
   * (`resumeGoal`). The only status under which turns/tokens/wall-clock are
   * accounted and continuation turns run.
   */
  | 'active'
  /**
   * The user stopped the goal but it is fully intact and resumable via
   * `/goal resume`. Reached three ways: the user pauses (`pauseGoal`); a live
   * turn is aborted mid-flight, e.g. Esc/shutdown (`pauseOnInterrupt`); or a
   * agent is resumed from disk, where an `active` goal cannot still be running
   * and is demoted (`normalizeAfterReplay`); or a runtime/model/provider failure
   * parked it via `pauseActiveGoal`.
   */
  | 'paused'
  /**
   * The *system* stopped pursuing the goal, for a reason carried in
   * `terminalReason`: the model reported it cannot proceed via
   * `UpdateGoal('blocked')` (an external blocker, or an objective it deems
   * unachievable); or a configured hard budget (token/turn/time) was reached.
   * Set by `markBlocked` from the model's `UpdateGoal`, the budget check in the
   * goal driver, and prompt-hook blocks.
   * Resumable like `paused` — `/goal resume` re-activates it; a plain message
   * just runs one normal turn without reactivating the loop. Editing the goal
   * while blocked takes effect on the next turn.
   */
  | 'blocked'
  /**
   * Success: the model reported the objective met via `UpdateGoal('complete')`.
   * Set by `markComplete`. This status is **transient**
   * — `markComplete` emits the completion event and then clears the durable
   * record, so the goal box disappears and `complete` never rests on disk.
   */
  | 'complete';

/** Who performed a goal action. `cleared` is a record action, not a status. */
export type GoalActor = 'user' | 'model' | 'runtime' | 'system';

export interface GoalBudgetLimits {
  readonly tokenBudget?: number;
  readonly turnBudget?: number;
  readonly wallClockBudgetMs?: number;
}

/**
 * One captured tool-result receipt in the goal evidence ledger — the P1
 * groundwork of the completion gate (docs/phase5/goal-completion-gate.md
 * §3.1). Receipts are memory-only and never recorded: a resumed goal restarts
 * with an empty ledger. The P2 gate (`evaluateCompletionGate`) accepts or
 * rejects `UpdateGoal(complete)` against them.
 */
export interface GoalEvidenceReceipt {
  /** Tool call id; the model cites it in `UpdateGoal.evidence` (P2). */
  readonly receiptId: string;
  /** Tool name at capture time. */
  readonly toolName: string;
  readonly turnId: number;
  /** `Date.now()` at capture — wall-clock lease start. */
  readonly capturedAtMs: number;
  /** `turnsUsed` at capture — turn lease start. */
  readonly goalTurnAtCapture: number;
  /** `toolMutationIndex` at capture — tool-axis ordering anchor. */
  readonly mutationIndexAtCapture: number;
  /**
   * Shadow-git tree at the end of the capture step, backfilled by
   * `stampReceiptTrees`. Stays undefined when shadow-git is off or the step
   * never sealed.
   */
  treeAtCapture?: string;
  /** `!isError`; failed receipts stay for audit but a gate never accepts them. */
  readonly ok: boolean;
  /** Command/first line, single-lined and capped — refusal-prompt text only. */
  readonly summary: string;
}

/**
 * Memory-only evidence ledger and mutation index behind the completion gate.
 * Kept inside {@link GoalState} so it is initialized with the goal and
 * destroyed with it automatically; deliberately absent from records — after a
 * restart the ledger starts empty and completion requires fresh verification.
 */
export interface GoalEvidenceState {
  readonly receipts: Map<string, GoalEvidenceReceipt>;
  toolMutationIndex: number;
  lastMutationGoalTurn?: number;
  /**
   * Tree of the most recently sealed step while this goal exists — the tree
   * axis's "now" for the completion gate. Updated by every `stampReceiptTrees`
   * call carrying a tree, even when that step left no receipts.
   */
  latestTree?: string;
  /** Receipts captured in the step now in flight, awaiting its end-of-step tree. */
  pendingReceiptIds: string[];
  /**
   * Turn/step the pending receipts belong to. Guards the stamp against a step
   * that ended without its `afterStep` hook: those receipts must never receive
   * a different step's tree (that would make them look fresher than they are).
   */
  pendingTurnId: number;
  pendingStep: number;
}

/** In-memory goal state rebuilt from agent records. */
export interface GoalState {
  goalId: string;
  objective: string;
  completionCriterion?: string;
  status: GoalStatus;
  turnsUsed: number;
  tokensUsed: number;
  /** Accumulated active-pursuit time from completed `active` intervals. */
  wallClockMs: number;
  /**
   * Epoch ms anchoring the current `active` interval (undefined when not active).
   * The live elapsed since this is added to `wallClockMs` when reporting, so the
   * timer is correct even when read mid-turn; the interval is folded into
   * `wallClockMs` when the goal leaves `active`. Reset on agent resume.
   */
  wallClockResumedAt?: number;
  budgetLimits: GoalBudgetLimits;
  /** Human-readable reason for a stopped or completed goal. */
  terminalReason?: string;
  /** Machine form of `terminalReason` for runtime-authored stops. */
  terminalReasonCode?: GoalReasonCode;
  /** Opaque detail embedded in `terminalReason` (e.g. the provider error). */
  terminalReasonDetail?: string;
  /** Completion-gate P1 ledger; memory-only, never recorded. */
  evidence: GoalEvidenceState;
}

/** Computed budget view exposed through snapshots and tools. */
export interface GoalBudgetReport {
  readonly tokenBudget: number | null;
  readonly turnBudget: number | null;
  readonly wallClockBudgetMs: number | null;
  readonly remainingTokens: number | null;
  readonly remainingTurns: number | null;
  readonly remainingWallClockMs: number | null;
  readonly tokenBudgetReached: boolean;
  readonly turnBudgetReached: boolean;
  readonly wallClockBudgetReached: boolean;
  readonly overBudget: boolean;
}

/**
 * Completion-gate state projected into a {@link GoalSnapshot} (additive, P2).
 * Present only when the gate is enabled and would actually enforce a
 * `complete` right now (completion criterion set, a mutation observed, or a
 * tree-stamped receipt in the ledger) — its presence is exactly what the
 * active-goal reminder's gate line keys off.
 */
export interface GoalCompletionGateSnapshot {
  /** Successful Edit/Write results observed over the goal's lifetime. */
  readonly mutationsObserved: number;
  /** Receipts that would currently pass every gate check. */
  readonly usableReceipts: number;
  /** Receipts that would currently be rejected (failed, stale, or expired). */
  readonly staleReceipts: number;
  readonly lastMutationGoalTurn?: number;
}

/** Public, computed view of the current goal. */
export interface GoalSnapshot {
  readonly goalId: string;
  readonly objective: string;
  readonly completionCriterion?: string;
  readonly status: GoalStatus;
  readonly turnsUsed: number;
  readonly tokensUsed: number;
  readonly wallClockMs: number;
  readonly budget: GoalBudgetReport;
  readonly terminalReason?: string;
  /**
   * Machine form of `terminalReason` for runtime-authored stops. Wire/UI
   * only — `goalForModel` strips it from the model-facing goal JSON.
   */
  readonly terminalReasonCode?: GoalReasonCode;
  /** Opaque detail embedded in `terminalReason` (e.g. the provider error). */
  readonly terminalReasonDetail?: string;
  readonly completionGate?: GoalCompletionGateSnapshot;
}

/** Wrapper returned by goal read operations and tools. */
export interface GoalToolResult {
  readonly goal: GoalSnapshot | null;
}

/**
 * Why the completion gate rejected a cited receipt — surfaced as the `reason`
 * on the returned {@link GoalCompletionGateVerdict}.
 */
export type GoalCompletionGateRejectionCode =
  /** Nothing was cited while the gate enforces. */
  | 'no_evidence'
  /** The cited id is not in the ledger (evicted, mistyped, or pre-restart). */
  | 'unknown_receipt'
  /** The receipt captured a failed (`isError`) tool result. */
  | 'receipt_failed'
  /** Tool axis: the receipt predates the latest successful Edit/Write. */
  | 'stale_after_mutation'
  /** Tree axis: the workspace tree moved past the receipt's capture tree. */
  | 'stale_tree'
  /** Turn-clock lease expired (`turnsUsed - goalTurnAtCapture > leaseTurns`). */
  | 'lease_expired_turns'
  /** Wall-clock lease expired (`now - capturedAtMs > leaseMs`). */
  | 'lease_expired_wall_clock';

export interface GoalCompletionGateRejection {
  readonly receiptId: string;
  readonly code: GoalCompletionGateRejectionCode;
  /** Model-facing English detail, embedded in the UpdateGoal error output. */
  readonly reason: string;
}

/** Compact receipt description embedded in a gate refusal so the model can re-cite. */
export interface GoalGateReceiptSummary {
  readonly receiptId: string;
  readonly toolName: string;
  readonly summary: string;
}

/** Why the gate let a `complete` through. */
export type GoalCompletionGateBasis =
  /** No active goal; `markComplete` reports the no-goal case as before. */
  | 'inactive'
  /** `[goal] completion_gate = false`. */
  | 'gate_disabled'
  /**
   * Pure Q&A/research goal: no completion criterion, no mutation observed,
   * and no tree-stamped receipt — the pre-gate behavior is preserved (§3.2).
   */
  | 'not_required'
  /** At least one cited receipt passed every check. */
  | 'evidence_passed';

export interface GoalCompletionGateVerdict {
  readonly allowed: boolean;
  /** Why completion was allowed; absent on a rejection. */
  readonly basis?: GoalCompletionGateBasis;
  /** Gate rejection code on a rejection; absent when allowed. */
  readonly reason?: GoalCompletionGateRejectionCode;
  /** Per-cited-receipt failure details (empty when nothing was cited). */
  readonly rejections: readonly GoalCompletionGateRejection[];
  /** Up to 5 currently usable receipts, for the refusal text. */
  readonly usableReceipts: readonly GoalGateReceiptSummary[];
}

/** Snapshot of the goal's usage counters at the moment of a change. */
export interface GoalChangeStats {
  readonly turnsUsed: number;
  readonly tokensUsed: number;
  readonly wallClockMs: number;
}

/**
 * Describes what changed on a `goal.updated` event, so the UI can render the
 * right thing. Absent for snapshot-only refreshes (e.g. a turn increment that
 * only moves the badge).
 *
 * - `lifecycle`: a status transition — `paused` / `active` (resumed) / `blocked`
 *   — rendered as a low-profile transcript marker.
 * - `completion`: the goal completed successfully (the only outcome that posts
 *   the completion message and clears the record). This replaced the older
 *   `terminal` name, which since the state consolidation only ever meant
 *   `complete` — `blocked` is a resumable `lifecycle` change, not a completion.
 */
export type GoalChangeKind = 'lifecycle' | 'completion';

/** Canonical declaration lives in `@cloud-code/protocol`; see there. */
export type { GoalReasonCode };

export interface GoalChange {
  readonly kind: GoalChangeKind;
  readonly status?: GoalStatus;
  readonly reason?: string;
  /** Machine form of `reason` for runtime-authored stops; additive. */
  readonly reasonCode?: GoalReasonCode;
  /** Opaque detail (e.g. the provider error message) embedded in `reason`. */
  readonly reasonDetail?: string;
  readonly stats?: GoalChangeStats;
  readonly actor?: GoalActor;
}

export interface CreateGoalInput {
  readonly objective: string;
  readonly completionCriterion?: string;
  readonly replace?: boolean;
  /**
   * Model-estimated size tier (§3.4). Picks the default budget caps filled in
   * at creation; when absent, an objective-length heuristic assigns the tier.
   */
  readonly sizeHint?: GoalTier;
}

export interface GoalReasonInput {
  readonly reason?: string;
  readonly reasonCode?: GoalReasonCode;
  readonly reasonDetail?: string;
}
