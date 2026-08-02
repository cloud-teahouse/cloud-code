import { randomUUID } from 'node:crypto';

import { ErrorCodes, CloudCodeError } from '#/errors';
import type { Agent } from '..';
import type { AgentRecordOf } from '../records/types';
import {
  allowCompletionGate,
  checkGateReceipt,
  completionGateEnforced,
  gateCheckContext,
  gateRejectionReason,
  listUsableGateReceipts,
} from './completion-gate';
import {
  DEFAULT_COMPLETION_GATE_ENABLED,
  DEFAULT_TIERED_BUDGETS_ENABLED,
  GOAL_CANCELLED_REMINDER,
  GOAL_EVIDENCE_LEASE_MS_DEFAULT,
  GOAL_EVIDENCE_LEASE_TURNS_DEFAULT,
  GOAL_FORK_CLEARED_REMINDER,
  GOAL_TIER_BUDGET_DEFAULTS,
  MAX_GOAL_EVIDENCE_RECEIPTS,
  MAX_GOAL_OBJECTIVE_LENGTH,
} from './constants';
import {
  computeBudgetReport,
  createGoalEvidenceState,
  inferGoalTier,
  liveWallClockMs,
  normalizeCompletionCriterion,
} from './helpers';
import type {
  CreateGoalInput,
  GoalActor,
  GoalBudgetLimits,
  GoalChange,
  GoalChangeStats,
  GoalCompletionGateRejection,
  GoalCompletionGateSnapshot,
  GoalCompletionGateVerdict,
  GoalEvidenceReceipt,
  GoalReasonInput,
  GoalSnapshot,
  GoalState,
  GoalStatus,
  GoalTier,
  GoalToolResult,
} from './types';

/**
 * Single durable owner of the current goal.
 *
 * Lifecycle rules (see the {@link GoalStatus} union for the full per-status map):
 * - Success: `markComplete` records success then clears the record (transient).
 *   The model marks completion via the `UpdateGoal('complete')` tool; the turn
 *   driver reads the status at the turn boundary. `markComplete` announces, then
 *   clears the record.
 * - Task stop: `markBlocked(reason)` sets `blocked` when the model cannot
 *   proceed, a prompt hook blocks, or a hard budget is reached. `blocked` is
 *   resumable.
 * - Pause: `pauseGoal`, `pauseActiveGoal`, and the interrupt path
 *   `pauseOnInterrupt` set `paused` (resumable); `cancelGoal` discards the
 *   record entirely (no status — this is what `/goal cancel` does, the single
 *   remove action).
 * - An aborted or failed turn is not terminal: it pauses the goal, so it stays
 *   resumable — mirroring how `normalizeAfterReplay` demotes an `active` goal to
 *   `paused` on agent resume.
 */
export class GoalMode {
  private state: GoalState | undefined;

  constructor(private readonly agent: Agent) {
  }

  /**
   * Reconciles replayed goal state with runtime reality on agent resume.
   *
   * An `active` goal cannot still be running after a process restart (goal
   * continuation only advances inside a live turn), so it is demoted to
   * `paused`, requiring `/goal resume` to restart work. `paused` and `blocked`
   * goals are preserved (both resumable). Any stray `complete` (which should
   * have been followed by `goal.clear`) is removed.
   */
  normalizeAfterReplay(): void {
    const state = this.state;
    if (state === undefined) return;

    state.wallClockResumedAt = undefined;

    if (state.status === 'complete') {
      this.clearInternal('runtime', { emit: false });
      return;
    }

    if (state.status === 'active') {
      const reason = 'Paused after agent resume';
      this.applyStatus(state, 'paused');
      state.terminalReason = reason;
      state.terminalReasonCode = 'agent_resume';
      state.terminalReasonDetail = undefined;
      this.persistState(state, { silent: true });
      this.appendStatusUpdate(state, 'runtime', { reason, reasonCode: 'agent_resume' });
      return;
    }

    // `paused` and `blocked` goals are left intact (both resumable).
  }

  restoreCreate(record: AgentRecordOf<'goal.create'>): void {
    const state: GoalState = {
      goalId: record.goalId,
      objective: record.objective,
      completionCriterion: record.completionCriterion,
      status: 'active',
      turnsUsed: 0,
      tokensUsed: 0,
      wallClockMs: 0,
      budgetLimits: {},
      evidence: createGoalEvidenceState(),
    };
    this.state = state;
    this.agent.replayBuilder.push({
      type: 'goal_updated',
      snapshot: this.toSnapshot(state),
      change: { kind: 'created' },
    });
  }

  restoreUpdate(record: AgentRecordOf<'goal.update'>): void {
    const state = this.state;
    if (state === undefined) return;

    const status = record.status;
    if (status !== undefined) {
      state.status = status;
      state.wallClockResumedAt = undefined;
      state.terminalReason = status === 'active' ? undefined : record.reason;
      state.terminalReasonCode = status === 'active' ? undefined : record.reasonCode;
      state.terminalReasonDetail = status === 'active' ? undefined : record.reasonDetail;
    }
    if (record.turnsUsed !== undefined) state.turnsUsed = record.turnsUsed;
    if (record.tokensUsed !== undefined) state.tokensUsed = record.tokensUsed;
    if (record.wallClockMs !== undefined) {
      state.wallClockMs = record.wallClockMs;
      state.wallClockResumedAt = undefined;
    }
    if (record.budgetLimits !== undefined) state.budgetLimits = record.budgetLimits;
    if (status === undefined) return;

    this.agent.replayBuilder.push({
      type: 'goal_updated',
      snapshot: this.toSnapshot(state),
      change: status === 'complete'
        ? {
            kind: 'completion',
            status,
            reason: record.reason,
            reasonCode: record.reasonCode,
            reasonDetail: record.reasonDetail,
            stats: this.statsOf(state),
            actor: record.actor,
          }
        : {
            kind: 'lifecycle',
            status,
            reason: record.reason,
            reasonCode: record.reasonCode,
            reasonDetail: record.reasonDetail,
            actor: record.actor,
          },
    });
  }

  restoreClear(_record: AgentRecordOf<'goal.clear'>): void {
    this.state = undefined;
  }

  restoreForked(_record: AgentRecordOf<'forked'>): void {
    const hadGoal = this.state !== undefined;
    this.state = undefined;
    if (!hadGoal) return;
    this.agent.context.appendSystemReminder(GOAL_FORK_CLEARED_REMINDER, {
      kind: 'system_trigger',
      name: 'goal_fork_cleared',
    });
  }

  // --- Reads -------------------------------------------------------------

  getGoal(): GoalToolResult {
    const state = this.state;
    return { goal: state === undefined ? null : this.toSnapshot(state) };
  }

  getActiveGoal(): GoalSnapshot | null {
    const state = this.state;
    if (state === undefined || state.status !== 'active') return null;
    return this.toSnapshot(state);
  }

  // --- Creation ----------------------------------------------------------

  async createGoal(input: CreateGoalInput, actor: GoalActor = 'user'): Promise<GoalSnapshot> {
    const objective = input.objective.trim();
    if (objective.length === 0) {
      throw new CloudCodeError(ErrorCodes.GOAL_OBJECTIVE_EMPTY, 'Goal objective cannot be empty');
    }
    if (objective.length > MAX_GOAL_OBJECTIVE_LENGTH) {
      throw new CloudCodeError(
        ErrorCodes.GOAL_OBJECTIVE_TOO_LONG,
        `Goal objective cannot exceed ${MAX_GOAL_OBJECTIVE_LENGTH} characters`,
      );
    }

    const existing = this.state;
    if (existing !== undefined) {
      // Any persisted goal (active / paused / blocked) is intact and blocks a
      // new one unless `replace` is set; `complete` never persists, so it is not
      // observed here. This protects a resumable paused/blocked goal from being
      // silently overwritten.
      if (input.replace !== true) {
        throw new CloudCodeError(
          ErrorCodes.GOAL_ALREADY_EXISTS,
          'A goal already exists; use replace to start a new one',
        );
      }
      // Clear the previous goal through the same internal clear path so records
      // stay consistent before storing the replacement.
      this.clearInternal('system');
    }

    const completionCriterion = normalizeCompletionCriterion(input.completionCriterion);
    const state: GoalState = {
      goalId: randomUUID(),
      objective,
      completionCriterion,
      status: 'active',
      turnsUsed: 0,
      tokensUsed: 0,
      wallClockMs: 0,
      wallClockResumedAt: Date.now(),
      budgetLimits: {},
      evidence: createGoalEvidenceState(),
    };
    // Tiered budgets (§3.4): creation always starts from `{}`, so the tier's
    // default caps simply fill the empty slots. Any later explicit limit
    // (SetGoalBudget / SDK setBudgetLimits) merge-overrides them; wall-clock
    // gets no tiered default.
    const tiered = this.resolveTieredBudgetDefaults(objective, input.sizeHint);
    if (tiered !== undefined) {
      state.budgetLimits = { ...state.budgetLimits, ...tiered.budgetLimits };
    }

    this.persistState(state);
    this.agent.records.logRecord({
      type: 'goal.create',
      goalId: state.goalId,
      objective: state.objective,
      completionCriterion: state.completionCriterion,
      actor,
    });
    if (tiered !== undefined) {
      // Replayable through the existing goal.update budgetLimits field — the
      // record schema is unchanged and `restoreUpdate` already applies it.
      this.appendGoalUpdate({ budgetLimits: state.budgetLimits });
    }
    return this.toSnapshot(state);
  }

  // --- User-owned lifecycle ---------------------------------------------

  async pauseGoal(input: GoalReasonInput = {}, actor: GoalActor = 'user'): Promise<GoalSnapshot> {
    const state = this.requireState();
    if (state.status === 'paused') return this.toSnapshot(state);
    if (state.status !== 'active') {
      throw new CloudCodeError(
        ErrorCodes.GOAL_STATUS_INVALID,
        `Cannot pause a goal in status "${state.status}"`,
      );
    }
    this.applyStatus(state, 'paused');
    this.applyTerminalReason(state, input);
    this.persistState(state, {
      change: {
        kind: 'lifecycle',
        status: 'paused',
        reason: input.reason,
        reasonCode: input.reasonCode,
        reasonDetail: input.reasonDetail,
        actor,
      },
    });
    this.appendStatusUpdate(state, actor, input);
    return this.toSnapshot(state);
  }

  /**
   * Parks the current active goal without throwing if it already stopped. Runtime
   * paths use this after a turn has ended, where the user may already have
   * paused, cleared, or otherwise changed the goal.
   */
  async pauseActiveGoal(
    input: GoalReasonInput = {},
    actor: GoalActor = 'runtime',
  ): Promise<GoalSnapshot | null> {
    const state = this.state;
    if (state === undefined || state.status !== 'active') return null;
    this.applyStatus(state, 'paused');
    this.applyTerminalReason(state, input);
    this.persistState(state, {
      change: {
        kind: 'lifecycle',
        status: 'paused',
        reason: input.reason,
        reasonCode: input.reasonCode,
        reasonDetail: input.reasonDetail,
        actor,
      },
    });
    this.appendStatusUpdate(state, actor, input);
    return this.toSnapshot(state);
  }

  async resumeGoal(input: GoalReasonInput = {}, actor: GoalActor = 'user'): Promise<GoalSnapshot> {
    const state = this.requireState();
    if (state.status === 'active') return this.toSnapshot(state);
    if (state.status !== 'paused' && state.status !== 'blocked') {
      throw new CloudCodeError(
        ErrorCodes.GOAL_NOT_RESUMABLE,
        `Cannot resume a goal in status "${state.status}"`,
      );
    }
    // Resuming is a fresh attempt: clear the stop reason so a re-activated goal
    // starts clean.
    state.terminalReason = undefined;
    state.terminalReasonCode = undefined;
    state.terminalReasonDetail = undefined;
    this.applyStatus(state, 'active');
    this.persistState(state, {
      change: { kind: 'lifecycle', status: 'active', reason: input.reason, actor },
    });
    this.appendStatusUpdate(state, actor, input);
    return this.toSnapshot(state);
  }

  async setBudgetLimits(
    input: { budgetLimits: GoalBudgetLimits },
    actor: GoalActor = 'user',
  ): Promise<GoalSnapshot> {
    const state = this.requireState();
    state.budgetLimits = { ...state.budgetLimits, ...input.budgetLimits };
    this.persistState(state);
    this.appendGoalUpdate({ budgetLimits: state.budgetLimits, actor });
    return this.toSnapshot(state);
  }

  /**
   * Discards the current goal — the single user-facing "remove" action
   * (`/goal cancel`). There is no `cancelled` status: cancel clears the durable
   * record and returns the snapshot it removed, so callers can report what was
   * cancelled. Throws if no goal exists. (Internal callers that need to clear
   * without a return — e.g. `createGoal` replacing an existing goal — use the
   * private `clearInternal`.)
   */
  async cancelGoal(actor: GoalActor = 'user'): Promise<GoalSnapshot> {
    const state = this.requireState();
    const snapshot = this.toSnapshot(state);
    this.clearInternal(actor);
    if (actor === 'user') {
      this.agent.context.appendSystemReminder(GOAL_CANCELLED_REMINDER, {
        kind: 'system_trigger',
        name: 'goal_cancelled',
      });
    }
    return snapshot;
  }

  // --- Terminal outcomes (system-decided) -------------------------------

  /**
   * Marks the goal `blocked`: the system stopped pursuing it for `reason` — the
   * model's `UpdateGoal('blocked')` (incl. objectives it deems unachievable), a
   * hard budget reached by the goal driver, or a prompt-hook block.
   * `blocked` is persisted and **resumable** via
   * `/goal resume` (it is a sibling of `paused`, not a dead end), so it emits a
   * `lifecycle` change. No-ops for a goal that is missing or not active, so a
   * user pause / clear is never overwritten.
   */
  async markBlocked(
    input: GoalReasonInput = {},
    actor: GoalActor = 'runtime',
  ): Promise<GoalSnapshot | null> {
    const state = this.state;
    if (state === undefined || state.status !== 'active') return null;
    this.applyStatus(state, 'blocked');
    this.applyTerminalReason(state, input);
    this.persistState(state, {
      change: {
        kind: 'lifecycle',
        status: 'blocked',
        reason: input.reason,
        reasonCode: input.reasonCode,
        reasonDetail: input.reasonDetail,
        actor,
      },
    });
    this.appendStatusUpdate(state, actor, input);
    return this.toSnapshot(state);
  }

  /**
   * Records goal success, then clears the durable record. `complete` is
   * transient: this records and emits a terminal `complete` change carrying the
   * final stats (so the UI/caller can render the outcome), then clears the goal
   * so the box disappears. Returns the final snapshot (status `complete`). No-ops
   * for a goal that is missing or not active.
   */
  async markComplete(
    input: GoalReasonInput = {},
    actor: GoalActor = 'model',
  ): Promise<GoalSnapshot | null> {
    const state = this.state;
    if (state === undefined || state.status !== 'active') return null;
    this.applyStatus(state, 'complete');
    this.applyTerminalReason(state, input);
    const snapshot = this.toSnapshot(state);
    // Record + notify the UI of completion (with final stats) before clearing.
    this.appendStatusUpdate(state, actor, input);
    this.emitGoalUpdated(snapshot, {
      kind: 'completion',
      status: 'complete',
      reason: input.reason,
      stats: this.statsOf(state),
      actor,
    });
    // ...then clear the durable record (emits onGoalUpdated(null) → box clears).
    this.clearInternal(actor);
    return snapshot;
  }

  // --- User-interrupt transition ----------------------------------------

  /**
   * Parks an active goal when its live turn is aborted (Esc, shutdown, or any
   * other turn-level cancellation). This is **not** terminal: the goal becomes
   * `paused` and stays resumable via `/goal resume`, mirroring how
   * `normalizeAfterReplay` demotes an `active` goal on agent resume. No-ops for
   * a goal that is missing or already non-active, so a user pause / clear or an
   * already-stopped goal is never overwritten.
   */
  async pauseOnInterrupt(input: GoalReasonInput = {}): Promise<GoalSnapshot | null> {
    return this.pauseActiveGoal(input, 'user');
  }

  // --- Accounting & reporting -------------------------------------------

  async recordTokenUsage(tokenDelta: number): Promise<GoalSnapshot | null> {
    const state = this.state;
    if (state === undefined || state.status !== 'active') return null;
    const delta = Math.max(0, tokenDelta);
    state.tokensUsed += delta;
    this.persistState(state, { silent: true }); // per-step: no UI update
    this.appendGoalUpdate({ tokensUsed: state.tokensUsed });
    return this.toSnapshot(state);
  }

  async incrementTurn(): Promise<GoalSnapshot | null> {
    const state = this.state;
    if (state === undefined || state.status !== 'active') return null;
    state.turnsUsed += 1;
    this.persistState(state);
    this.appendGoalUpdate({ turnsUsed: state.turnsUsed });
    return this.toSnapshot(state);
  }

  // --- Completion-gate evidence (P1 ledger + P2 enforcement) -------------

  /**
   * Captures one finalized tool result into the evidence ledger. The turn's
   * `finalizeToolResult` hook calls this for every tool that is neither
   * goal-management nor a mutation tool. No-op unless a goal is active.
   */
  recordEvidence(input: {
    readonly receiptId: string;
    readonly toolName: string;
    readonly turnId: number;
    readonly step: number;
    readonly ok: boolean;
    readonly summary: string;
  }): void {
    const state = this.state;
    if (state === undefined || state.status !== 'active') return;
    const evidence = state.evidence;
    // Receipts still pending from a DIFFERENT step mean that step ended
    // without its afterStep hook (e.g. aborted between the tool batch and the
    // step seal). They can never receive their own step's tree — drop them so
    // a later step's tree cannot make them look fresher than they are.
    if (
      evidence.pendingReceiptIds.length > 0 &&
      (evidence.pendingTurnId !== input.turnId || evidence.pendingStep !== input.step)
    ) {
      evidence.pendingReceiptIds = [];
    }
    evidence.pendingTurnId = input.turnId;
    evidence.pendingStep = input.step;
    evidence.pendingReceiptIds.push(input.receiptId);
    if (evidence.receipts.size >= MAX_GOAL_EVIDENCE_RECEIPTS) {
      const oldest = evidence.receipts.keys().next().value;
      if (oldest !== undefined) evidence.receipts.delete(oldest);
    }
    evidence.receipts.set(input.receiptId, {
      receiptId: input.receiptId,
      toolName: input.toolName,
      turnId: input.turnId,
      capturedAtMs: Date.now(),
      goalTurnAtCapture: state.turnsUsed,
      mutationIndexAtCapture: evidence.toolMutationIndex,
      ok: input.ok,
      summary: input.summary,
    });
  }

  /**
   * Bumps the goal-level mutation index on a successful Edit/Write result.
   * The index is the tool-axis ordering anchor: only evidence captured at or
   * after the latest mutation may sign off completion (P2).
   */
  recordMutation(): void {
    const state = this.state;
    if (state === undefined || state.status !== 'active') return;
    state.evidence.toolMutationIndex += 1;
    state.evidence.lastMutationGoalTurn = state.turnsUsed;
  }

  /**
   * Backfills the step-end shadow-git tree onto the receipts captured in that
   * very step. The turn's `afterStep` hook calls this with the tree returned
   * by `trackAfterStep` (undefined when shadow-git is off — the tree axis
   * then stays empty). Receipts left over from any other step are dropped
   * rather than stamped. Any defined tree also becomes the gate's `latestTree`
   * regardless of pending receipts (P2 tree-axis "now").
   */
  stampReceiptTrees(tree: string | undefined, turnId: number, step: number): void {
    const state = this.state;
    if (state === undefined) return;
    const evidence = state.evidence;
    // The tree of the latest sealed step is the tree axis's "now" for the
    // completion gate; track it even when this step left no receipts to stamp.
    if (tree !== undefined) evidence.latestTree = tree;
    if (evidence.pendingReceiptIds.length === 0) return;
    const pending = evidence.pendingReceiptIds;
    evidence.pendingReceiptIds = [];
    if (tree === undefined || evidence.pendingTurnId !== turnId || evidence.pendingStep !== step) {
      return;
    }
    for (const receiptId of pending) {
      const receipt = evidence.receipts.get(receiptId);
      if (receipt !== undefined) receipt.treeAtCapture = tree;
    }
  }

  /** Read-only ledger view (P1 tests; P2 gate inputs). Insertion-ordered. */
  getEvidenceReceipts(): readonly GoalEvidenceReceipt[] {
    const state = this.state;
    if (state === undefined) return [];
    return [...state.evidence.receipts.values()];
  }

  /** Current mutation index and the goal turn of the latest mutation. */
  getMutationState(): { readonly index: number; readonly lastMutationGoalTurn?: number } {
    const state = this.state;
    return {
      index: state?.evidence.toolMutationIndex ?? 0,
      lastMutationGoalTurn: state?.evidence.lastMutationGoalTurn,
    };
  }

  /**
   * The P2 completion gate (docs/phase5/goal-completion-gate.md §3.2-§3.3).
   * `UpdateGoal(complete)` calls this with the cited `evidence` ids before
   * `markComplete`. A pure Q&A goal — no completion criterion, no observed
   * mutation, no tree-stamped receipt — is waved through exactly as before
   * the gate existed. Otherwise at least one cited receipt must pass every
   * check (existence, success, tool-axis ordering, tree-axis ordering, dual
   * lease clocks); a rejection carries per-receipt reasons plus the currently
   * usable receipts so the model can re-verify and re-cite in the same turn.
   * The ledger is memory-only, so after a restart every citation lands on
   * `unknown_receipt` until fresh verification runs — fail-safe by design.
   */
  evaluateCompletionGate(citedIds: readonly string[]): GoalCompletionGateVerdict {
    const state = this.state;
    if (state === undefined || state.status !== 'active') {
      return allowCompletionGate('inactive');
    }
    const gate = this.completionGateConfig();
    if (!gate.enabled) return allowCompletionGate('gate_disabled');
    if (!completionGateEnforced(state)) return allowCompletionGate('not_required');

    const check = gateCheckContext(state, gate, Date.now());
    const usableReceipts = listUsableGateReceipts(state, check);

    if (citedIds.length === 0) {
      return { allowed: false, reason: 'no_evidence', rejections: [], usableReceipts };
    }

    const rejections: GoalCompletionGateRejection[] = [];
    for (const receiptId of citedIds) {
      const receipt = state.evidence.receipts.get(receiptId);
      if (receipt === undefined) {
        rejections.push({
          receiptId,
          code: 'unknown_receipt',
          reason:
            `Receipt "${receiptId}" is not in the goal evidence ledger ` +
            '(it may be evicted, mistyped, or from before a restart).',
        });
        continue;
      }
      const code = checkGateReceipt(receipt, check);
      if (code === null) {
        return { allowed: true, basis: 'evidence_passed', rejections: [], usableReceipts };
      }
      rejections.push({ receiptId, code, reason: gateRejectionReason(receipt, code, check) });
    }
    const reason = rejections[0]?.code ?? 'no_evidence';
    return { allowed: false, reason, rejections, usableReceipts };
  }

  // --- Internals ---------------------------------------------------------

  private clearInternal(
    actor: GoalActor,
    opts: { emit?: boolean } = {},
  ): void {
    const state = this.state;
    if (state === undefined) return; // idempotent
    this.persistState(undefined, { silent: opts.emit === false });
    this.agent.records.logRecord({ type: 'goal.clear' });
  }

  private appendStatusUpdate(state: GoalState, actor: GoalActor, input: GoalReasonInput): void {
    this.appendGoalUpdate({
      status: state.status,
      reason: input.reason,
      reasonCode: input.reasonCode,
      reasonDetail: input.reasonDetail,
      wallClockMs: liveWallClockMs(state, Date.now()),
      actor,
    });
  }

  /** Records the stop reason (human text plus its machine form) on the state. */
  private applyTerminalReason(state: GoalState, input: GoalReasonInput): void {
    state.terminalReason = input.reason;
    state.terminalReasonCode = input.reasonCode;
    state.terminalReasonDetail = input.reasonDetail;
  }

  private appendGoalUpdate(
    update: Omit<AgentRecordOf<'goal.update'>, 'type' | 'time'>,
  ): void {
    this.agent.records.logRecord({
      type: 'goal.update',
      ...update,
    });
  }

  /**
   * Resolved `[goal]` completion-gate config. Lazy static read off
   * `agent.kimiConfig` at each use site — the same precedent as
   * `kimiConfig?.loopControl` (turn/index.ts), which also means a mid-run
   * config reload affects the gate exactly as much as it affects loopControl
   * (it does not propagate to live agents; `kimiConfig` is constructor-fixed).
   */
  private completionGateConfig(): {
    readonly enabled: boolean;
    readonly leaseTurns: number;
    readonly leaseMs: number;
  } {
    const config = this.agent.kimiConfig?.goal;
    return {
      enabled: config?.completionGate ?? DEFAULT_COMPLETION_GATE_ENABLED,
      leaseTurns: config?.evidenceLeaseTurns ?? GOAL_EVIDENCE_LEASE_TURNS_DEFAULT,
      leaseMs: config?.evidenceLeaseMs ?? GOAL_EVIDENCE_LEASE_MS_DEFAULT,
    };
  }

  /**
   * Resolved tiered-budget defaults for a goal being created (§3.4), or
   * undefined when `[goal] tiered_budgets = false`. The tier comes from the
   * model's `sizeHint` when given, else from the objective-length heuristic;
   * each cap falls back to the built-in tier defaults unless `[goal.tiers.*]`
   * overrides it. Same lazy static config read as {@link completionGateConfig}.
   */
  private resolveTieredBudgetDefaults(
    objective: string,
    sizeHint: GoalTier | undefined,
  ): {
    readonly tier: GoalTier;
    readonly source: 'hint' | 'heuristic';
    readonly budgetLimits: GoalBudgetLimits;
  } | undefined {
    const config = this.agent.kimiConfig?.goal;
    const enabled = config?.tieredBudgets ?? DEFAULT_TIERED_BUDGETS_ENABLED;
    if (!enabled) return undefined;
    const tier = sizeHint ?? inferGoalTier(objective);
    const defaults = GOAL_TIER_BUDGET_DEFAULTS[tier];
    return {
      tier,
      source: sizeHint !== undefined ? 'hint' : 'heuristic',
      budgetLimits: {
        turnBudget: config?.tiers?.[tier]?.turns ?? defaults.turns,
        tokenBudget: config?.tiers?.[tier]?.tokens ?? defaults.tokens,
      },
    };
  }

  /**
   * Gate state projected into snapshots. Present only while the gate would
   * actually enforce a `complete`, so consumers (the active-goal reminder
   * line today, TUI later) can key off presence instead of re-deriving the
   * trigger conditions.
   */
  private computeCompletionGateSnapshot(state: GoalState): GoalCompletionGateSnapshot | undefined {
    const gate = this.completionGateConfig();
    if (!gate.enabled || !completionGateEnforced(state)) return undefined;
    const check = gateCheckContext(state, gate, Date.now());
    let usable = 0;
    for (const receipt of state.evidence.receipts.values()) {
      if (checkGateReceipt(receipt, check) === null) usable += 1;
    }
    return {
      mutationsObserved: state.evidence.toolMutationIndex,
      usableReceipts: usable,
      staleReceipts: state.evidence.receipts.size - usable,
      lastMutationGoalTurn: state.evidence.lastMutationGoalTurn,
    };
  }

  private applyStatus(
    state: GoalState,
    status: GoalStatus,
  ): void {
    // Fold the live wall-clock interval into the running total when leaving
    // `active`, and anchor a fresh interval when entering it, so `wallClockMs`
    // stays a correct, persistable total across pause/resume/complete.
    const now = Date.now();
    if (state.status === 'active' && state.wallClockResumedAt !== undefined) {
      state.wallClockMs += Math.max(0, now - state.wallClockResumedAt);
      state.wallClockResumedAt = undefined;
    }
    if (status === 'active') {
      state.wallClockResumedAt = now;
    }
    state.status = status;
  }

  private requireState(): GoalState {
    const state = this.state;
    if (state === undefined) {
      throw new CloudCodeError(ErrorCodes.GOAL_NOT_FOUND, 'No current goal');
    }
    return state;
  }


  /**
   * Updates in-memory goal state and (unless `silent`) emits a `goal.updated`
   * event with the resulting snapshot. `silent` is used for per-step token /
   * wall-clock accounting so the UI is not updated on every step.
   */
  private persistState(
    state: GoalState | undefined,
    opts: { silent?: boolean; change?: GoalChange } = {},
  ): void {
    this.state = state;
    if (opts.silent !== true) {
      this.emitGoalUpdated(state === undefined ? null : this.toSnapshot(state), opts.change);
    }
  }

  private emitGoalUpdated(snapshot: GoalSnapshot | null, change?: GoalChange): void {
    this.agent.emitEvent({ type: 'goal.updated', snapshot, change });
  }

  /** Counter snapshot for a {@link GoalChange}. */
  private statsOf(state: GoalState): GoalChangeStats {
    return {
      turnsUsed: state.turnsUsed,
      tokensUsed: state.tokensUsed,
      wallClockMs: liveWallClockMs(state, Date.now()),
    };
  }

  private toSnapshot(state: GoalState): GoalSnapshot {
    return {
      goalId: state.goalId,
      objective: state.objective,
      completionCriterion: state.completionCriterion,
      status: state.status,
      turnsUsed: state.turnsUsed,
      tokensUsed: state.tokensUsed,
      wallClockMs: liveWallClockMs(state, Date.now()),
      budget: computeBudgetReport(state, Date.now()),
      terminalReason: state.terminalReason,
      terminalReasonCode: state.terminalReasonCode,
      terminalReasonDetail: state.terminalReasonDetail,
      completionGate: this.computeCompletionGateSnapshot(state),
    };
  }
}
