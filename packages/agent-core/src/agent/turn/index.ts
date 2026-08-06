import { createControlledPromise, type ControlledPromise } from '@antfu/utils';
import {
  APIContextOverflowError,
  type ContentPart,
  type Message,
} from '@cloud-code/kosong';
import { basename } from 'pathe';

import type { Agent } from '..';
import type { GoalReasonCode } from '../goal';
import { parseBooleanEnv } from '#/config/resolve';
import {
  ErrorCodes,
  type CloudCodeErrorPayload,
  isCloudCodeError,
  makeErrorPayload,
  toCloudCodeErrorPayload,
} from '#/errors';
import {
  isAbortError,
  isMaxStepsExceededError,
  isRateLimitPauseError,
  type RateLimitPauseError,
} from '../../loop/errors';
import {
  createLoopEventDispatcher,
  runTurn,
  type ExecutableToolResult,
  type FinalizeToolResultContext,
  type ForegroundRetryGate,
  type LoopEvent,
  type LoopRecordedEvent,
  type LoopTurnStopReason,
} from '../../loop/index';
import type { AgentEvent, TurnEndedEvent, TurnEndReason } from '../../rpc';
import { gateImageFormatParts } from '../../tools/support/image-compress';
import { abortable, isUserCancellation, userCancellationReason } from '../../utils/abort';
import { USER_PROMPT_ORIGIN, type PromptOrigin } from '../context';
import {
  captureMediaStripSnapshot,
  stripMediaPartsBySnapshot,
  type MediaStripSnapshot,
} from '../context/projector';
import { renderHookResult, renderUserPromptHookBlockResult, renderUserPromptHookResult, type HookResult } from '../../session/hooks';
import { isPlainRecord } from './canonical-args';
import { degradeUnresolvedVideoToTag, resolvePromptMedia } from './media-resolve';
import { ToolCallDeduplicator } from './tool-dedup';
import { budgetToolResultForModel } from './tool-result-budget';

interface ActiveTurn {
  readonly turnId: number;
  readonly controller: AbortController;
  readonly promise: Promise<TurnEndResult>;
  readonly firstRequest: ControlledPromise<void>;
}

interface BufferedSteer {
  readonly input: readonly ContentPart[];
  readonly origin: PromptOrigin;
}

export interface TurnEndResult {
  readonly event: TurnEndedEvent;
  readonly stopReason?: LoopTurnStopReason;
  readonly blockedByUserPromptHook?: boolean;
}

interface PromptHookEndResult {
  readonly event: TurnEndedEvent;
  readonly blocked: boolean;
}

const LLM_NOT_SET_MESSAGE = 'LLM not set, send "/login" to login';

/** Origin tag for the synthetic "continue" prompt that drives each goal turn. */
const GOAL_CONTINUATION_ORIGIN: PromptOrigin = { kind: 'system_trigger', name: 'goal_continuation' };
const GOAL_RATE_LIMIT_PAUSE_REASON = 'Paused after provider rate limit';
const GOAL_PROVIDER_CONNECTION_PAUSE_PREFIX = 'Paused after provider connection error';
const GOAL_PROVIDER_AUTH_PAUSE_PREFIX = 'Paused after provider authentication error';
const GOAL_PROVIDER_API_PAUSE_PREFIX = 'Paused after provider API error';
const GOAL_MODEL_CONFIG_PAUSE_PREFIX = 'Paused after model configuration error';
const GOAL_RUNTIME_PAUSE_PREFIX = 'Paused after runtime error';
const GOAL_PROVIDER_FILTERED_PAUSE_REASON = 'Paused after provider safety policy block';

/**
 * max_output_tokens recovery chain (Claude-Code `query.ts` parity): when a
 * step truncates on the completion cap without any tool call, first retry the
 * request once per turn with the cap escalated to this high value; if that
 * still truncates, inject a meta resume message and let the model continue,
 * bounded to a fixed number of continuations per turn.
 */
const MAX_OUTPUT_TOKENS_ESCALATED_CAP = 64_000;
const MAX_OUTPUT_TOKENS_RECOVERY_LIMIT = 3;
const MAX_OUTPUT_TOKENS_RECOVERY_PROMPT =
  'Output token limit hit. Resume directly — no apology, no recap of what you were doing. ' +
  'Pick up mid-thought if that is where the cut happened. Break remaining work into smaller pieces.';

/**
 * Headroom ratio for PTL drain-chain level 0: after force-arming the cheap
 * graduated layers, the overflow counts as resolved without an LLM call when
 * the re-estimated request fits under effectiveMax × this ratio (initial
 * value, pending calibration).
 */
const PTL_DRAIN_L0_HEADROOM_RATIO = 0.9;

/**
 * The prompt the goal driver appends to start each continuation turn — the
 * autonomous stand-in for the user typing "continue". The model decides when to
 * stop by calling `UpdateGoal`; otherwise the driver runs another turn.
 */
const GOAL_CONTINUATION_PROMPT = [
  'Continue working toward the active goal.',
  'Keep the self-audit brief. Do not explore unrelated interpretations once the goal can be',
  'decided. If the objective is simple, already answered, impossible, unsafe, or contradictory,',
  'do not run another goal turn. Explain briefly if useful, then call UpdateGoal with `complete`',
  'or `blocked` in the same turn. Otherwise, weigh the objective and any completion criteria',
  'against the work done so far, choose one bounded, useful slice of work, and use the existing',
  'conversation context and your tools. Do not try to finish a broad goal in one turn unless the',
  'whole goal is genuinely small. Most goal turns should not call UpdateGoal: after completing a',
  'useful slice, if material work remains, end the turn normally without calling UpdateGoal so',
  'the runtime can continue the goal in the next turn. Call UpdateGoal with `complete` only when',
  'all required work is done, any stated validation has passed, and there is no useful next',
  'action. Completion audit: before calling `complete`, verify the current state against the',
  'actual objective and every explicit requirement. Treat weak or indirect evidence as not',
  'complete. Do not mark complete after only producing a plan, summary, first pass, or partial',
  'result. Do not mark complete merely because a budget is nearly exhausted or you want to stop.',
  'Blocked audit: do not call UpdateGoal with `blocked` the first time you hit a blocker. Use',
  '`blocked` only for a genuine impasse: an external condition, required user input, missing',
  'credentials or permissions, or a persistent technical failure. For those non-terminal',
  'blockers, the same blocking condition must repeat for at least 3 consecutive goal turns before',
  'you call `blocked`, counting the original/user-triggered turn and automatic continuations.',
  'If a previously blocked goal is resumed, treat the resumed run as a fresh blocked audit.',
  'Exception: if the objective itself is impossible, unsafe, or contradictory, call UpdateGoal',
  'with `blocked` in the same turn; do not run more goal turns just to satisfy the audit. Do not',
  'use `blocked` because the work is large, hard, slow, uncertain, incomplete, still needs',
  'validation, would benefit from clarification, or needs more goal turns. Once the 3-turn',
  'threshold is met and you cannot make meaningful progress without user input or an',
  'external-state change, call UpdateGoal with `blocked`; do not keep reporting the blocker while',
  'leaving the goal active. Do not ask the user for input unless a real blocker prevents progress.',
].join(' ');

/**
 * Goal-management tools never enter the completion-gate evidence ledger, and
 * mutation tools bump the goal mutation index instead of leaving receipts —
 * "my edit succeeded" must never double as completion evidence
 * (docs/phase5/goal-completion-gate.md §3.1).
 */
const GOAL_MANAGEMENT_TOOL_NAMES: ReadonlySet<string> = new Set([
  'CreateGoal',
  'UpdateGoal',
  'GetGoal',
  'SetGoalBudget',
]);
const GOAL_MUTATION_TOOL_NAMES: ReadonlySet<string> = new Set(['Edit', 'Write']);

/** Cap on the single-line summary kept on each goal evidence receipt. */
const GOAL_EVIDENCE_SUMMARY_MAX_CHARS = 80;

/**
 * Variant of {@link GOAL_CONTINUATION_PROMPT} used when the previous goal turn
 * ended by hitting the per-turn step limit (`loop_control.max_steps_per_turn`).
 * The limit fragments goal work into more continuation turns instead of
 * pausing the goal; the notice tells the model why, so it can size the next
 * slice to fit the limit.
 */
const GOAL_STEP_CAP_CONTINUATION_PROMPT = [
  'The previous goal turn reached the per-turn step limit before finishing its work,',
  'so a new turn was started for you. Pick up where that turn stopped and keep each',
  'slice of work small enough to fit the limit.',
  GOAL_CONTINUATION_PROMPT,
].join(' ');

export class TurnFlow {
  private steerBuffer: BufferedSteer[] = [];
  private turnId = -1;
  private activeTurn: 'resuming' | ActiveTurn | null = null;
  private readonly currentStepByTurn = new Map<number, number>();
  private currentStep = 0;
  /**
   * Tool calls announced during the current step. The max_output_tokens
   * recovery chain only applies to pure-text truncations: a truncation that
   * still carried tool calls gets synthetic interrupted results from the loop
   * and keeps its existing ending.
   */
  private currentStepToolCallCount = 0;
  /**
   * Cumulative tool calls dispatched by this agent across all its turns
   * (one per `tool.call` loop event, including calls closed unexecuted —
   * the same `tool_use`-block semantics Claude Code's progress tracker
   * counts). Scoped to this agent instance, so a worker's coordinator
   * `<task-notification>` reports its own `<tool_uses>`, matching the
   * per-worker cumulative scope of the sibling `<total_tokens>` field.
   */
  private totalToolCallCount = 0;
  /**
   * reasonix `WarnOnMissingToolCallReasoning` port: per-step reasoning
   * presence keyed by step uuid. `step.begin` arms an entry, a non-empty or
   * encrypted think part marks it, and `step.end` consumes it — a tool-call
   * step that ends without reasoning while thinking is enabled fires the
   * once-per-session warning below.
   */
  private readonly stepReasoningSeen = new Map<string, boolean>();
  private missingToolCallReasoningWarned = false;
  /**
   * Pending rate-limit auto-resume (C1 P2): armed when a turn ends as a
   * rate-limit pause. The session-level `setTimeout` retries the turn at
   * `resumeAtMs` unless a new prompt, a `turn.cancel`, or session teardown
   * cancels it first. Deliberately NOT the BackgroundManager — that is a task
   * execution system, not a timer system.
   */
  private rateLimitResume: {
    readonly turnId: number;
    readonly resumeAtMs: number;
    readonly attempt: number;
    readonly timer: ReturnType<typeof setTimeout>;
  } | null = null;
  /**
   * Consecutive pauses on the pause→resume→pause ring. Incremented when a
   * pause is scheduled, cleared by any completed turn; auto-resume gives up
   * once this reaches retryAutoResumeMaxAttempts (default 3).
   */
  private consecutiveRateLimitPauses = 0;
  /**
   * Whether the trailing restored turn ended via `turn.cancel` (04i interrupt
   * detection): a turn the user deliberately stopped is not an interruption
   * and must not get the resume-continuation reminder. Set by `abortTurn`
   * (the only path a cancel takes), cleared by the next prompt/steer launch
   * or restore, consumed and reset by `finishResume`. Live turns never read
   * it — it exists so replay can tell "cancelled" apart from "crashed".
   */
  private trailingTurnCancelled = false;
  /**
   * One-shot arm set by `cancel(..., { withdrawInput: true })`: the unwinding
   * turn withdraws its unanswered input from the context at its tail. Armed
   * only while a real turn is active (replay's `turn.cancel` finds no live
   * turn and never arms; the `context.withdraw_tail_input` record carries the
   * removal through resume instead). Cleared by the next launch.
   */
  private withdrawInputOnCancelPending = false;

  constructor(protected readonly agent: Agent) {}

  /** Best-effort agent id (main / generated id) derived from the agent homedir. */
  private get agentId(): string {
    return this.agent.homedir ? basename(this.agent.homedir) : this.agent.type;
  }

  // Returns the new turnId, or null if the turn was marked as resuming.
  prompt(input: readonly ContentPart[], origin: PromptOrigin = USER_PROMPT_ORIGIN): number | null {
    // The last funnel before a prompt lands in the session history: images
    // in formats providers reject (AVIF, HEIC, …) become text notices here,
    // so no caller — the SDK/RPC prompt path included — can poison the
    // session. Upstream ingestion points already gate; this is the backstop.
    const gated = gateImageFormatParts(input);
    this.agent.records.logRecord({
      type: 'turn.prompt',
      input: gated,
      origin,
    });
    return this.launch(gated, origin);
  }

  // Returns the new turnId, or null if the input was buffered as a steer
  // message or the turn was marked as resuming.
  steer(input: readonly ContentPart[], origin: PromptOrigin = USER_PROMPT_ORIGIN): number | null {
    // Same format gate as prompt() — steer input enters the history too.
    const gated = gateImageFormatParts(input);
    this.agent.records.logRecord({
      type: 'turn.steer',
      input: gated,
      origin,
    });
    // Buffer while a turn is active OR a manual compaction holds the context;
    // `onCompactionFinished` replays the buffer once compaction's full lifecycle
    // (summary + reinjection) is done. Returning null means "buffered" — which is
    // exactly what fire-and-forget callers (background notifications, cron) assume.
    if (this.activeTurn || this.agent.fullCompaction.isCompacting) {
      this.steerBuffer.push({ input: gated, origin });
      return null;
    }
    return this.launch(gated, origin);
  }

  retry(trigger?: string): number | null {
    return this.prompt([], { kind: 'retry', trigger });
  }

  private launch(input: readonly ContentPart[], origin: PromptOrigin): number | null {
    // A new prompt/steer supersedes any parked rate-limit auto-resume: the
    // user (or another driver) took over the session.
    this.cancelRateLimitResume();
    this.trailingTurnCancelled = false;
    // A stale withdrawal arm must never leak into a turn that did not ask for
    // it (e.g. a prompt that raced the previous turn's unwind).
    this.withdrawInputOnCancelPending = false;
    if (this.activeTurn) {
      this.agent.emitEvent({
        type: 'error',
        ...makeErrorPayload(
          'turn.agent_busy',
          `Cannot launch a new turn while another turn (ID ${this.turnId}) is active`,
          { details: { turnId: this.turnId } },
        ),
      });
      return null;
    }

    // While a manual/SDK compaction holds the context, defer the launch instead
    // of rejecting it: buffer the input and replay it from `onCompactionFinished`
    // once compaction's full lifecycle (summary + reinjection) completes. The
    // deferred turn's eventual `turn.started` lets PromptService associate the
    // pending prompt, so a prompt submitted mid-compaction completes normally
    // rather than getting stuck "running". (Auto compaction runs inside an active
    // turn, so the `activeTurn` check above already covers it.)
    if (this.agent.fullCompaction.isCompacting) {
      this.steerBuffer.push({ input, origin });
      return null;
    }

    // Per-turn setup (usage window, `turn.started`, appending the
    // prompt) now lives in `runOneTurn`, so a goal-driven run emits a clean
    // start/end pair per continuation turn rather than one mega-turn.
    const turnId = this.allocateTurnId();
    const controller = new AbortController();
    const promise = this.turnWorker(turnId, input, origin, controller.signal);
    const firstRequest = createControlledPromise<void>();
    this.activeTurn = {
      turnId,
      controller,
      promise,
      firstRequest,
    };

    void firstRequest.catch(() => undefined);
    void promise.then(firstRequest.reject, firstRequest.reject);

    return turnId;
  }

  /** Allocates the next monotonic turn id. */
  private allocateTurnId(): number {
    this.turnId += 1;
    return this.turnId;
  }

  restorePrompt(): void {
    if (this.activeTurn) {
      return;
    }
    this.trailingTurnCancelled = false;
    this.turnId += 1;
    this.activeTurn = 'resuming';
  }

  /**
   * Raise the turn counter to cover a turnId observed in a replayed loop event.
   * This is the authoritative source of the restored counter: every turn that
   * ran — a prompted turn, a goal continuation, or a steer-launched turn —
   * emits loop events carrying its real turnId, even though only prompted turns
   * write a `turn.prompt` record. Resuming then continues from `max + 1`. Only
   * ever raises the counter, never lowers it, so the live path (where `turnId`
   * is already allocated before any loop event) is unaffected.
   */
  observeRestoredTurnId(turnId: number): void {
    if (Number.isInteger(turnId) && turnId > this.turnId) {
      this.turnId = turnId;
    }
  }

  restoreSteer(input: readonly ContentPart[], origin: PromptOrigin): void {
    if (this.activeTurn) {
      this.steerBuffer.push({ input, origin });
      return;
    }
    this.trailingTurnCancelled = false;
    this.turnId += 1;
    this.activeTurn = 'resuming';
  }

  cancel(turnId?: number, reason?: unknown, options?: { readonly withdrawInput?: boolean }): void {
    // A user stop also drops any parked rate-limit auto-resume.
    this.cancelRateLimitResume();
    this.agent.records.logRecord({ type: 'turn.cancel', turnId });
    if (turnId !== undefined && turnId !== this.currentId) {
      return; // Ignore cancel for non-active turn
    }
    // Interrupt recall (Esc before any visible output): the client asks to
    // pull the interrupted input back out of the context. The removal itself
    // runs when this turn unwinds in runOneTurn — still ahead of turn.ended
    // and the idle release, so no queued prompt or RPC can land in between.
    if (options?.withdrawInput === true && this.hasActiveTurn) {
      this.withdrawInputOnCancelPending = true;
    }
    // A direct cancel (RPC / replay) is the user pressing stop. When the cancel
    // is propagated from an aborting signal (e.g. a subagent's deadline via
    // waitForCurrentTurn), carry that original reason instead so a timeout is
    // not mislabeled to the model as a deliberate user interruption.
    const cancelReason = reason ?? userCancellationReason();
    this.abortTurn(cancelReason);
    this.agent.subagentHost?.cancelAll(cancelReason);
  }

  get currentId() {
    return this.turnId;
  }

  get hasActiveTurn(): boolean {
    return this.activeTurn !== null && this.activeTurn !== 'resuming';
  }

  /** Cumulative tool calls this agent has dispatched (see totalToolCallCount). */
  get toolCallCount(): number {
    return this.totalToolCallCount;
  }

  private ensureActiveTurn(): ActiveTurn {
    if (this.activeTurn === null || this.activeTurn === 'resuming') {
      throw new Error('No active turn');
    }
    return this.activeTurn;
  }

  waitForCurrentTurn(signal?: AbortSignal | undefined): Promise<TurnEndResult> {
    const active = this.ensureActiveTurn();
    signal?.throwIfAborted();
    if (signal === undefined) return active.promise;

    const turnId = this.currentId;
    const onAbort = (): void => {
      this.agent.turn.cancel(turnId, signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });

    return abortable(active.promise, signal).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
  }

  waitForTurnFirstRequest(): Promise<void> {
    return this.ensureActiveTurn().firstRequest;
  }

  private abortTurn(reason: unknown) {
    if (this.activeTurn !== 'resuming') {
      // The reason (a user cancellation by default, or the originating signal's
      // reason when propagated) travels as signal.reason so tools settling on
      // this signal can report a deliberate user interruption distinctly from a
      // timeout/system abort. linkAbortSignal forwards it to linked subagents.
      this.activeTurn?.controller.abort(reason);
    }
    this.activeTurn = null;
    this.trailingTurnCancelled = true;
  }

  private flushSteerBuffer(): boolean {
    const steers = this.steerBuffer;
    if (steers.length === 0) return false;
    for (const steer of steers) {
      // Steer flushes happen at sites that cannot await an upload, so any
      // prompt-attached local video is degraded to an always-safe `<video
      // path>` tag here; the model uploads it in-turn via ReadMediaFile.
      this.agent.context.appendUserMessage(
        degradeUnresolvedVideoToTag(steer.input),
        steer.origin,
      );
    }
    steers.length = 0;
    return true;
  }

  /**
   * Interrupt recall: drop user-typed steers still waiting in the buffer (the
   * recalled text is back in the client's editor; a stale copy must not flush
   * into a later turn). Background/cron notifications keep their different
   * origins and stay buffered for delivery. Returns whether anything was
   * dropped — a dropped steer means the recalled input never reached the
   * history, so the caller skips the history-tail withdrawal.
   */
  private dropBufferedUserSteers(): boolean {
    const kept = this.steerBuffer.filter((steer) => steer.origin.kind !== 'user');
    if (kept.length === this.steerBuffer.length) return false;
    this.steerBuffer = kept;
    return true;
  }

  /**
   * Completion-gate P1 feed (docs/phase5/goal-completion-gate.md §3.1):
   * records one evidence receipt per finalized non-goal tool result, and bumps
   * the goal mutation index for a successful Edit/Write. Pure bookkeeping on
   * `GoalMode` — a no-op unless a goal is active, and nothing consumes the
   * ledger yet.
   */
  private feedGoalEvidence(
    turnId: number,
    ctx: FinalizeToolResultContext,
    result: ExecutableToolResult,
  ): void {
    const goal = this.agent.goal;
    if (goal.getActiveGoal() === null) return;
    const toolName = ctx.toolCall.name;
    if (GOAL_MUTATION_TOOL_NAMES.has(toolName)) {
      if (result.isError !== true) goal.recordMutation();
      return;
    }
    if (GOAL_MANAGEMENT_TOOL_NAMES.has(toolName)) return;
    goal.recordEvidence({
      receiptId: ctx.toolCall.id,
      toolName,
      turnId,
      step: ctx.stepNumber,
      ok: result.isError !== true,
      summary: goalEvidenceSummary(ctx.args, result),
    });
  }

  /**
   * Replay inputs (prompts or steers) that were deferred while a manual compaction
   * held the context. Called by `FullCompaction` once the compaction lifecycle
   * (summary + reinjection) is done — and on cancel/failure — so deferred input is
   * never lost or stuck. If a turn is somehow already active (e.g. one that raced
   * and cancelled the compaction), let it consume the buffer like any other steer;
   * otherwise launch a fresh turn from the first buffered item, with the rest
   * draining into it via `flushSteerBuffer`.
   */
  onCompactionFinished(): void {
    if (this.steerBuffer.length === 0) return;
    if (this.activeTurn !== null) {
      this.flushSteerBuffer();
      return;
    }
    const next = this.steerBuffer.shift()!;
    this.launch(next.input, next.origin);
  }

  /**
   * End-of-resume teardown: release a trailing 'resuming' turn and drop
   * buffered steers (their originals are already in history via replay, or
   * were lost with the interrupted process). Returns whether the trailing
   * restored turn ended via `turn.cancel` — the resume-continuation injection
   * treats a deliberate stop as "not interrupted" — and resets the flag.
   */
  finishResume(): boolean {
    if (this.activeTurn === 'resuming') {
      this.activeTurn = null;
    }
    this.steerBuffer.length = 0;
    const cancelled = this.trailingTurnCancelled;
    this.trailingTurnCancelled = false;
    return cancelled;
  }

  /**
   * Arm the rate-limit auto-resume scheduler (C1 P2) after a turn ended as a
   * rate-limit pause. One pending resume at a time; arming emits
   * `turn.rate_limit_paused` so clients can show the countdown.
   */
  private scheduleRateLimitResume(turnId: number, error: RateLimitPauseError): void {
    this.cancelRateLimitResume();
    this.consecutiveRateLimitPauses += 1;
    const attempt = this.consecutiveRateLimitPauses;
    const resumeAtMs = Date.now() + error.resumeAfterMs;
    const timer = setTimeout(() => {
      void this.fireRateLimitResume();
    }, error.resumeAfterMs);
    // Never hold the process open for a pending resume: interactive sessions
    // stay alive on their own, and print/SDK runs must be free to exit after
    // the failed turn (session teardown cancels the timer explicitly).
    if (typeof timer === 'object' && typeof timer.unref === 'function') timer.unref();
    this.rateLimitResume = { turnId, resumeAtMs, attempt, timer };
    this.agent.emitEvent({ type: 'turn.rate_limit_paused', turnId, resumeAtMs, attempt });
  }

  /**
   * Fire-time gate for the parked resume: only an idle session with
   * auto-resume still enabled and the consecutive-pause budget intact is
   * retried; anything else lets the resume lapse (the failed turn and any
   * paused goal stay as they are). Emits `turn.rate_limit_resuming` just
   * before relaunching.
   */
  private async fireRateLimitResume(): Promise<void> {
    const pending = this.rateLimitResume;
    this.rateLimitResume = null;
    if (pending === null) return;
    const loopControl = this.agent.cloudCodeConfig?.loopControl;
    const autoResume = resolveRetryAutoResume(loopControl?.retryAutoResume) ?? true;
    if (!autoResume) return;
    const maxAttempts = resolveRetryAutoResumeMaxAttempts(loopControl?.retryAutoResumeMaxAttempts);
    if (this.consecutiveRateLimitPauses >= maxAttempts) {
      this.agent.log.warn('rate limit auto-resume gave up after consecutive pauses', {
        consecutivePauses: this.consecutiveRateLimitPauses,
        maxAttempts,
      });
      return;
    }
    if (this.hasActiveTurn || this.agent.fullCompaction.isCompacting) return;
    this.agent.emitEvent({
      type: 'turn.rate_limit_resuming',
      turnId: pending.turnId,
      attempt: pending.attempt,
    });
    // A goal parked by the pause (the driver pauses on the failed turn)
    // re-enters through the same entry as `/goal resume` — flip it active so
    // the retry turn is picked up by the goal driver.
    if (this.agent.goal.getGoal().goal?.status === 'paused') {
      try {
        await this.agent.goal.resumeGoal({}, 'runtime');
      } catch (error) {
        this.agent.log.warn('rate limit auto-resume could not resume the paused goal', { error });
      }
    }
    // The goal-resume await gave the session a window to become busy (e.g. a
    // user prompt landed) — re-check before relaunching.
    if (this.hasActiveTurn || this.agent.fullCompaction.isCompacting) return;
    this.retry('rate_limit_pause');
  }

  /**
   * Cancel a pending rate-limit auto-resume, if any. Called on new prompts,
   * `turn.cancel`, and session teardown. The consecutive-pause counter is
   * NOT reset here — only a completed turn clears it.
   */
  cancelRateLimitResume(): void {
    if (this.rateLimitResume === null) return;
    clearTimeout(this.rateLimitResume.timer);
    this.rateLimitResume = null;
  }

  /**
   * The body of the single in-flight `activeTurn`. Routes to the goal driver
   * (sequential continuation turns) when a goal is active, otherwise runs exactly
   * one turn. Clears `activeTurn` when the whole run finishes (identified by the
   * launch signal, so a superseding turn is never clobbered).
   */
  private async turnWorker(
    firstTurnId: number,
    input: readonly ContentPart[],
    origin: PromptOrigin,
    signal: AbortSignal,
  ): Promise<TurnEndResult> {
    const ownsActiveTurn = (): boolean =>
      this.activeTurn !== null &&
      this.activeTurn !== 'resuming' &&
      this.activeTurn.controller.signal === signal;
    try {
      const initialGoalStatus = this.agent.goal.getGoal().goal?.status;
      if (initialGoalStatus === 'active') {
        return await this.driveGoal(firstTurnId, input, origin, signal);
      }
      const end = await this.runOneTurn(firstTurnId, input, origin, signal, true);
      // A goal can become active during an ordinary turn: the model creates one
      // with CreateGoal, or resumes a paused/blocked goal via UpdateGoal. Either
      // way, hand the now-active goal to the driver so it is actually pursued,
      // instead of stopping after the turn that merely started it. (The
      // already-active case took the early return above.)
      const goalBecameActive = this.agent.goal.getGoal().goal?.status === 'active';
      // The same per-turn-step-limit exemption as the driver's continuation
      // loop: a turn that failed only at the step cap does not block the
      // handoff — pursuit starts with a fresh continuation turn (told why).
      const hitStepCap = isMaxStepsTurnFailure(end);
      if (
        goalBecameActive &&
        end.event.reason !== 'cancelled' &&
        end.event.reason !== 'blocked' &&
        (end.event.reason !== 'failed' || hitStepCap)
      ) {
        // The ordinary turn created or resumed the goal, so it counts as the
        // first active goal turn before the continuation driver takes over.
        const countedGoal = await this.agent.goal.incrementTurn();
        if (countedGoal?.budget.overBudget === true) {
          await this.agent.goal.markBlocked({ reason: 'A configured budget was reached' });
          return end;
        }
        return await this.driveGoal(
          this.allocateTurnId(),
          [
            {
              type: 'text',
              text: hitStepCap ? GOAL_STEP_CAP_CONTINUATION_PROMPT : GOAL_CONTINUATION_PROMPT,
            },
          ],
          GOAL_CONTINUATION_ORIGIN,
          signal,
        );
      }
      return end;
    } finally {
      if (ownsActiveTurn()) {
        this.activeTurn = null;
      }
    }
  }

  /**
   * Drives an active goal as a sequence of ordinary turns — the autonomous
   * equivalent of the user repeatedly typing "continue". Each iteration runs one
   * full turn, then reads the goal status the model set via `UpdateGoal`:
   * `complete` (the record is cleared) / `blocked` stop the loop; `active`
   * (the model didn't decide) re-injects the goal reminder and runs the
   * next continuation turn. Aborted or failed turns pause the goal — except a
   * turn that only failed by reaching the per-turn step limit, which just
   * fragments goal work into more continuation turns. Goal-state
   * blockers, such as explicit `UpdateGoal('blocked')`, prompt-hook blocks, and
   * budget limits, block it (all resumable). Returns the final turn's result.
   */
  private async driveGoal(
    firstTurnId: number,
    input: readonly ContentPart[],
    origin: PromptOrigin,
    signal: AbortSignal,
  ): Promise<TurnEndResult> {
    let turnId = firstTurnId;
    let turnInput = input;
    let turnOrigin = origin;
    while (true) {
      const goalBeforeTurn = this.agent.goal.getGoal().goal;
      if (goalBeforeTurn?.status === 'active' && goalBeforeTurn.budget.overBudget) {
        await this.agent.goal.markBlocked({ reason: 'A configured budget was reached' });
        const ended = await this.endGoalTurnWithoutModel(turnId, turnInput, turnOrigin);
        return { event: ended };
      }

      // Count the turn about to run (no-op if the goal isn't active), so the
      // completion stats include the turn in which the model reports `complete`.
      // Wall-clock is tracked live by the store (anchored while `active`), so the
      // timer is correct even when the model completes mid-turn.
      await this.agent.goal.incrementTurn();
      const end = await this.runOneTurn(turnId, turnInput, turnOrigin, signal, false);

      if (end.event.reason === 'cancelled') {
        await this.agent.goal.pauseOnInterrupt({
          reason: 'Paused after interruption',
          reasonCode: 'interruption',
        });
        return end;
      }
      // A turn that failed only by reaching the per-turn step limit ended at a
      // clean step boundary, so it is not a goal failure: fall through to the
      // normal continuation decision below and keep pursuing the goal. The
      // `turn.ended` event still reports the failure (and the limit) to hosts.
      const hitStepCap = isMaxStepsTurnFailure(end);
      if (end.event.reason === 'failed' && !hitStepCap) {
        await this.agent.goal.pauseActiveGoal(goalFailurePauseReason(end.event.error));
        return end;
      }
      if (end.event.reason === 'blocked' || end.blockedByUserPromptHook === true) {
        await this.agent.goal.markBlocked({ reason: 'Blocked by UserPromptSubmit hook' });
        return end;
      }

      // The model decides via UpdateGoal: a cleared record means `complete`;
      // `blocked` remains as a non-active record. Runtime failures and user
      // interrupts can still leave the goal paused. Only a still `active` goal
      // continues to another turn.
      const goal = this.agent.goal.getGoal().goal;
      if (goal === null || goal.status !== 'active') {
        return end;
      }
      // Hard budgets (turn / token / wall-clock, set via the SDK) are a
      // deterministic ceiling: block when reached. `blocked` is resumable.
      if (goal.budget.overBudget) {
        await this.agent.goal.markBlocked({ reason: 'A configured budget was reached' });
        return end;
      }

      turnId = this.allocateTurnId();
      turnInput = [
        {
          type: 'text',
          text: hitStepCap ? GOAL_STEP_CAP_CONTINUATION_PROMPT : GOAL_CONTINUATION_PROMPT,
        },
      ];
      turnOrigin = GOAL_CONTINUATION_ORIGIN;
    }
  }

  private async endGoalTurnWithoutModel(
    turnId: number,
    input: readonly ContentPart[],
    origin: PromptOrigin,
  ): Promise<TurnEndedEvent> {
    this.agent.usage.beginTurn();
    const startedAt = Date.now();
    this.agent.emitEvent({ type: 'turn.started', turnId, origin });
    // The budget-exhausted goal turn does not run the model, so it cannot
    // await an upload — degrade any local video to the always-safe tag form.
    this.agent.context.appendUserMessage(degradeUnresolvedVideoToTag(input), origin);
    const ended: TurnEndedEvent = {
      type: 'turn.ended',
      turnId,
      reason: 'completed',
      durationMs: Date.now() - startedAt,
    };
    this.agent.usage.endTurn();
    this.agent.emitEvent(ended);
    return ended;
  }

  /**
   * Runs exactly one logical turn end to end: per-turn bookkeeping, `turn.started`,
   * the prompt + goal reminder, the step loop, and `turn.ended`. Goal-agnostic —
   * the driver layers goal semantics on top. Never throws; abnormal ends are
   * mapped to a `cancelled`/`failed` `turn.ended` and returned.
   */
  private async runOneTurn(
    turnId: number,
    input: readonly ContentPart[],
    origin: PromptOrigin,
    signal: AbortSignal,
    standalone: boolean,
  ): Promise<TurnEndResult> {
    this.currentStep = 0;
    this.currentStepByTurn.set(turnId, 0);
    this.agent.fullCompaction.resetForTurn();
    this.agent.usage.beginTurn();
    this.agent.emitEvent({ type: 'turn.started', turnId, origin });

    const startedAt = Date.now();
    let ended: TurnEndedEvent;
    let blockedByUserPromptHook = false;
    let completedStopReason: LoopTurnStopReason | undefined;
    // Emitted after turn.ended (preserving prior ordering), so the error event
    // sits just past the turn.ended boundary that consumers watch for.
    let errorEvent: AgentEvent | undefined;
    try {
      // Resolve any prompt-attached local video (a `file://` video_url) into
      // its final delivered form — an uploaded `ms://` reference or an
      // inline/tag fallback — BEFORE it lands in history, so no unresolved
      // `file://` reference reaches the model or is persisted for resume. Auth
      // rejections surface as a failed turn via the catch below.
      const resolvedInput = await resolvePromptMedia(this.agent, input, signal);
      this.agent.context.appendUserMessage(resolvedInput, origin);
      // Shadow-git turn baseline (F4): must land before the first step — and
      // before the user-prompt hook, so hook-blocked turns get a baseline too
      // and stay aligned with the /undo anchor set. Best-effort; a snapshot
      // failure never blocks the turn. Captured AFTER the user message lands:
      // the baseline only reads the worktree, and the slow git probe must not
      // hold the prompt out of history (skill-activation resume depends on
      // the message being persisted ahead of any git I/O).
      await this.agent.snapshot.trackTurnBaseline(turnId, origin);
      const promptHookEnded = await this.applyUserPromptHook(turnId, resolvedInput, origin, signal, startedAt);
      if (promptHookEnded !== undefined) {
        ended = promptHookEnded.event;
        blockedByUserPromptHook = promptHookEnded.blocked;
      } else {
        const stopReason = await this.runStepLoop(turnId, signal);
        completedStopReason = stopReason;
        if (stopReason === 'filtered') {
          const summary = providerFilteredPayload(turnId);
          ended = {
            type: 'turn.ended',
            turnId,
            reason: 'failed',
            error: summary,
            durationMs: Date.now() - startedAt,
          };
          errorEvent = { type: 'error', ...summary };
        } else {
          const reason: TurnEndReason = stopReason === 'aborted' ? 'cancelled' : 'completed';
          ended = {
            type: 'turn.ended',
            turnId,
            reason,
            durationMs: Date.now() - startedAt,
          };
        }
      }
    } catch (error) {
      if (isAbortError(error)) {
        ended = { type: 'turn.ended', turnId, reason: 'cancelled', durationMs: Date.now() - startedAt };
      } else {
        const summary = summarizeTurnError(error, turnId);
        void this.agent.hooks?.fireAndForgetTrigger('StopFailure', {
          matcherValue: summary.name,
          inputData: { errorType: summary.name, errorMessage: summary.message },
        });
        ended = { type: 'turn.ended', turnId, reason: 'failed', error: summary, durationMs: Date.now() - startedAt };
        errorEvent = { type: 'error', ...summary };
        // Rate-limit pause (C1 P2): the retry loop refused an over-long wait,
        // so the turn ends failed (provider.rate_limit, carrying
        // resumeAfterMs/autoResume in the payload details) and the session
        // parks a timer to retry it. Emitted BEFORE turn.ended so consumers
        // see the pause ahead of the failure boundary. Goal mode needs no
        // special handling here: the driver pauses the goal on this failed
        // turn through its existing path, and the scheduler resumes it.
        if (isRateLimitPauseError(error)) {
          this.scheduleRateLimitResume(turnId, error);
        }
      }
    }
    // A live turn must never end with recorded tool calls still awaiting
    // results; if one does (a dispatch failure mid-batch broke the "every
    // recorded call gets a result" invariant), close the exchange now so the
    // context state machine cannot strand later messages in deferredMessages.
    this.closeAbandonedToolExchange(ended);
    // Interrupt-recall withdrawal, armed by cancel(..., { withdrawInput }):
    // remove the turn's unanswered input from the context HERE — after the
    // exchange teardown, ahead of turn.ended and the idle release — so the
    // removal is atomic with the cancel: no queued prompt or RPC can append
    // between it and the session going idle. The currentId guard skips the
    // withdrawal when a new turn already raced past this unwind. A recalled
    // steer still sitting in the steer buffer was never appended; drop it
    // there instead so it cannot silently flush into a later turn, and leave
    // the turn's original prompt in place.
    if (
      ended.reason === 'cancelled' &&
      this.withdrawInputOnCancelPending &&
      this.currentId === turnId
    ) {
      this.withdrawInputOnCancelPending = false;
      try {
        if (!this.dropBufferedUserSteers()) {
          this.agent.context.withdrawUnansweredTailInput();
        }
      } catch (error) {
        this.agent.log.warn('interrupt recall withdrawal failed', { error });
      }
    }
    // Emit the terminal turn.ended and (for a standalone turn) release the active
    // turn in the SAME synchronous frame, so the session is observably idle the
    // instant turn.ended fires. A goal drive keeps the active turn across its
    // continuation turns and releases it in `turnWorker` instead (`standalone`
    // is false for those).
    if (this.currentId === turnId) {
      this.agent.usage.endTurn();
    }
    // A user interrupt (e.g. Esc) aborts the turn without the normal Stop hook
    // firing, so external tooling that tracks status from hooks would otherwise
    // never see the turn stop. Emit an observation-only Interrupt event for it.
    // Gate on isUserCancellation: a `cancelled` turn can also come from a
    // programmatic abort (e.g. a subagent deadline timeout, which shares this
    // hook engine), and those must not be misreported as a user interrupt.
    if (ended.reason === 'cancelled' && isUserCancellation(signal.reason)) {
      void this.agent.hooks?.fireAndForgetTrigger('Interrupt', {
        inputData: { turnId, reason: 'cancelled' },
      });
    }
    this.agent.emitEvent(ended);
    // Release the active turn in the same frame as turn.ended for a standalone
    // turn, so the session is observably idle the instant turn.ended fires.
    // Exception: if the model turned the goal active during this turn (e.g.
    // CreateGoal), the session is NOT idle — turnWorker is about to drive the
    // goal. Keep the active turn alive (as the already-active goal path does) so
    // those autonomous continuations stay cancelable and exclude concurrent
    // turns; turnWorker releases it after the drive.
    if (
      standalone &&
      this.currentId === turnId &&
      this.agent.goal.getGoal().goal?.status !== 'active'
    ) {
      this.activeTurn = null;
    }
    if (this.agent.swarmMode.shouldAutoExit) {
      this.agent.swarmMode.exit();
    }
    if (errorEvent !== undefined) {
      this.agent.emitEvent(errorEvent);
    }
    this.currentStepByTurn.delete(turnId);
    if (ended.reason === 'completed') {
      // A successful turn breaks the pause→resume→pause ring (C1 P2).
      this.consecutiveRateLimitPauses = 0;
    }
    return { event: ended, stopReason: completedStopReason, blockedByUserPromptHook };
  }

  private async applyUserPromptHook(
    turnId: number,
    input: readonly ContentPart[],
    origin: PromptOrigin,
    signal: AbortSignal,
    startedAt: number,
  ): Promise<PromptHookEndResult | undefined> {
    if (origin.kind !== 'user') return undefined;
    signal.throwIfAborted();
    const promptHookResults = await this.agent.hooks?.trigger('UserPromptSubmit', {
      matcherValue: input,
      signal,
      inputData: { prompt: input },
    });
    signal.throwIfAborted();
    const blockResult = renderUserPromptHookBlockResult(promptHookResults);
    if (blockResult !== undefined) {
      this.agent.context.appendMessage({
        role: 'assistant',
        content: [{ type: 'text', text: blockResult.text }],
        toolCalls: [],
        origin: { kind: 'hook_result', event: 'UserPromptSubmit', blocked: true },
      });
      this.agent.emitEvent({
        type: 'hook.result',
        turnId,
        hookEvent: blockResult.event,
        content: blockResult.message,
        blocked: true,
      });
      // The terminal turn.ended is emitted by runOneTurn (synchronously with the
      // activeTurn clear), not here, so the session is idle the moment it fires.
      return {
        event: { type: 'turn.ended', turnId, reason: 'blocked', durationMs: Date.now() - startedAt },
        blocked: true,
      };
    }

    const hookResult = renderUserPromptHookResult(promptHookResults);
    if (hookResult === undefined) return undefined;

    this.agent.context.appendUserMessage([{ type: 'text', text: hookResult.text }], {
      kind: 'hook_result',
      event: 'UserPromptSubmit',
    });
    this.agent.emitEvent({
      type: 'hook.result',
      turnId,
      hookEvent: hookResult.event,
      content: hookResult.message,
    });
    return undefined;
  }

  private async runStepLoop(turnId: number, signal: AbortSignal): Promise<LoopTurnStopReason> {
    let stopHookContinuationUsed = false;
    let goalOutcomeMessageContinuationUsed = false;
    let goalOutcomeToolResultPending = false;
    // max_output_tokens recovery state (per turn): one cap escalation, then up
    // to MAX_OUTPUT_TOKENS_RECOVERY_LIMIT meta-message continuations.
    let maxOutputTokensEscalated = false;
    let maxOutputTokensRecoveryCount = 0;
    // PTL drain-chain level (per turn): 0 = L0 not tried, 1 = L0 armed, 2 =
    // L1 armed. Monotonic — a level arms at most once per turn; a successful
    // step (afterStep) resets it. Armed layer state itself persists across
    // turns (budget/clear/drain cutoffs), or the next request would PTL again.
    let ptlDrainLevel = 0;
    const deduper = new ToolCallDeduplicator();
    // Capture the per-run LLM instance so the recovery chain can adjust its
    // completion budget without touching durable agent config.
    const llm = this.agent.llm;
    await this.agent.mcp?.waitForInitialLoad(signal);
    // Surface the active goal at the start of the turn (append-only; no-op when
    // there is no active goal). Each goal continuation is its own turn, so this
    // re-injects the reminder once per turn rather than per step, preserving prompt caching.
    await this.agent.injection.injectGoal();
    // Announce loadable-tool changes at the same boundary cadence: a diff is
    // appended only when the loadable set actually changed, so quiet turns
    // keep the prompt cache fully warm.
    this.agent.injection.injectToolsDiff();
    // Same boundary cadence for `paths`-gated skill activations: heals
    // undo/compaction/resume gaps; a quiet turn appends nothing.
    this.agent.injection.injectSkillActivation();
    // Same boundary cadence for long-conversation behavioral-rule
    // re-injection (interval-gated; post-compaction re-injection lives in
    // injectAfterCompaction). Append-only; disabled config makes it a no-op.
    this.agent.injection.injectBehaviorReminders();
    let mediaStripSnapshot: MediaStripSnapshot | undefined;
    const buildMessagesMediaStripped = (): Message[] => {
      const messages = this.agent.context.messages;
      mediaStripSnapshot ??= captureMediaStripSnapshot(messages);
      return stripMediaPartsBySnapshot(messages, mediaStripSnapshot);
    };
    while (true) {
      signal.throwIfAborted();
      const model = this.agent.config.model;
      const loopControl = this.agent.cloudCodeConfig?.loopControl;
      const maxStepsPerTurn = resolveMaxStepsPerTurn(loopControl?.maxStepsPerTurn);
      const maxRetriesPerStep = resolveMaxRetriesPerStep(loopControl?.maxRetriesPerStep);
      // Foreground retry gates (C1 P2), re-resolved per step like the other
      // loop_control knobs; unset fields fall back to the loop's defaults.
      const foregroundRetryGate: ForegroundRetryGate = {
        maxDelayMs: resolveRetryForegroundMaxDelayMs(loopControl?.retryForegroundMaxDelayMs),
        maxTotalWaitMs: resolveRetryForegroundMaxTotalWaitMs(
          loopControl?.retryForegroundMaxTotalWaitMs,
        ),
        autoResume: resolveRetryAutoResume(loopControl?.retryAutoResume),
      };
      let stopForGoalBudget = false;
      try {
        const result = await runTurn({
          turnId: String(turnId),
          signal,
          llm,
          buildMessages: () => this.agent.context.messages,
          buildMessagesStrict: () => this.agent.context.strictMessages,
          buildMessagesMediaDegraded: () => this.agent.context.mediaDegradedMessages,
          buildMessagesMediaStripped,
          dispatchEvent: this.buildDispatchEvent(turnId),
          // Re-read per step (not snapshotted per turn) so a select_tools load
          // is dispatchable on the very next step of the same turn.
          buildTools: () => this.agent.tools.loopTools,
          describeMissingTool: (name) => this.agent.tools.missingToolMessage(name),
          log: this.agent.log,
          maxSteps: maxStepsPerTurn,
          maxRetryAttempts: maxRetriesPerStep,
          foregroundRetryGate,
          streamingToolExecution: loopControl?.streamingToolExecution,
          recordStepUsage: async (usage) => {
            try {
              const snapshot = await this.agent.goal.recordTokenUsage(usage.output);
              stopForGoalBudget = snapshot?.budget.overBudget === true;
            } catch (error) {
              this.agent.log.warn('goal token accounting failed', { error });
            }
          },
          onRequestTrace: () => {
            deduper.beginStep();
          },
          onRateLimit: (snapshot) => {
            // Failed-attempt capture of the Codex backend's `x-codex-*`
            // quota headers (a 429 carries them too): keeps /usage accurate
            // while the retry loop rides out a rate-limit window, instead
            // of going stale until the next successful response.
            this.agent.usage.recordRateLimit(snapshot);
          },
          hooks: {
            beforeStep: async ({ signal: stepSignal }) => {
              // Graduated compaction chain: cheap projection-side layers
              // (tool-result budget, pinpoint clear) arm first; the LLM full
              // summary escalates only when the effective token count still
              // crosses the strategy trigger.
              await this.agent.graduatedCompaction.beforeStep(stepSignal);
              // Flush steered messages (background-task / cron notifications,
              // user interrupts) AFTER compaction so they land in the
              // post-compaction context instead of being dropped by it. The
              // keep/drop decision lives in
              // `compactionUserMessageDisposition()`; these origins are not
              // re-injected later, so append them only after compaction runs.
              this.flushSteerBuffer();
              await this.agent.injection.inject();
              return;
            },
            // oxlint-disable-next-line no-loop-func -- drain-chain level state is scoped to this turn.
            afterStep: async ({ usage, stepNumber, rateLimit }) => {
              this.agent.usage.record(model, usage, 'turn');
              // Latest-wins capture of the Codex backend's `x-codex-*` quota
              // headers; every step of the turn refreshes the snapshot.
              if (rateLimit !== undefined) {
                this.agent.usage.recordRateLimit(rateLimit);
              }
              await this.agent.fullCompaction.afterStep();
              // A successful step also resets the PTL drain chain: the next
              // overflow in this turn starts again from L0.
              ptlDrainLevel = 0;
              // Shadow-git step track (F4): after `step.end` is sealed, before
              // the next step's generation. Best-effort, never throws.
              const stepTree = await this.agent.snapshot.trackAfterStep(turnId, stepNumber);
              // Completion-gate P1: backfill this step's goal-evidence receipts
              // with the step-end tree. No-op when no goal is active.
              this.agent.goal.stampReceiptTrees(stepTree, turnId, stepNumber);
              deduper.endStep();
              return stopForGoalBudget ? { stopTurn: true } : undefined;
            },
            // oxlint-disable-next-line no-loop-func -- stop hook continuation state is scoped to this turn.
            shouldContinueAfterStop: async (ctx) => {
              const { signal } = ctx;
              const flushedSteeredMessages = this.flushSteerBuffer();
              // 0. A reached hard goal budget is a deterministic ceiling. While
              //    the goal is still active, never extend the turn — neither a
              //    steered message nor a Stop-hook continuation — past it; end
              //    the turn so the goal driver blocks the goal at the boundary.
              //    Buffered steers are still flushed above so real-time user
              //    input is preserved in context even when the budget stops the
              //    turn. A goal the model just marked terminal is no longer
              //    active, so its final outcome message (step 2 below) still runs.
              if (stopForGoalBudget && this.agent.goal.getActiveGoal() !== null) {
                return { continue: false };
              }

              // 0.5. max_output_tokens recovery chain. Only pure-text
              //    truncations (no tool calls in the stopped step) qualify:
              //    truncations carrying tool calls were already closed with
              //    synthetic interrupted results by the loop and end here.
              if (ctx.stopReason === 'max_tokens' && this.currentStepToolCallCount === 0) {
                // Escalating retry, once per turn: raise the completion cap and
                //    let the model continue — no meta message. Skipped when the
                //    user explicitly capped completion tokens (their cap wins)
                //    or when the effective cap is already at/above the
                //    escalation target.
                if (!maxOutputTokensEscalated) {
                  maxOutputTokensEscalated = true;
                  const currentCap = llm.currentCompletionCap();
                  if (
                    !llm.hasExplicitCompletionHardCap &&
                    (currentCap === undefined || currentCap < MAX_OUTPUT_TOKENS_ESCALATED_CAP)
                  ) {
                    llm.setCompletionBudgetHardCapOverride(MAX_OUTPUT_TOKENS_ESCALATED_CAP);
                    return { continue: true };
                  }
                }
                // Meta recovery: inject a resume instruction so the model
                //    continues mid-thought. Continuations run at the configured
                //    budget again — each chunk only needs a normal-sized
                //    completion. Bounded per turn; exhaustion ends the turn
                //    with stopReason 'max_tokens' (subagent-host keeps treating
                //    that as a failed completion).
                if (maxOutputTokensRecoveryCount < MAX_OUTPUT_TOKENS_RECOVERY_LIMIT) {
                  maxOutputTokensRecoveryCount += 1;
                  llm.setCompletionBudgetHardCapOverride(undefined);
                  this.agent.context.appendUserMessage(
                    [{ type: 'text', text: MAX_OUTPUT_TOKENS_RECOVERY_PROMPT }],
                    { kind: 'system_trigger', name: 'max_output_tokens_recovery' },
                  );
                  return { continue: true };
                }
              }

              // 1. If steered user messages were flushed and no active-goal
              //    budget stopped the turn, let the model react to them.
              if (flushedSteeredMessages) return { continue: true };
              signal.throwIfAborted();

              // Print-mode drain: when `cloud-code -p` ends a turn while background
              // subagents are still running, hold the turn open and idle-wait
              // until they finish. Their completions steer into the buffer
              // during the wait and are flushed afterward, so the model gets
              // one wrap-up step to react (nominate, backfill, ...) before the
              // turn ends. The wait is bounded by each subagent's own timeout,
              // not by a separate drain deadline, so late-spawned or long-
              // running subagents are still observed. Gated on a session flag
              // so interactive / goal modes are unaffected.
              if (this.agent.printDrainAgentTasksOnStop) {
                const hasActiveAgentTask = this.agent.background
                  .list(true)
                  .some((task) => task.kind === 'agent');
                if (hasActiveAgentTask) {
                  await this.agent.background.waitForActiveTasks(
                    (task) => task.kind === 'agent',
                    { signal },
                  );
                  this.flushSteerBuffer();
                  return { continue: true };
                }
              }

              // 2. After UpdateGoal marks a goal terminal, its tool result carries
              //    the final-message reminder. Let the model read that result and
              //    produce one user-facing outcome message before the turn ends.
              if (
                !goalOutcomeMessageContinuationUsed &&
                goalOutcomeToolResultPending
              ) {
                goalOutcomeMessageContinuationUsed = true;
                goalOutcomeToolResultPending = false;
                if (!hasStepBudgetRemaining(maxStepsPerTurn, ctx.stepNumber)) {
                  return { continue: false };
                }
                return { continue: true };
              }

              // 3. The external Stop hook gets exactly one continuation; the cap
              //    is intentionally separate from (and does not cap) goal mode.
              if (!stopHookContinuationUsed) {
                const stopBlock = await this.agent.hooks?.triggerBlock('Stop', {
                  signal,
                  inputData: { stopHookActive: stopHookContinuationUsed },
                });
                signal.throwIfAborted();
                if (stopBlock !== undefined) {
                  stopHookContinuationUsed = true;
                  this.agent.context.appendUserMessage(
                    [{ type: 'text', text: stopBlock.reason }],
                    {
                      kind: 'system_trigger',
                      name: 'stop_hook',
                    },
                  );
                  return { continue: true };
                }
              }

              // 4. Otherwise stop. Goal continuation is no longer driven here:
              //    each goal turn is an ordinary turn, and the goal driver decides
              //    whether to run another after this one ends.
              return { continue: false };
            },
            prepareToolExecution: async (ctx) => {
              const cached = deduper.checkSameStep(
                ctx.toolCall.id,
                ctx.toolCall.name,
                ctx.args,
              );
              if (cached !== null) return { syntheticResult: cached };
              return undefined;
            },
            authorizeToolExecution: async (ctx) => {
              return this.agent.permission.beforeToolCall(ctx);
            },
            finalizeToolResult: async (ctx) => {
              // Calls rejected in preflight (e.g. invalid args) never reach
              // prepareToolExecution, so register them here — otherwise the
              // repeat breaker cannot count them and the model can re-issue
              // the same invalid call indefinitely.
              deduper.registerSkipped(
                ctx.toolCall.id,
                ctx.toolCall.name,
                ctx.args,
                ctx.toolCall.arguments,
              );
              // Resolve dedup BEFORE firing the PostToolUse hook so same-step
              // dups (whose ctx.result is the dedup placeholder) report the
              // original's real outcome, not an empty success.
              const finalResult = await deduper.finalizeResult(
                ctx.toolCall.id,
                ctx.toolCall.name,
                ctx.args,
                ctx.result,
              );
              const { isError } = finalResult;
              const event = isError === true ? 'PostToolUseFailure' : 'PostToolUse';
              // PostToolUse/PostToolUseFailure hooks are awaited (blocking) so
              // their `additionalContext` — and any block reason — can be
              // appended to the tool result the model sees. Timeouts and
              // failures resolve to plain allow results inside the engine, so
              // a broken hook can never wedge the turn.
              const hookResults = await this.triggerPostToolUseHooks(event, ctx, finalResult);
              const modelResult = await budgetToolResultForModel({
                homedir: this.agent.homedir,
                toolName: ctx.toolCall.name,
                toolCallId: ctx.toolCall.id,
                result: finalResult,
                thresholds: {
                  maxBytes: loopControl?.toolResultMaxBytes,
                  maxLines: loopControl?.toolResultMaxLines,
                },
              });
              // Hook context is appended AFTER budgeting so it cannot be
              // truncated away by the byte/line caps.
              const withHookContext = appendPostToolUseHookContext(
                modelResult,
                event,
                hookResults,
              );
              if (isError !== true) {
                // `paths`-gated skills: activate on touched files. The
                // announcement defers behind any open tool exchange, landing
                // at the tail right after this result — never in the prefix.
                this.agent.injection.activatePathSkillsForToolResult(
                  ctx.toolCall.name,
                  ctx.args,
                );
              }
              if (isTerminalUpdateGoalResult(ctx.toolCall.name, ctx.args, finalResult)) {
                goalOutcomeToolResultPending = true;
              }
              // Completion-gate P1: feed the goal evidence ledger from this
              // finalized result. Pure bookkeeping — a no-op unless a goal is
              // active, and nothing consumes the ledger yet.
              this.feedGoalEvidence(turnId, ctx, finalResult);
              return withHookContext;
            },
          },
        });

        return result.stopReason;
      } catch (error) {
        // PTL drain chain — opened only by a real provider prompt-too-long
        // rejection. Own CloudCodeError(context.overflow) (import overflow,
        // compaction caps) skips the chain and keeps the previous
        // straight-to-L2 behavior, so self-thrown errors never re-enter it.
        if (error instanceof APIContextOverflowError) {
          const estimatedRequestTokens = this.agent.fullCompaction.estimateCurrentRequestTokens();
          // Chain head: the observed window is an input to the L0 threshold.
          this.agent.fullCompaction.observeContextOverflow(estimatedRequestTokens);
          if (this.agent.graduatedCompaction.config.ptlDrain.enabled) {
            if (ptlDrainLevel === 0) {
              ptlDrainLevel = 1;
              // L0: force-arm the cheap graduated layers ignoring their
              // trigger ratios; resolved without an LLM call when the
              // re-estimated projection fits with headroom.
              await this.agent.graduatedCompaction.armForOverflow();
              const effectiveMax = this.agent.fullCompaction.getEffectiveMaxContextTokens();
              if (
                this.agent.fullCompaction.estimateCurrentRequestTokens() <
                effectiveMax * PTL_DRAIN_L0_HEADROOM_RATIO
              ) {
                continue;
              }
            }
            if (ptlDrainLevel === 1) {
              ptlDrainLevel = 2;
              // L1: precision head-drop sized to the provider-reported token
              // gap, still without an LLM call. Gives up on a giant single
              // round and falls through to L2.
              const gapTokens =
                error.promptTokens !== undefined && error.limitTokens !== undefined
                  ? error.promptTokens - error.limitTokens
                  : undefined;
              if (this.agent.graduatedCompaction.armPtlDrain(gapTokens)) {
                continue;
              }
            }
          }
          // L2: full LLM compaction, unchanged. Its exhaustion throw is L3.
          await this.agent.fullCompaction.handleOverflowError(signal, error, {
            drainLevelsExhausted: ptlDrainLevel,
          });
          continue; // Retry with compacted context
        }
        const isContextOverflow = isCloudCodeError(error) && error.code === ErrorCodes.CONTEXT_OVERFLOW;
        const estimatedRequestTokens = isContextOverflow
          ? this.agent.fullCompaction.estimateCurrentRequestTokens()
          : undefined;
        if (
          isContextOverflow ||
          this.agent.fullCompaction.shouldRecoverFromContextOverflow(error, estimatedRequestTokens)
        ) {
          this.agent.fullCompaction.observeContextOverflow(
            estimatedRequestTokens ?? this.agent.fullCompaction.estimateCurrentRequestTokens(),
          );
          await this.agent.fullCompaction.handleOverflowError(signal, error);
          continue; // Retry with compacted context
        }
        if (isMaxStepsExceededError(error)) {
          this.agent.log.warn('turn hit max steps', {
            turnId,
            steps: this.currentStepByTurn.get(turnId) ?? this.currentStep,
            limit: isCloudCodeError(error) ? error.details?.['maxSteps'] : undefined,
          });
        } else if (isRateLimitPauseError(error)) {
          // A rate-limit pause is a scheduled recovery, not a failure: keep it
          // out of the error log. runOneTurn arms the auto-resume timer.
          this.agent.log.info('turn paused on rate limit; auto-resume scheduled', {
            turnId,
            resumeAfterMs: error.resumeAfterMs,
            attempts: error.attempts,
            totalWaitMs: error.totalWaitMs,
          });
        } else {
          this.agent.log.error('turn failed', { turnId, error });
        }
        throw error;
      }
    }
  }

  // Guarded so this repair can never turn a finished turn into a crash: a
  // failure to close (e.g. record persistence still broken) is logged and the
  // projection-level safeguards remain the last line of defense.
  private closeAbandonedToolExchange(ended: TurnEndedEvent): void {
    try {
      const closed = this.agent.context.closeAbandonedToolExchange(
        abandonedToolResultOutput(ended),
      );
      if (closed === 0) return;
      this.agent.log.warn('closed abandoned tool exchange at turn end', {
        turnId: ended.turnId,
        reason: ended.reason,
        closed,
      });
    } catch (error) {
      this.agent.log.warn('failed to close abandoned tool exchange', { error });
    }
  }

  private buildDispatchEvent(turnId: number) {
    return createLoopEventDispatcher({
      appendTranscriptRecord: async (event: LoopRecordedEvent) => {
        this.agent.context.appendLoopEvent(event);
      },
      emitLiveEvent: (event: LoopEvent) => {
        this.noteFirstRequestEvent(event);
        this.noteStepProgress(event, turnId);
        this.noteToolCallReasoning(event);
        const mapped = mapLoopEvent(event, turnId);
        if (mapped !== undefined) this.agent.emitEvent(mapped);
      },
    });
  }

  /**
   * Fire PostToolUse/PostToolUseFailure hooks and return their results for
   * context injection. Skips the trigger entirely when nothing is registered
   * for the event, so tool-result finalization stays free of hook overhead on
   * the hookless hot path.
   */
  private async triggerPostToolUseHooks(
    event: 'PostToolUse' | 'PostToolUseFailure',
    ctx: FinalizeToolResultContext,
    finalResult: ExecutableToolResult,
  ): Promise<readonly HookResult[] | undefined> {
    const hooks = this.agent.hooks;
    if (hooks === undefined || !hooks.hasHooksForEvent(event)) return undefined;
    const { isError, output } = finalResult;
    return hooks.trigger(event, {
      matcherValue: ctx.toolCall.name,
      signal: ctx.signal,
      inputData: {
        toolName: ctx.toolCall.name,
        toolInput: toolInputRecord(ctx.args),
        toolCallId: ctx.toolCall.id,
        error: isError === true ? toCloudCodeErrorPayload(toolOutputText(output)) : undefined,
        toolOutput: isError === true ? undefined : toolOutputText(output).slice(0, 2000),
      },
      // The resolved execution is not retained at finalize time, so `if`
      // conditions here match tool-name-only patterns; conditions with an
      // argument pattern cannot be evaluated and skip the hook.
      ifContext: { toolName: ctx.toolCall.name },
    });
  }

  private noteFirstRequestEvent(event: LoopEvent): void {
    switch (event.type) {
      case 'step.end':
      case 'content.part':
      case 'tool.call':
      case 'text.delta':
      case 'thinking.delta':
      case 'tool.call.delta': {
        const active = this.activeTurn;
        if (active === null || active === 'resuming') return;
        active.firstRequest.resolve();
        return;
      }
      default:
        return;
    }
  }

  /**
   * Per-step progress bookkeeping: the current step counters feed the
   * max-steps log line and the max_output_tokens recovery chain (pure-text
   * truncations only).
   */
  private noteStepProgress(event: LoopEvent, turnId: number): void {
    if (event.type === 'step.begin') {
      this.currentStepByTurn.set(turnId, event.step);
      this.currentStep = event.step;
      this.currentStepToolCallCount = 0;
      return;
    }
    if (event.type === 'tool.call') {
      this.currentStepToolCallCount += 1;
      this.totalToolCallCount += 1;
    }
  }

  /**
   * Per-step reasoning bookkeeping for the missing-tool-call-reasoning
   * warning. A think part counts as reasoning only when it carries content —
   * an encrypted signature block (Anthropic redacted/signed thinking) counts
   * too, since it round-trips on its own.
   */
  private noteToolCallReasoning(event: LoopEvent): void {
    switch (event.type) {
      case 'step.begin':
        this.stepReasoningSeen.set(event.uuid, false);
        return;
      case 'content.part': {
        const part = event.part;
        if (part.type === 'think' && (part.think.trim().length > 0 || part.encrypted !== undefined)) {
          this.stepReasoningSeen.set(event.stepUuid, true);
        }
        return;
      }
      case 'step.end': {
        const seenReasoning = this.stepReasoningSeen.get(event.uuid) ?? false;
        this.stepReasoningSeen.delete(event.uuid);
        if (
          event.finishReason === 'tool_use' &&
          !seenReasoning &&
          this.agent.config.thinkingEffort !== 'off'
        ) {
          this.warnOnMissingToolCallReasoning();
        }
        return;
      }
      default:
        return;
    }
  }

  /**
   * reasonix `WarnOnMissingToolCallReasoning` port: with thinking enabled, a
   * tool-call step whose response carried no reasoning leaves nothing to
   * round-trip on the next request — the thinking context is lost. Surface it
   * once per session, both to the session log and as a user-facing warning
   * event.
   */
  private warnOnMissingToolCallReasoning(): void {
    if (this.missingToolCallReasoningWarned) return;
    this.missingToolCallReasoningWarned = true;
    this.agent.log.warn(
      'tool-call step completed without reasoning while thinking is enabled; thinking context will not round-trip',
      { thinkingEffort: this.agent.config.thinkingEffort },
    );
    this.agent.emitEvent({
      type: 'warning',
      code: 'missing-tool-call-reasoning',
      message:
        'Thinking is enabled, but the model returned no reasoning for a tool-call step. The reasoning context cannot be sent back on the next request, so the model may lose its train of thought.',
    });
  }
}

const MAX_STEPS_PER_TURN_ENV = 'CLOUD_CODE_LOOP_MAX_STEPS_PER_TURN';
const MAX_RETRIES_PER_STEP_ENV = 'CLOUD_CODE_LOOP_MAX_RETRIES_PER_STEP';
const RETRY_FOREGROUND_MAX_DELAY_MS_ENV = 'CLOUD_CODE_LOOP_RETRY_FOREGROUND_MAX_DELAY_MS';
const RETRY_FOREGROUND_MAX_TOTAL_WAIT_MS_ENV =
  'CLOUD_CODE_LOOP_RETRY_FOREGROUND_MAX_TOTAL_WAIT_MS';
const RETRY_AUTO_RESUME_ENV = 'CLOUD_CODE_LOOP_RETRY_AUTO_RESUME';
const RETRY_AUTO_RESUME_MAX_ATTEMPTS_ENV = 'CLOUD_CODE_LOOP_RETRY_AUTO_RESUME_MAX_ATTEMPTS';

/** Default consecutive-pause budget for rate-limit auto-resume (C1 P2). */
export const DEFAULT_RETRY_AUTO_RESUME_MAX_ATTEMPTS = 3;

/**
 * Resolve the effective per-turn step cap. Precedence:
 * `CLOUD_CODE_LOOP_MAX_STEPS_PER_TURN` (non-negative integer) → config
 * (`loop_control.max_steps_per_turn`) → `undefined` (no cap). `0` means no
 * cap, same as the config field; an invalid env value is ignored.
 */
export function resolveMaxStepsPerTurn(configValue?: number): number | undefined {
  return nonNegativeIntFromEnv(MAX_STEPS_PER_TURN_ENV) ?? configValue;
}

/**
 * Resolve the effective per-step retry budget. Precedence:
 * `CLOUD_CODE_LOOP_MAX_RETRIES_PER_STEP` (non-negative integer) → config
 * (`loop_control.max_retries_per_step`) → `undefined` (the loop's built-in
 * default). An invalid env value is ignored.
 */
export function resolveMaxRetriesPerStep(configValue?: number): number | undefined {
  return nonNegativeIntFromEnv(MAX_RETRIES_PER_STEP_ENV) ?? configValue;
}

/**
 * Resolve the single-wait foreground gate (C1 P2). Precedence:
 * `CLOUD_CODE_LOOP_RETRY_FOREGROUND_MAX_DELAY_MS` (positive integer, ms) →
 * config (`loop_control.retry_foreground_max_delay_ms`) → `undefined` (the
 * loop's built-in default, 60s).
 */
export function resolveRetryForegroundMaxDelayMs(configValue?: number): number | undefined {
  return positiveIntFromEnv(RETRY_FOREGROUND_MAX_DELAY_MS_ENV) ?? configValue;
}

/**
 * Resolve the cumulative per-step foreground gate (C1 P2). Precedence:
 * `CLOUD_CODE_LOOP_RETRY_FOREGROUND_MAX_TOTAL_WAIT_MS` (positive integer,
 * ms) → config (`loop_control.retry_foreground_max_total_wait_ms`) →
 * `undefined` (the loop's built-in default, 150s).
 */
export function resolveRetryForegroundMaxTotalWaitMs(configValue?: number): number | undefined {
  return positiveIntFromEnv(RETRY_FOREGROUND_MAX_TOTAL_WAIT_MS_ENV) ?? configValue;
}

/**
 * Resolve whether rate-limit pauses auto-resume (C1 P2). Precedence:
 * `CLOUD_CODE_LOOP_RETRY_AUTO_RESUME` (boolean) → config
 * (`loop_control.retry_auto_resume`) → `undefined` (the loop's default, on).
 */
export function resolveRetryAutoResume(configValue?: boolean): boolean | undefined {
  return parseBooleanEnv(process.env[RETRY_AUTO_RESUME_ENV]) ?? configValue;
}

/**
 * Resolve the consecutive-pause budget for auto-resume (C1 P2). Precedence:
 * `CLOUD_CODE_LOOP_RETRY_AUTO_RESUME_MAX_ATTEMPTS` (positive integer) →
 * config (`loop_control.retry_auto_resume_max_attempts`) → 3.
 */
export function resolveRetryAutoResumeMaxAttempts(configValue?: number): number {
  return (
    positiveIntFromEnv(RETRY_AUTO_RESUME_MAX_ATTEMPTS_ENV) ??
    configValue ??
    DEFAULT_RETRY_AUTO_RESUME_MAX_ATTEMPTS
  );
}

function nonNegativeIntFromEnv(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw.length === 0 || !/^\d+$/.test(raw)) return undefined;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function positiveIntFromEnv(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw.length === 0 || !/^\d+$/.test(raw)) return undefined;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : undefined;
}

function hasStepBudgetRemaining(maxSteps: number | undefined, currentStep: number): boolean {
  return maxSteps === undefined || maxSteps <= 0 || currentStep < maxSteps;
}

/**
 * Append PostToolUse/PostToolUseFailure hook output to the tool result the
 * model sees: each hook's structured `additionalContext`, plus the reason of
 * any blocking hook (exit code 2 / `permissionDecision: 'deny'`), wrapped in
 * the shared `<hook_result>` envelope.
 */
function appendPostToolUseHookContext(
  result: ExecutableToolResult,
  event: 'PostToolUse' | 'PostToolUseFailure',
  hookResults: readonly HookResult[] | undefined,
): ExecutableToolResult {
  if (hookResults === undefined || hookResults.length === 0) return result;
  const injections: string[] = [];
  for (const hookResult of hookResults) {
    if (hookResult.action === 'block') {
      const reason =
        hookResult.reason?.trim() ?? hookResult.message?.trim() ?? 'Blocked by hook';
      injections.push(
        renderHookResult(event, reason.length > 0 ? reason : 'Blocked by hook'),
      );
      continue;
    }
    const additionalContext = hookResult.additionalContext?.trim();
    if (additionalContext !== undefined && additionalContext.length > 0) {
      injections.push(renderHookResult(event, additionalContext));
    }
  }
  if (injections.length === 0) return result;

  const text = '\n\n' + injections.join('\n');
  const output = result.output;
  if (typeof output === 'string') {
    return { ...result, output: output + text };
  }
  const parts = [...output];
  const last = parts.at(-1);
  if (last !== undefined && last.type === 'text') {
    parts[parts.length - 1] = { type: 'text', text: last.text + text };
  } else {
    parts.push({ type: 'text', text });
  }
  return { ...result, output: parts };
}

/**
 * True when a turn ended `failed` only because it reached the per-turn step
 * limit (`loop_control.max_steps_per_turn`). Such a turn stopped at a clean
 * step boundary, so goal pursuit continues instead of pausing.
 */
function isMaxStepsTurnFailure(end: TurnEndResult): boolean {
  return (
    end.event.reason === 'failed' &&
    end.event.error?.code === ErrorCodes.LOOP_MAX_STEPS_EXCEEDED
  );
}

function isTerminalUpdateGoalResult(
  toolName: string,
  args: unknown,
  result: ExecutableToolResult,
): boolean {
  if (toolName !== 'UpdateGoal' || result.isError === true || result.stopTurn !== true) {
    return false;
  }
  if (!isPlainRecord(args)) return false;
  const status = args['status'];
  return status === 'complete' || status === 'blocked';
}

function mapLoopEvent(event: LoopEvent, turnId: number): AgentEvent | undefined {
  switch (event.type) {
    case 'step.begin':
      return {
        type: 'turn.step.started',
        turnId,
        step: event.step,
        stepId: event.uuid,
      };
    case 'step.end':
      return {
        type: 'turn.step.completed',
        turnId,
        step: event.step,
        stepId: event.uuid,
        usage: event.usage,
        finishReason: event.finishReason,
        llmFirstTokenLatencyMs: event.llmFirstTokenLatencyMs,
        llmStreamDurationMs: event.llmStreamDurationMs,
        llmRequestBuildMs: event.llmRequestBuildMs,
        llmServerFirstTokenMs: event.llmServerFirstTokenMs,
        llmServerDecodeMs: event.llmServerDecodeMs,
        llmClientConsumeMs: event.llmClientConsumeMs,
        providerFinishReason: event.providerFinishReason,
        rawFinishReason: event.rawFinishReason,
      };
    case 'step.retrying':
      return {
        type: 'turn.step.retrying',
        turnId,
        step: event.step,
        stepId: event.stepUuid,
        failedAttempt: event.failedAttempt,
        nextAttempt: event.nextAttempt,
        maxAttempts: event.maxAttempts,
        delayMs: event.delayMs,
        errorName: event.errorName,
        errorMessage: event.errorMessage,
        statusCode: event.statusCode,
      };
    case 'content.part':
      return undefined;
    case 'tool.call':
      return {
        type: 'tool.call.started',
        turnId,
        toolCallId: event.toolCallId,
        name: event.name,
        args: event.args,
        description: event.description,
        display: event.display,
      };
    case 'tool.result':
      return {
        type: 'tool.result',
        turnId,
        toolCallId: event.toolCallId,
        output: event.result.output,
        isError: event.result.isError,
        display: event.result.display,
        structured: event.result.structured,
      };
    case 'turn.interrupted':
      if (event.activeStep === undefined) return undefined;
      return {
        type: 'turn.step.interrupted',
        turnId,
        step: event.activeStep,
        reason: event.reason,
        message: event.message,
      };
    case 'text.delta':
      return {
        type: 'assistant.delta',
        turnId,
        delta: event.delta,
      };
    case 'thinking.delta':
      return {
        type: 'thinking.delta',
        turnId,
        delta: event.delta,
      };
    case 'tool.call.delta':
      return {
        type: 'tool.call.delta',
        turnId,
        toolCallId: event.toolCallId,
        name: event.name,
        argumentsPart: event.argumentsPart,
      };
    case 'tool.progress':
      return {
        type: 'tool.progress',
        turnId,
        toolCallId: event.toolCallId,
        update: event.update,
      };
  }
}

function summarizeTurnError(error: unknown, turnId: number): CloudCodeErrorPayload {
  const payload = toCloudCodeErrorPayload(error);
  const details = { ...payload.details, turnId };

  // Substitute a friendlier TUI-aware message for model-not-configured.
  // The raw "Model not set" / "Provider not set" text is not actionable;
  // this string points the user at the login flow.
  if (payload.code === 'model.not_configured') {
    return { ...payload, message: LLM_NOT_SET_MESSAGE, details };
  }

  return { ...payload, details };
}

function providerFilteredPayload(turnId: number): CloudCodeErrorPayload {
  return {
    code: ErrorCodes.PROVIDER_FILTERED,
    message: 'Provider safety policy blocked the response.',
    name: 'ProviderFilteredError',
    details: { finishReason: 'filtered', turnId },
    retryable: false,
  };
}

function goalFailurePauseReason(error: TurnEndedEvent['error']): {
  readonly reason: string;
  readonly reasonCode: GoalReasonCode;
  readonly reasonDetail?: string;
} {
  if (error?.code === ErrorCodes.PROVIDER_RATE_LIMIT) {
    return { reason: GOAL_RATE_LIMIT_PAUSE_REASON, reasonCode: 'rate_limit' };
  }
  if (error?.code === ErrorCodes.PROVIDER_CONNECTION_ERROR) {
    return pauseReasonWithDetail(GOAL_PROVIDER_CONNECTION_PAUSE_PREFIX, 'provider_connection', error.message);
  }
  if (error?.code === ErrorCodes.PROVIDER_AUTH_ERROR) {
    return pauseReasonWithDetail(GOAL_PROVIDER_AUTH_PAUSE_PREFIX, 'provider_auth', error.message);
  }
  if (error?.code === ErrorCodes.PROVIDER_FILTERED) {
    return { reason: GOAL_PROVIDER_FILTERED_PAUSE_REASON, reasonCode: 'provider_filtered' };
  }
  if (error?.code === ErrorCodes.PROVIDER_API_ERROR) {
    return pauseReasonWithDetail(GOAL_PROVIDER_API_PAUSE_PREFIX, 'provider_api', error.message);
  }
  if (
    error?.code === ErrorCodes.MODEL_NOT_CONFIGURED ||
    error?.code === ErrorCodes.MODEL_CONFIG_INVALID
  ) {
    return pauseReasonWithDetail(GOAL_MODEL_CONFIG_PAUSE_PREFIX, 'model_config', error.message);
  }
  return pauseReasonWithDetail(GOAL_RUNTIME_PAUSE_PREFIX, 'runtime', error?.message);
}

function pauseReasonWithDetail(
  prefix: string,
  reasonCode: GoalReasonCode,
  message: string | undefined,
): { readonly reason: string; readonly reasonCode: GoalReasonCode; readonly reasonDetail?: string } {
  const hasDetail = message !== undefined && message.length > 0;
  return {
    reason: hasDetail ? `${prefix}: ${message}` : prefix,
    reasonCode,
    ...(hasDetail ? { reasonDetail: message } : {}),
  };
}

function toolInputRecord(args: unknown): Record<string, unknown> {
  return isPlainRecord(args) ? args : {};
}

function toolOutputText(output: ExecutableToolResult['output']): string {
  if (typeof output === 'string') return output;
  return output
    .filter((part): part is Extract<(typeof output)[number], { type: 'text' }> => {
      return typeof part === 'object' && part !== null && part.type === 'text';
    })
    .map((part) => part.text)
    .join('');
}

/**
 * Single-line, length-capped hint of what a goal evidence receipt observed:
 * the command for shell-style calls, otherwise the first line of the result
 * output. Display text for future gate-refusal messages only — never parsed.
 */
function goalEvidenceSummary(args: unknown, result: ExecutableToolResult): string {
  const command = isPlainRecord(args) ? args['command'] : undefined;
  const text = typeof command === 'string' ? command : toolOutputText(result.output);
  const firstLine = text.split('\n', 1)[0] ?? '';
  return firstLine.length > GOAL_EVIDENCE_SUMMARY_MAX_CHARS
    ? firstLine.slice(0, GOAL_EVIDENCE_SUMMARY_MAX_CHARS)
    : firstLine;

}

// Output for a tool call abandoned by its turn (see closeAbandonedToolExchange):
// name the cause so the model treats the gap as an interruption to reason about,
// not a tool outcome. Mirrors the phrasing of the resume-time synthesis in
// `ContextMemory`.
function abandonedToolResultOutput(ended: TurnEndedEvent): string {
  const cause =
    ended.reason === 'cancelled'
      ? 'the turn was cancelled'
      : ended.reason === 'failed'
        ? `the turn failed${ended.error !== undefined ? ` (${ended.error.message})` : ''}`
        : 'the turn ended';
  return `Tool call did not complete: ${cause} before its result was recorded. Do not assume the tool completed successfully.`;
}
