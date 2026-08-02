import type {
  ContentPart,
  RateLimitSnapshot,
  ThinkingEffort,
  TokenUsage,
} from '@cloud-code/kosong';

import type { LoopRecordedEvent } from '../../loop';
import type { GoalActor, GoalBudgetLimits, GoalReasonCode, GoalStatus } from '../goal';
import type { MCPToolDefinition } from '../../mcp/types';
import type { ToolStoreUpdate } from '../../tools/store';
import type { CompactionBeginData, CompactionResult } from '../compaction';
import type { AgentConfigUpdateData } from '../config';
import type { ContextMessage, PromptOrigin } from '../context';
import type { PermissionApprovalResultRecord, PermissionMode } from '../permission';
import type { McpToolCollision, UserToolRegistration } from '../tool';
import type { UsageRecordScope } from '../usage';
import type { SwarmModeTrigger } from '../swarm';

/** One entry of a tools table as sent in a request's top-level `tools[]`. */
export interface LlmRequestToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

// Agent records are the ordered event log used to rebuild agent state on resume.
// Use records, not state.json, when correctness depends on the order in which
// state transitions happened.
//
// Two record classes exist, and being persisted is not the same as being
// replayed:
//   - State records (the default): each type must have explicit state-rebuild
//     semantics in restoreAgentRecord; a write-only state record is not
//     persistence.
//   - Observability records (`llm.tools_snapshot`, `llm.request`,
//     `mcp.tools_discovered`): a durable trace of the data sent to the model,
//     for debugging and trajectory replay. They never feed state rebuild;
//     their only resume semantics is restoring the write-dedup cursors so a
//     resumed session does not re-log snapshots it already persisted.
export interface AgentRecordEvents {
  metadata: {
    protocol_version: string;
    created_at: number;
  };

  forked: {};

  'turn.prompt': {
    input: readonly ContentPart[];
    origin: PromptOrigin;
  };
  'turn.steer': {
    input: readonly ContentPart[];
    origin: PromptOrigin;
  };
  'turn.cancel': { turnId?: number };

  'config.update': AgentConfigUpdateData;

  'permission.set_mode': {
    mode: PermissionMode;
  };
  'permission.record_approval_result': PermissionApprovalResultRecord;

  'full_compaction.begin': CompactionBeginData;

  'plan_mode.enter': {
    id: string;
  };
  'plan_mode.cancel': {
    id?: string;
  };
  'plan_mode.exit': {
    id?: string;
  };

  /**
   * Worktree session transitions (EnterWorktree/ExitWorktree). The paired
   * `config.update` cwd records sit immediately after `worktree.enter` and
   * `worktree.exit` in the wire, so replay restores the switched cwd through
   * the ordinary config path while these restore the WorktreeMode state.
   */
  'worktree.enter': {
    name: string;
    path: string;
    branch: string;
    originalCwd: string;
    originalBranch?: string;
    headCommit: string;
    mainRepoRoot: string;
  };
  'worktree.exit': {
    action: 'keep' | 'remove';
    path: string;
    branch?: string;
    discardedFiles?: number;
    discardedCommits?: number;
  };

  'swarm_mode.enter': {
    trigger: SwarmModeTrigger;
  };
  'swarm_mode.exit': {};

  'coordinator_mode.enter': {};
  'coordinator_mode.exit': {};

  'tools.register_user_tool': UserToolRegistration;
  'tools.unregister_user_tool': {
    name: string;
  };
  'tools.set_active_tools': {
    names: readonly string[];
    /**
     * Profile denylist applied on top of `names` (agentfile
     * `disallowedTools`). Optional for backwards compatibility: wires written
     * before deny support (and v2-engine wires) carry no deny state.
     */
    disallowedNames?: readonly string[];
  };

  'usage.record': {
    model: string;
    usage: TokenUsage;
    usageScope?: UsageRecordScope | undefined;
  };

  /**
   * Latest ChatGPT Codex rate-limit snapshot captured from the official
   * backend's `x-codex-*` response headers (kosong
   * `parseCodexRateLimitHeaders` yields one only when that header family is
   * present, i.e. the chatgpt.com Codex backend). Written latest-wins on
   * every step that carries a snapshot; replay restores it into the usage
   * recorder so a resumed session's `/usage` shows the last known quota
   * state immediately (the panel marks it stale as it ages) instead of
   * staying empty until the first post-resume response.
   */
  'usage.rate_limit': {
    snapshot: RateLimitSnapshot;
  };

  'full_compaction.cancel': {};
  'full_compaction.complete': {};
  /**
   * Legacy pre-rename pinpoint-clear application record (written by the
   * removed MicroCompaction). Restore routes it into the graduated chain's
   * pinpoint-clear layer, whose cutoff semantics are identical.
   */
  'micro_compaction.apply': { cutoff: number };
  /** Graduated chain layer application; replays into `GraduatedCompaction`. */
  'graduated_compaction.apply': {
    layer: 'tool_result_budget' | 'pinpoint_clear' | 'ptl_drain';
    cutoff: number;
  };

  'context.append_message': { message: ContextMessage };
  'context.append_loop_event': { event: LoopRecordedEvent };
  'context.update_token_count': { tokenCount: number };
  'context.clear': {};
  'context.apply_compaction': CompactionResult;
  'context.undo': { count: number };
  /**
   * Interrupt-recall removal: the turn was cancelled before producing any
   * output, so the unanswered tail user input was pulled back out of the
   * context (see `ContextMemory.withdrawUnansweredTailInput`). Logged only
   * when a message was actually removed; restore replays through the same
   * mutator, re-deriving the removal from the rebuilt tail.
   */
  'context.withdraw_tail_input': {};

  /**
   * Shadow-git snapshot of the workspace (F4). `turn_baseline` is written
   * before a turn's first step; `anchor` marks baselines whose turn began
   * from a user-anchored prompt (the /undo anchor set), so the count→turnId
   * mapping used by /rewind survives resume. `step` records carry the
   * cumulative file list relative to that turn's baseline.
   */
  'snapshot.track': {
    turnId: number;
    kind: 'turn_baseline' | 'step';
    step?: number;
    tree: string;
    files: readonly string[];
    anchor?: boolean;
  };
  /**
   * A file rewind back to a tracked turn's baseline (F4). `preRewindTree`
   * captures the pre-rewind worktree so a future redo/unrewind can restore
   * it. Restore is audit-only: the shadow repo's objects are content
   * addressed, so no in-memory index needs rebuilding from this record.
   */
  'snapshot.rewind': {
    turnId: number;
    preRewindTree: string;
    files: readonly string[];
  };

  'tools.update_store': ToolStoreUpdate;

  'goal.create': {
    goalId: string;
    objective: string;
    completionCriterion?: string;
    actor?: GoalActor;
  };
  'goal.update': {
    status?: GoalStatus;
    tokensUsed?: number;
    turnsUsed?: number;
    wallClockMs?: number;
    budgetLimits?: GoalBudgetLimits;
    reason?: string;
    reasonCode?: GoalReasonCode;
    reasonDetail?: string;
    actor?: GoalActor;
  };
  'goal.clear': {};

  // Observability records (see the header note): request-trace data, not
  // state. Resume only restores the write-dedup cursors.

  /**
   * Content-addressed snapshot of a request's top-level `tools[]` (after the
   * `deferred` strip — exactly what the provider receives). Written once per
   * unique table; `llm.request.toolsHash` points here.
   */
  'llm.tools_snapshot': {
    hash: string;
    tools: readonly LlmRequestToolSchema[];
  };

  /**
   * One record per outbound model request (every retry attempt, strict
   * resend, and compaction round included). Together with `config.update`
   * (system prompt full text), context records (messages), and
   * `llm.tools_snapshot` (tool schemas), this makes each request
   * reconstructable from the wire log at the logical-request level.
   */
  'llm.request': {
    kind: 'loop' | 'compaction' | 'guardian' | 'title';
    provider: string;
    model: string;
    modelAlias?: string;
    /**
     * Provider-effective thinking effort — for Kimi providers this is derived
     * from the request body's thinking payload, so env overrides
     * (`KIMI_MODEL_THINKING_EFFORT`) are already reflected.
     */
    thinkingEffort?: ThinkingEffort;
    /**
     * Kimi preserved-thinking passthrough (`thinking.keep`) in effect for
     * this request — resolved from env, config, and the default, none of
     * which are otherwise recorded.
     */
    thinkingKeep?: string;
    /** Effective env-driven sampling overrides (Kimi provider only). */
    temperature?: number;
    topP?: number;
    /**
     * Effective completion-token cap the provider sends on the wire — read
     * from the effective provider, so provider-side clamping (remaining
     * context window, transport ceilings) and provider-level defaults (e.g.
     * Anthropic's required `max_tokens`) are included.
     */
    maxTokens?: number;
    betaApi?: boolean;
    /** Progressive tool disclosure in effect (env flag × model capability). */
    toolSelect: boolean;
    systemPromptHash: string;
    /**
     * Inlined only when the request's system prompt differs from the current
     * `config.update` value (no such caller today; defensive for future ones).
     */
    systemPrompt?: string;
    toolsHash: string;
    messageCount: number;
    turnStep?: string;
    attempt?: string;
    /** Set when this request is a fallback resend (strict rebuild,
     * media-degraded rebuild, or media-stripped rebuild). */
    projection?: 'strict' | 'media-degraded' | 'media-stripped';
    /** Compaction only: messages dropped so far by overflow/empty shrinking. */
    droppedCount?: number;
    /**
     * Prefix-drift attribution vs. the previously recorded request (F7 cache
     * diagnostics): which prefix dimension moved (`system`, `tools`,
     * `projection`, `graduated_rewrite`). Absent when the prefix shape was
     * stable. Optional — wire records written by older versions simply lack
     * it.
     */
    prefixDriftReasons?: readonly ('system' | 'tools' | 'projection' | 'graduated_rewrite')[];
    /**
     * Section-level refinement of a `system` drift: ids of the system
     * prompt sections whose content moved, per the section assembly
     * (`profile/system-prompt-sections.ts`). Absent when the drift has no
     * `system` dimension or either prompt is not a known assembly (e.g. an
     * override prompt set directly through `config.update`). Additive —
     * older readers ignore it.
     */
    systemPromptChangedSections?: readonly string[];
  };

  /**
   * Raw MCP `tools/list` result as advertised by the server, plus how this
   * agent gated it (allow-list, name collisions). Written on registration,
   * deduplicated per server by content hash.
   */
  'mcp.tools_discovered': {
    serverName: string;
    hash: string;
    tools: readonly MCPToolDefinition[];
    enabledNames: readonly string[];
    collisions?: readonly McpToolCollision[];
  };

  /**
   * One completed guardian review (F3). Restore only re-pushes the matching
   * `guardian_assessment` replay event so a resumed session can render past
   * assessments; no model call or circuit-breaker state replays.
   */
  'guardian.assessment': {
    turnId: number;
    toolCallId: string;
    toolName: string;
    outcome: 'allow' | 'deny';
    riskLevel: 'low' | 'medium' | 'high' | 'critical';
    userAuthorization: 'unknown' | 'low' | 'medium' | 'high';
    rationale: string;
    model: string;
    durationMs: number;
    traceId?: string;
  };

  /**
   * A guardian review that failed (timeout / parse / session error) and was
   * handled fail-closed. Observability only; restore is a no-op.
   */
  'guardian.review_failed': {
    turnId: number;
    toolCallId: string;
    toolName: string;
    failureKind: 'timeout' | 'parse' | 'session';
    fallback: 'ask' | 'deny';
    durationMs: number;
  };

  /**
   * The guardian circuit breaker tripped for a turn (too many reviewer
   * denials); subsequent reviews in that turn fall back without a model call.
   * Observability only; restore is a no-op (breaker state is per-turn runtime
   * state, and a resumed session starts a fresh turn anyway).
   */
  'guardian.circuit_breaker_tripped': {
    turnId: number;
    consecutiveDenials: number;
    windowDenials: number;
  };

  /**
   * A persistent PTY shell session was registered (ExecSession, RFC
   * `docs/rfc/unified-exec-pty.md` §3.5 v2). Observability only: the durable
   * lifecycle trail for trajectory replay/debugging. Restore is a no-op —
   * sessions never survive a CLI restart, and the lost-session reconcile +
   * model notification ride the background task persistence (ghost → lost →
   * `restoreBackgroundTaskNotifications`), not these records.
   */
  'shell_session.start': {
    sessionId: string;
    command: string;
    pid: number;
  };

  /**
   * A persistent PTY shell session ended (natural exit, stop, or manager
   * reclamation). `exitCode` is null when the session was destroyed before
   * the process exit was observed (idle reaper / LRU eviction); `reason`
   * carries that reclamation cause. Observability only; restore is a no-op.
   */
  'shell_session.exit': {
    sessionId: string;
    command: string;
    exitCode: number | null;
    reason?: string;
  };

  /**
   * Session listing metadata (title / lastPrompt) re-appended to the tail of
   * the main agent's wire log (04i metadata tail re-append). The authoritative
   * store for these fields is the session's `state.json`, owned by the Session
   * layer; this record keeps the wire tail window self-describing so the lite
   * reader (`session/store/wire-lite.ts`) can recover title/lastPrompt when
   * `state.json` is missing or stale (foreign migration, manual deletion),
   * and so a wire-only export carries them. Observability only: restore is a
   * no-op — replaying it must not feed any agent state rebuild.
   */
  'session.meta': {
    title?: string;
    isCustomTitle?: boolean;
    lastPrompt?: string;
  };
}

export type AgentRecord = {
  [K in keyof AgentRecordEvents]: Readonly<AgentRecordEvents[K]> & {
    readonly type: K;
    readonly time?: number;
  };
}[keyof AgentRecordEvents];

export type AgentRecordOf<K extends keyof AgentRecordEvents> = Extract<
  AgentRecord,
  { readonly type: K }
>;

export interface AgentRecordPersistence {
  read(): AsyncIterable<AgentRecord>;
  append(input: AgentRecord): void;
  rewrite(records: readonly AgentRecord[]): void;
  flush(): Promise<void>;
  close(): Promise<void>;
}
