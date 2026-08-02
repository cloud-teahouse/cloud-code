/**
 * Public contracts for the stateless agent loop.
 *
 * This file defines the narrow surfaces that connect a Kosong conversation to
 * tool execution, phase hooks, and turn results. Host-layer metadata, policy,
 * archival limits, and UI concerns stay outside these contracts.
 *
 * Field naming is camelCase unless a reused Kosong type says otherwise.
 * Optional fields use `?: T | undefined` intentionally under
 * `exactOptionalPropertyTypes: true`.
 */

import type { ContentPart, Message, RateLimitSnapshot, TokenUsage, Tool, ToolCall } from '@cloud-code/kosong';

import type { ToolInputDisplay, ToolResultDisplayRef, ToolResultStructured } from '../tools/display';
import type { GitSegmentClass } from '../tools/support/shell-ast/git-classify';
import type { ToolAccesses } from './tool-access';
import type { LLM } from './llm';

export type { ToolCall };

export type LoopMessageBuilder = () => Message[] | Promise<Message[]>;

/**
 * Stop reason for one completed model step.
 *
 * `tool_use` is a loop-control signal: the loop executes the requested tools and
 * continues with another step. The other values are terminal for the current
 * turn unless a host hook explicitly asks the loop to continue.
 */
export type LoopStepStopReason =
  | 'end_turn'
  | 'max_tokens'
  | 'tool_use'
  | 'filtered'
  | 'paused'
  | 'unknown';

export type LoopTerminalStepStopReason = Exclude<LoopStepStopReason, 'tool_use'>;

/**
 * Stop reasons that can be returned in a normal `TurnResult`.
 *
 * `tool_use` is intentionally absent because it cannot be the final result of a
 * completed turn. Errors and max-step exhaustion are represented by thrown
 * errors, not by this union. Compaction is a host-level retry concern rather
 * than a stop reason.
 */
export type LoopTurnStopReason = LoopTerminalStepStopReason | 'aborted';

/**
 * @deprecated Legacy umbrella union. Use `LoopStepStopReason` for per-step
 * model responses and `LoopTurnStopReason` for `TurnResult`.
 */
export type StopReason = LoopStepStopReason | 'aborted';

export interface TurnResult {
  stopReason: LoopTurnStopReason;
  steps: number;
  usage: TokenUsage;
}

export type ExecutableToolOutput = string | ContentPart[];

export interface ExecutableToolSuccessResult {
  readonly output: ExecutableToolOutput;
  readonly isError?: false | undefined;
  /**
   * Internal loop-control hint. Tool result events strip this field before
   * persistence; it only tells the current turn whether another model step or
   * later tool calls in the same batch are allowed.
   */
  readonly stopTurn?: boolean | undefined;
  /**
   * Optional human-readable side channel for tool-result metadata that
   * should not contaminate the data stream the model sees (e.g. a
   * "Task snapshot retrieved." brief for TaskOutput). Distinct from
   * `output`: callers rendering tool results decide whether to surface
   * this to the user.
   */
  readonly message?: string | undefined;
  /**
   * Optional side channel in the opposite direction of `message`: content
   * that is rendered to the model but never to user-facing UIs. Routed
   * verbatim — any formatting (tags, wording) is the producing tool's
   * choice. Appended to the tool result as a trailing text part when the
   * history is projected for the provider.
   */
  readonly note?: string | undefined;
  /**
   * True when the tool has already returned a partial result because it
   * truncated, paged, or otherwise dropped original output. Later generic
   * budgeting must not treat the visible output as complete source text.
   */
  readonly truncated?: boolean | undefined;
  /**
   * Localization pointer for the user-facing rendering of this result
   * (i18n key + interpolation params). The `output` text itself stays
   * English — the model reads it and parts of the UI parse it — while UIs
   * that know the key render the localized form instead. Persisted with
   * the transcript record so replay renders the same localized text.
   */
  readonly display?: ToolResultDisplayRef | undefined;
  /**
   * Structured outcome facts for clients that would otherwise parse the
   * `output` text (plan-approval markers, background `task_id:` prefixes,
   * agent envelopes, goal status). The output stays byte-identical for the
   * model and for old-session replay; consumers read these fields when
   * present and fall back to parsing the output when absent. UI-only —
   * never projected to the provider.
   */
  readonly structured?: ToolResultStructured | undefined;
}

export interface ExecutableToolErrorResult {
  readonly output: ExecutableToolOutput;
  readonly isError: true;
  /** See {@link ExecutableToolSuccessResult.message}. */
  readonly message?: string | undefined;
  /** See {@link ExecutableToolSuccessResult.note}. */
  readonly note?: string | undefined;
  /** See {@link ExecutableToolSuccessResult.stopTurn}. */
  readonly stopTurn?: boolean | undefined;
  /** See {@link ExecutableToolSuccessResult.truncated}. */
  readonly truncated?: boolean | undefined;
  /** See {@link ExecutableToolSuccessResult.display}. */
  readonly display?: ToolResultDisplayRef | undefined;
  /** See {@link ExecutableToolSuccessResult.structured}. */
  readonly structured?: ToolResultStructured | undefined;
}

export type ExecutableToolResult = ExecutableToolSuccessResult | ExecutableToolErrorResult;

export interface ToolUpdate {
  kind: 'stdout' | 'stderr' | 'progress' | 'status' | 'custom';
  text?: string | undefined;
  percent?: number | undefined;
  /** Vendor-defined event identifier when `kind === 'custom'`. */
  customKind?: string | undefined;
  /** Opaque payload paired with `customKind`. */
  customData?: unknown;
}

/**
 * Per-call context passed to tool implementations.
 */
export interface ExecutableToolContext {
  readonly turnId: string;
  readonly toolCallId: string;
  readonly traceId?: string;
  readonly metadata?: unknown;
  readonly signal: AbortSignal;
  readonly onUpdate?: ((update: ToolUpdate) => void) | undefined;
  /**
   * Fired once when a foreground (non-background) process task is registered,
   * carrying its task id. Used by the `!` shell-command path so the TUI can
   * later detach (ctrl+b) that exact task. Background runs skip it.
   */
  readonly onForegroundTaskStart?: ((taskId: string) => void) | undefined;
}

export interface RunnableToolExecution {
  readonly isError?: false | undefined;
  readonly accesses?: ToolAccesses | undefined;
  readonly display?: ToolInputDisplay | undefined;
  readonly description?: string;
  /**
   * Stops scheduling later tool calls in the same provider batch. Use this only
   * for tools whose successful action changes turn lifecycle state.
   */
  readonly stopBatchAfterThis?: boolean | undefined;
  readonly approvalRule: string;
  /**
   * Session-approval rules written when the user approves for the session.
   * Tools that decompose a call into independently-permissioned segments
   * (e.g. Bash splitting a compound command) provide one rule per segment;
   * absent → `[approvalRule]`.
   */
  readonly approvalRules?: readonly string[] | undefined;
  readonly matchesRule?: ((ruleArgs: string) => boolean) | undefined;
  /**
   * Permission-rule namespace for this call when it differs from the tool's
   * own name. ExecSession sets this to `'Bash'` so the `Bash(...)` approval
   * rules it writes match session creation exactly as they match one-shot
   * Bash calls — an approved `Bash(python *)` covers both (RFC
   * unified-exec-pty §3.4). Absent → rules are matched against the tool
   * call's own name.
   */
  readonly ruleToolName?: string | undefined;
  /**
   * Per-segment rule matching for decomposable tools. When present, the
   * permission chain matches rules against {@link subjects} instead of the
   * whole-call subject: deny/ask rules fire when ANY subject matches (∃),
   * allow rules fire only when ALL subjects are covered (∀, unioned across
   * rules). `matches` applies a rule's argument pattern to one subject and
   * must implement the same `!`-negation semantics as `matchesRule`.
   */
  readonly ruleMatch?: ToolRuleMatch | undefined;
  /**
   * Shell-AST degradation marker (F2): `true` when a compound command could
   * not be parsed and segment analysis fell back to the whole command string.
   * Surfaced for the guardian review action JSON (F3) so the reviewer judges
   * opaque commands accordingly. Absent for tools without AST decomposition.
   */
  readonly astDegraded?: boolean | undefined;
  /**
   * Per-segment git risk classes (C3 P3), aligned 1:1 with
   * {@link ToolRuleMatch.subjects}; entries are `undefined` for non-git
   * segments. Classification runs on the wrapper-stripped token view when
   * the producing tool has wrapper stripping enabled, so `sudo git push`
   * shows up as `shared-remote`. Surfaced for the git mutation gate
   * permission policy (and later the guardian `git_classes` evidence).
   * Absent for tools without AST decomposition.
   */
  readonly gitClasses?: readonly GitSegmentClass[] | undefined;
  readonly execute: (ctx: ExecutableToolContext) => Promise<ExecutableToolResult>;
}

export interface ToolRuleMatch {
  /** Segment subjects in their original order (e.g. `git add .`, `git push`). */
  readonly subjects: readonly string[];
  /**
   * `decision` (additive, C3 P2 wrapper stripping): the decision of the
   * rule being evaluated — `'allow' | 'ask' | 'deny'`, inlined here to
   * avoid a loop → permission import cycle. Implementations that strip
   * safe wrappers (sudo/timeout/env/…) MUST try the original subject
   * first, then strip asymmetrically: `'allow'` strips only safe-listed
   * env assignments (BINARY_HIJACK_VARS never), `'ask'`/`'deny'` strip
   * every leading assignment. Absent → original-subject matching only
   * (pre-P2 behavior).
   */
  matches(ruleArgs: string, subject: string, decision?: 'allow' | 'ask' | 'deny'): boolean;
}

export type ToolExecution = RunnableToolExecution | ExecutableToolErrorResult;

export interface ExecutableTool<Input = unknown> extends Tool {
  resolveExecution(input: Input): ToolExecution | Promise<ToolExecution>;
}

/**
 * Step hooks are aligned to recorded phase boundaries: `beforeStep` runs before
 * `step.begin`, while `afterStep` runs after `step.end`.
 */

export interface LoopStepHookContext {
  readonly turnId: string;
  readonly stepNumber: number;
  readonly signal: AbortSignal;
  readonly llm: LLM;
}

export interface ToolExecutionHookContext extends LoopStepHookContext {
  readonly traceId?: string;
  readonly toolCall: ToolCall;
  readonly toolCalls: readonly ToolCall[];
  readonly tool?: ExecutableTool | undefined;
  readonly args: unknown;
}

export interface ResolvedToolExecutionHookContext extends ToolExecutionHookContext {
  readonly execution: RunnableToolExecution;
}

export interface AuthorizeToolExecutionResult {
  readonly block?: boolean | undefined;
  readonly reason?: string | undefined;
  readonly syntheticResult?: ExecutableToolResult | undefined;
  readonly executionMetadata?: unknown;
  /**
   * Replacement args for this call. At the prepare phase the loop validates
   * them before resolving the execution; at the authorize phase the loop
   * re-validates and re-resolves the execution so the rewrite (e.g. a
   * PreToolUse hook's `updatedInput`) takes effect before anything runs.
   */
  readonly updatedArgs?: unknown;
}

/**
 * The prepare phase accepts the same decisions as authorize; historically it
 * was the only phase honoring `updatedArgs`, which now lives on the shared
 * parent since authorize-time rewrites (PreToolUse `updatedInput`) are
 * supported too.
 */
export type PrepareToolExecutionResult = AuthorizeToolExecutionResult;

export interface FinalizeToolResultContext extends ToolExecutionHookContext {
  readonly result: ExecutableToolResult;
}

export interface LoopAfterStepContext extends LoopStepHookContext {
  readonly usage: TokenUsage;
  readonly stopReason: LoopStepStopReason;
  /**
   * Rate-limit snapshot captured with this step's response (ChatGPT Codex
   * backend only); undefined for providers without quota headers.
   */
  readonly rateLimit?: RateLimitSnapshot | undefined;
}

export interface LoopStoppedStepContext extends LoopStepHookContext {
  readonly usage: TokenUsage;
  readonly stopReason: LoopTerminalStepStopReason;
}

export interface BeforeStepResult {
  readonly block?: boolean | undefined;
  readonly reason?: string | undefined;
}

export interface AfterStepResult {
  readonly stopTurn?: boolean | undefined;
}

export interface RecordStepUsageResult {
  /**
   * Internal loop-control hint. Hosts can return this after recording usage
   * when the completed model step has reached a hard runtime limit.
   */
  readonly stopTurn?: boolean | undefined;
}

export interface ShouldContinueAfterStopResult {
  readonly continue: boolean;
}

export type BeforeStepHook = (ctx: LoopStepHookContext) => Promise<BeforeStepResult | undefined>;

export type AfterStepHook = (ctx: LoopAfterStepContext) => Promise<AfterStepResult | void>;

export type PrepareToolExecutionHook = (
  ctx: ToolExecutionHookContext,
) => Promise<PrepareToolExecutionResult | undefined>;

export type AuthorizeToolExecutionHook = (
  ctx: ResolvedToolExecutionHookContext,
) => Promise<AuthorizeToolExecutionResult | undefined>;

export type FinalizeToolResultHook = (
  ctx: FinalizeToolResultContext,
) => Promise<ExecutableToolResult | undefined>;

export type ShouldContinueAfterStopHook = (
  ctx: LoopStoppedStepContext,
) => Promise<ShouldContinueAfterStopResult | undefined>;

/**
 * Groups every awaited phase hook.
 *
 * Hooks can affect control flow at deterministic transcript points. Event
 * listeners observe output and cannot change turn behavior.
 *
 * Tool hooks run serially in provider tool-call order before the matching
 * durable event is recorded, so preparation and finalization decisions are
 * resolved at stable transcript points.
 */
export interface LoopHooks {
  beforeStep?: BeforeStepHook | undefined;
  afterStep?: AfterStepHook | undefined;
  prepareToolExecution?: PrepareToolExecutionHook | undefined;
  authorizeToolExecution?: AuthorizeToolExecutionHook | undefined;
  finalizeToolResult?: FinalizeToolResultHook | undefined;
  shouldContinueAfterStop?: ShouldContinueAfterStopHook | undefined;
}
