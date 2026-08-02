import { createToolMessage, type ContentPart, type Message } from '@cloud-code/kosong';

import type { Agent } from '..';
import { ErrorCodes, CloudCodeError } from '../../errors';
import type { LoopRecordedEvent, LoopToolResultEvent } from '../../loop';
import { extractImageCompressionCaptions } from '../../tools/support/image-compress';
import { estimateTokens, estimateTokensForMessages } from '../../utils/tokens';
import { escapeXml, escapeXmlAttr } from '../../utils/xml-escape';
import {
  COMPACT_USER_MESSAGE_MAX_TOKENS,
  COMPACTION_ELISION_VARIANT,
  buildCompactionElisionText,
  collectCompactableUserMessages,
  isRealUserInput,
  pinnedDigestPrefixLength,
  selectCompactionUserMessages,
  selectRecentUserMessages,
  type CompactionInput,
  type CompactionResult,
} from '../compaction';
import { RESUME_CONTINUATION_VARIANT } from '../injection/resume-continuation';
import {
  captureMediaStripSnapshot,
  degradeOlderMediaParts,
  MEDIA_DEGRADE_KEEP_RECENT,
  project,
  ProjectionCache,
  stripMediaPartsBySnapshot,
  type ProjectionAnomaly,
  type ProjectOptions,
  trimTrailingOpenToolExchange,
} from './projector';
import { stripDynamicToolContext } from './dynamic-tools';
import {
  USER_PROMPT_ORIGIN,
  type AgentContextData,
  type ContextMessage,
  type PromptOrigin,
} from './types';

export * from './types';
export * from './dynamic-tools';

const TOOL_INTERRUPTED_ON_RESUME_OUTPUT =
  'Tool execution was interrupted before its result was recorded. Do not assume the tool completed successfully.';

export interface ContextFinishResumeResult {
  /**
   * Tool call ids closed by the end-of-resume interrupted-exchange repair.
   * Non-empty means the wire log ended mid tool exchange with no turn-end
   * teardown — a genuine crash/interruption signal (a live turn that ended
   * normally, was cancelled, or failed closes its abandoned calls at turn
   * end, so replay finds nothing left to close).
   */
  readonly closedToolCallIds: readonly string[];
}

/**
 * One structural drift finding from `auditAfterResume` (04i
 * `checkResumeConsistency` analog): the post-repair history still carries a
 * tool call with no result, a result with no call, or messages stranded in
 * the deferral queue.
 */
export interface ResumeAuditFinding {
  readonly kind:
    | 'tool_call_without_result'
    | 'tool_result_without_call'
    | 'stranded_deferred_messages';
  readonly toolCallId?: string;
  readonly count?: number;
}

/**
 * One structural repair the replay layer performed while rebuilding the
 * history (04i `checkResumeConsistency` analog — the "repaired" half of the
 * write→load round-trip drift report; `ResumeAuditFinding` is the
 * "unrepairable" half). Recorded only during restore: the live paths that
 * share these routines (turn-end teardown) are routine, not drift.
 */
export type ResumeRepairEntry =
  /** Open tool calls closed in place when the next replayed step began. */
  | { readonly kind: 'tool_calls_closed_at_step_boundary'; readonly toolCallIds: readonly string[] }
  /** Open tool calls closed at end of resume — the trailing interruption. */
  | { readonly kind: 'tool_calls_closed_at_resume_end'; readonly toolCallIds: readonly string[] }
  /** A step event referencing a step with no open begin (e.g. an undo that raced a live step) was skipped. */
  | {
      readonly kind: 'orphan_step_event_skipped';
      readonly eventType: 'content.part' | 'tool.call';
      readonly stepUuid: string;
    }
  /** A tool result whose call was never recorded (or was already settled) — dropped, output unrecoverable. */
  | { readonly kind: 'orphan_tool_result_dropped'; readonly toolCallId: string }
  /**
   * A late-arriving real result re-attached over the synthetic interrupted
   * placeholder the in-place close had left for its call (04i
   * `recoverOrphanedParallelToolResults` analog adapted to the event log:
   * the parallel batch's result was split off its exchange; the survivor is
   * re-hung in position instead of dropped).
   */
  | { readonly kind: 'late_tool_result_reattached'; readonly toolCallId: string };

const IMPORT_CONTEXT_GUIDANCE =
  'This is a prior conversation history that may be relevant to the current session. ' +
  'Please review this context and use it to inform your responses.';

// Invariant: _history must not contain an unresolved tool call exchange except
// at the tail. When the tail is unresolved, pendingToolResultIds is exactly the
// set of missing tool result ids for that tail exchange; appendMessage keeps
// later messages in deferredMessages until those ids are resolved.
export class ContextMemory {
  private _history: ContextMessage[] = [];
  private _tokenCount = 0;
  private tokenCountCoveredMessageCount = 0;
  private openSteps: Map<string, ContextMessage> = new Map();
  private pendingToolResultIds = new Set<string>();
  private deferredMessages: ContextMessage[] = [];
  private _lastAssistantAt: number | null = null;
  // Signature of the last logged set of projection repairs, so a repair that
  // recurs identically on every send is logged once rather than per step.
  private lastProjectionRepairSignature: string | null = null;
  // Restore-time structural repair ledger (see ResumeRepairEntry). Live closes
  // (turn-end teardown) do not record — they are routine, not drift.
  private readonly resumeRepairLog: ResumeRepairEntry[] = [];
  // Per-message projection memo (see ProjectionCache). Used only when
  // projecting the canonical `_history` — the identity-keyed entries rely on
  // history messages being immutable except the open-step assistant message,
  // whose growth points invalidate below. Foreign message arrays (e.g. the
  // compaction summarizer's slice) take the uncached pure path.
  private readonly projectionCache = new ProjectionCache();

  constructor(protected readonly agent: Agent) {}

  /** Structural repairs the last resume performed, in replay order. */
  get resumeRepairs(): readonly ResumeRepairEntry[] {
    return this.resumeRepairLog;
  }

  get lastAssistantAt(): number | null {
    return this._lastAssistantAt;
  }

  appendUserMessage(
    content: readonly ContentPart[],
    origin: PromptOrigin = USER_PROMPT_ORIGIN,
  ): void {
    if (content.length === 0) return;
    // Prompt ingestion (server upload/base64 route, TUI paste, ACP) annotates
    // a compressed image with an inline `<system>` caption next to the image.
    // Left inside the user message, that raw markup is user-visible in every
    // history projection (TUI replay, vis, export). Reroute each caption
    // through the built-in system-reminder injection — hidden by its
    // `injection` origin — and keep only the real user content here.
    const { captions, parts } =
      origin.kind === 'user'
        ? splitImageCompressionCaptions(content)
        : { captions: [], parts: [...content] };
    for (const caption of captions) {
      this.appendSystemReminder(caption, { kind: 'injection', variant: 'image_compression' });
    }
    if (parts.length === 0) return;
    this.appendMessage({
      role: 'user',
      content: parts,
      toolCalls: [],
      origin,
    });
  }

  appendSystemReminder(content: string, origin: PromptOrigin): void {
    const text = `<system-reminder>\n${content.trim()}\n</system-reminder>`;
    this.appendMessage({
      role: 'user',
      content: [{ type: 'text', text }],
      toolCalls: [],
      origin,
    });
  }

  /**
   * Inject a user-invisible message and immediately send it to the model by
   * launching/steering a turn. The content is used as-is (no wrapper tag), so
   * callers can pass raw tool-result-style text or wrap it themselves. The
   * message is skipped on replay / transcript (so the user never sees it) but
   * is included in the context sent to the model. Use this for events the
   * model must react to right away without surfacing a user-visible message.
   */
  injectAndNotify(content: string, origin?: PromptOrigin): void {
    this.agent.turn.steer(
      [{ type: 'text', text: content }],
      origin ?? { kind: 'injection', variant: 'system_reminder' },
    );
  }

  appendLocalCommandStdout(content: string): void {
    const text = `<local-command-stdout>\n${content.trim()}\n</local-command-stdout>`;
    this.appendMessage({
      role: 'user',
      content: [{ type: 'text', text }],
      toolCalls: [],
      origin: { kind: 'injection', variant: 'local-command-stdout' },
    });
  }

  // User-initiated `!` shell command. Unlike `injection` (which is skipped on
  // replay), `shell_command` origin is replayed and rendered, so resumed
  // sessions still show the command and its output. The XML tags carry the
  // semantics to the model; the origin drives UI/replay routing.
  appendBashInput(command: string): void {
    const text = `<bash-input>\n${escapeXml(command)}\n</bash-input>`;
    this.appendMessage({
      role: 'user',
      content: [{ type: 'text', text }],
      toolCalls: [],
      origin: { kind: 'shell_command', phase: 'input' },
    });
  }

  appendBashOutput(stdout: string, stderr: string, isError?: boolean): void {
    const text = `<bash-stdout>${escapeXml(stdout)}</bash-stdout><bash-stderr>${escapeXml(stderr)}</bash-stderr>`;
    this.appendMessage({
      role: 'user',
      content: [{ type: 'text', text }],
      toolCalls: [],
      origin:
        isError === true
          ? { kind: 'shell_command', phase: 'output', isError: true }
          : { kind: 'shell_command', phase: 'output' },
    });
  }

  popMatchedMessage(matcher: (origin: PromptOrigin | undefined) => boolean): boolean {
    const lastDeferred = this.deferredMessages.at(-1);
    const last = lastDeferred ?? this._history.at(-1);
    if (last === undefined) return false;
    if (!matcher(last.origin)) return false;
    if (lastDeferred !== undefined) {
      this.deferredMessages.pop();
    } else {
      this._history.pop();
    }
    return true;
  }

  clear(): void {
    this.agent.records.logRecord({ type: 'context.clear' });
    this._history = [];
    this._tokenCount = 0;
    this.tokenCountCoveredMessageCount = 0;
    this.openSteps.clear();
    this.pendingToolResultIds.clear();
    this.deferredMessages = [];
    this._lastAssistantAt = null;
    this.agent.graduatedCompaction.reset();
    this.agent.injection.onContextClear();
    this.agent.tools.onContextCleared();
    this.agent.emitStatusUpdated();
  }

  importContext(content: string, source: string): void {
    if (content.trim().length === 0) {
      throw new CloudCodeError(ErrorCodes.REQUEST_INVALID, 'Imported context cannot be empty', {
        details: { reason: 'import_content_empty' },
      });
    }
    const normalizedSource = source.trim();
    if (normalizedSource.length === 0) {
      throw new CloudCodeError(ErrorCodes.REQUEST_INVALID, 'Imported context source cannot be empty', {
        details: { reason: 'import_source_empty' },
      });
    }

    const message: ContextMessage = {
      role: 'user',
      content: [
        {
          type: 'text',
          text:
            `<system>The user has imported context from ${escapeXml(normalizedSource)}. ` +
            `${IMPORT_CONTEXT_GUIDANCE}</system>`,
        },
        {
          type: 'text',
          text:
            `<imported_context source="${escapeXmlAttr(normalizedSource)}">\n` +
            `${content}\n</imported_context>`,
        },
      ],
      toolCalls: [],
      origin: USER_PROMPT_ORIGIN,
    };
    const currentTokenCount = this.tokenCountWithPending;
    const importTokenCount = estimateTokensForMessages([message]);
    const totalTokenCount = currentTokenCount + importTokenCount;
    const capability = this.agent.config.modelCapabilities;
    const maxContextTokens = capability.max_input_tokens ?? capability.max_context_tokens;
    if (maxContextTokens > 0 && totalTokenCount > maxContextTokens) {
      throw new CloudCodeError(
        ErrorCodes.CONTEXT_OVERFLOW,
        'Imported content is too large for the current model context ' +
          `(~${String(importTokenCount)} import tokens + ${String(currentTokenCount)} existing ` +
          `= ~${String(totalTokenCount)} total > ${String(maxContextTokens)} token limit). ` +
          'Please import a smaller file or session.',
        {
          details: {
            reason: 'import_context_overflow',
            importTokenCount,
            currentTokenCount,
            totalTokenCount,
            maxContextTokens,
          },
        },
      );
    }

    this.appendMessage(message);
    this.updateTokenCount(totalTokenCount);
  }

  updateTokenCount(tokenCount: number): void {
    this.agent.records.logRecord({ type: 'context.update_token_count', tokenCount });
    this._tokenCount = tokenCount;
    this.tokenCountCoveredMessageCount = this._history.length;
    this.agent.emitStatusUpdated();
  }

  undo(count: number): void {
    if (count <= 0) return;
    if (this._history.length === 0) return;

    this.agent.records.logRecord({ type: 'context.undo', count });

    let removedUserCount = 0;
    const removedMessages = new Set<ContextMessage>();
    let stoppedAtBoundary = false;
    for (let i = this._history.length - 1; i >= 0; i--) {
      const message = this._history[i];
      if (message === undefined) continue;
      if (message.origin?.kind === 'injection') continue;
      if (message.origin?.kind === 'compaction_summary') {
        stoppedAtBoundary = true;
        break;
      }

      removedMessages.add(message);
      this._history.splice(i, 1);
      this.agent.injection.onContextMessageRemoved(i);

      if (i < this.tokenCountCoveredMessageCount) {
        this.tokenCountCoveredMessageCount--;
        this._tokenCount -= estimateTokensForMessages([message]);
      }

      if (isRealUserInput(message)) {
        removedUserCount++;
        if (removedUserCount >= count) break;
      }
    }

    this.agent.replayBuilder.removeLastMessages(removedMessages);

    this.openSteps.clear();
    this.pendingToolResultIds.clear();
    this.deferredMessages = [];
    this.agent.graduatedCompaction.reset(this._history.length);
    this.agent.emitStatusUpdated();

    if (
      !this.agent.records.restoring &&
      (stoppedAtBoundary || removedUserCount < count)
    ) {
      throw new CloudCodeError(
        ErrorCodes.REQUEST_INVALID,
        formatUndoUnavailableMessage(count, removedUserCount, stoppedAtBoundary),
        {
          details: {
            reason: 'undo_limit',
            requestedCount: count,
            undoableCount: removedUserCount,
            stoppedAtCompaction: stoppedAtBoundary,
          },
        },
      );
    }
  }

  /**
   * Withdraw an unanswered tail user input — the interrupt-recall removal
   * (Esc cancels a turn before it produced any output, so the input that
   * started it is pulled back out of the context instead of lingering
   * unanswered next to its edited replacement).
   *
   * Deliberately narrower than `undo(1)`: the message is removed only when it
   * is the LAST non-injection message in the history — i.e. the turn recorded
   * no assistant/tool output after it. When anything else sits at the tail
   * (output did land, or the turn's own prompt never made it in because the
   * abort raced the pre-append media resolution) the call is a no-op and no
   * record is logged, so the wire only ever carries withdrawals that actually
   * happened and replay re-derives the exact same removal.
   */
  withdrawUnansweredTailInput(): boolean {
    for (let i = this._history.length - 1; i >= 0; i--) {
      const message = this._history[i];
      if (message === undefined) continue;
      if (message.origin?.kind === 'injection') continue;
      if (!isRealUserInput(message)) return false;

      this.agent.records.logRecord({ type: 'context.withdraw_tail_input' });

      this._history.splice(i, 1);
      this.agent.injection.onContextMessageRemoved(i);
      if (i < this.tokenCountCoveredMessageCount) {
        this.tokenCountCoveredMessageCount--;
        this._tokenCount -= estimateTokensForMessages([message]);
      }
      this.agent.replayBuilder.removeLastMessages(new Set([message]));
      this.agent.graduatedCompaction.reset(this._history.length);
      this.agent.emitStatusUpdated();
      return true;
    }
    return false;
  }

  applyCompaction(input: CompactionInput): CompactionResult {
    // Single derivation point for the post-compaction shape: the kept user
    // messages (verbatim, within the token budget — the oldest head plus the
    // most recent tail, with an elision marker between them when the pool
    // overflowed), followed by a user-role summary. `tokensAfter` and the
    // kept-count fields are derived here from the actual `_history` so the
    // live context, the wire record, and the transcript reducer all agree —
    // re-deriving them elsewhere (e.g. from the full transcript, which still
    // holds the untruncated originals of messages the live context truncated)
    // would diverge.
    //
    // KeepPolicy pinned digests: when the history already holds a compaction
    // summary, everything up to and including the most recent one is carried
    // over byte-for-byte (earlier summaries accumulate; they are never
    // re-summarized), and the user-message selection runs over the NEW range
    // past it only. The prefix a repeated compaction produces is therefore
    // stable across compactions instead of being re-truncated each time.
    //
    // Records written before the head/tail split carry `keptUserMessageCount`
    // but no `keptHeadUserMessageCount`; they were produced by the tail-only
    // selection, so restore must reproduce that exact selection or the rebuilt
    // history would diverge from the persisted counts the transcript reducer
    // relies on. (A new-code record without elision restores identically under
    // either selection, so gating on the head field alone is sufficient.
    // Records WITH digest pinning always carry `pinnedPrefixCount` and take
    // the new path even without elision: their pool is the post-summary range,
    // not the whole history.) Legacy records predate pinning too — their
    // rebuild dropped earlier summaries — so their pinned prefix is 0.
    const restoreTailOnly =
      this.agent.records.restoring !== null &&
      input.keptHeadUserMessageCount === undefined &&
      input.pinnedPrefixCount === undefined;
    const pinnedPrefixLength = restoreTailOnly
      ? 0
      : (input.pinnedPrefixCount ?? pinnedDigestPrefixLength(this._history));
    const selectionPool = this._history.slice(pinnedPrefixLength);
    const compactableUserMessages = collectCompactableUserMessages(selectionPool);
    const selection = restoreTailOnly
      ? {
          head: [],
          tail: selectRecentUserMessages(compactableUserMessages, COMPACT_USER_MESSAGE_MAX_TOKENS),
          elided: false,
          omittedTokens: 0,
        }
      : selectCompactionUserMessages(compactableUserMessages);
    const elisionMessage: ContextMessage | null = selection.elided
      ? {
          role: 'user',
          content: [{ type: 'text', text: buildCompactionElisionText(selection.omittedTokens) }],
          toolCalls: [],
          origin: { kind: 'injection', variant: COMPACTION_ELISION_VARIANT },
        }
      : null;
    const pinnedPrefix = this._history.slice(0, pinnedPrefixLength);
    const keptMessages: ContextMessage[] =
      elisionMessage === null
        ? [...pinnedPrefix, ...selection.head, ...selection.tail]
        : [...pinnedPrefix, ...selection.head, elisionMessage, ...selection.tail];
    // Live compaction omits these so they are derived from the actual
    // `_history`; restore passes the persisted record so its historical values
    // are preserved verbatim. Older wire records did not have `contextSummary`,
    // so their `summary` remains the model-context text during restore.
    const contextSummary = input.contextSummary ?? input.summary;
    const tokensAfter =
      input.tokensAfter ??
      estimateTokens(contextSummary) + estimateTokensForMessages(keptMessages);
    const keptUserMessageCount =
      input.keptUserMessageCount ?? selection.head.length + selection.tail.length;
    const keptHeadUserMessageCount =
      input.keptHeadUserMessageCount ?? (selection.elided ? selection.head.length : undefined);
    const result: CompactionResult = {
      summary: input.summary,
      contextSummary,
      compactedCount: input.compactedCount,
      tokensBefore: input.tokensBefore,
      tokensAfter,
      keptUserMessageCount,
      keptHeadUserMessageCount,
      // Live records always carry the pinned count (0 included) so restore can
      // tell pinning-era records from pre-pinning ones; legacy restores keep
      // their original shape with the field absent.
      pinnedPrefixCount:
        input.pinnedPrefixCount ?? (restoreTailOnly ? undefined : pinnedPrefixLength),
      droppedCount: input.droppedCount,
    };
    this.agent.records.logRecord({
      type: 'context.apply_compaction',
      ...result,
    });
    this.agent.replayBuilder.patchLast('compaction', {
      result: {
        summary: result.summary,
        contextSummary: result.contextSummary,
        compactedCount: result.compactedCount,
        tokensBefore: result.tokensBefore,
        tokensAfter: result.tokensAfter,
        keptUserMessageCount: result.keptUserMessageCount,
        keptHeadUserMessageCount: result.keptHeadUserMessageCount,
        pinnedPrefixCount: result.pinnedPrefixCount,
        droppedCount: result.droppedCount,
      },
    });
    const summaryMessage: ContextMessage = {
      role: 'user',
      content: [{ type: 'text', text: contextSummary }],
      toolCalls: [],
      origin: { kind: 'compaction_summary' },
    };
    // Wire backward-compat: a pre-rework `context.apply_compaction` record (which
    // has no `keptUserMessageCount`) used `[summary, ...history.slice(compactedCount)]`
    // semantics and kept a verbatim recent tail. Reproduce that shape on restore
    // so resuming a session compacted by an older version does not silently drop
    // the recent assistant/tool tail beyond `compactedCount`. Gated on
    // `records.restoring`, so the live/forward path — which always sets
    // `contextSummary` and `keptUserMessageCount` — is unaffected.
    //
    // The cut can land inside a tool exchange, leaving the tail starting with an
    // orphan `tool` result whose assistant is now in the summarized prefix. The
    // history is kept faithful to the wire records (so the transcript reducer's
    // fold length stays in sync); the projector drops the orphan at the wire
    // boundary — see `dropOrphanToolResults` — so a strict provider still gets a
    // valid request without mutating the stored history here.
    const isLegacyRestore =
      this.agent.records.restoring !== null &&
      input.keptUserMessageCount === undefined &&
      input.compactedCount < this._history.length;
    this._history = isLegacyRestore
      ? [summaryMessage, ...this._history.slice(input.compactedCount)]
      : [...keptMessages, summaryMessage];
    this.openSteps.clear();
    this.pendingToolResultIds.clear();
    // Drop deferred messages (mostly injections/system reminders) instead of
    // flushing them: initial context is rebuilt every turn.
    this.deferredMessages = [];
    this._tokenCount = result.tokensAfter;
    this.tokenCountCoveredMessageCount = this._history.length;
    this.agent.graduatedCompaction.reset();
    this.agent.injection.onContextCompacted();
    this.agent.tools.onContextCompacted();
    this.agent.emitStatusUpdated();
    return result;
  }

  data(): AgentContextData {
    return {
      history: this.history,
      tokenCount: this.tokenCount,
    };
  }

  get tokenCount(): number {
    return this._tokenCount;
  }

  get tokenCountWithPending(): number {
    const pendingMessages = this._history.slice(this.tokenCountCoveredMessageCount);
    return this._tokenCount + estimateTokensForMessages(pendingMessages);
  }

  get history(): readonly ContextMessage[] {
    return this._history;
  }

  project(messages: readonly ContextMessage[], options?: ProjectOptions): Message[] {
    // Shape for the current model BEFORE projecting: a model without the
    // dynamically-loaded-tools capability must not see dynamic-tool schema
    // messages or loadable-tools announcements (the canonical history keeps
    // them; only this outgoing view is shaped). Must run pre-projection —
    // project() strips `origin`, the only anchor for the announcements.
    // setModel never rewrites history, so a mid-session switch
    // degrades/upgrades losslessly.
    const shaped = this.agent.toolSelectEnabled
      ? this.agent.tools.shapeDynamicToolHistory(messages)
      : stripDynamicToolContext(messages);
    const drained = this.applyPtlDrain(messages, shaped);
    const anomalies: ProjectionAnomaly[] = [];
    const result = project(
      this.agent.graduatedCompaction.applyToProjection(drained),
      {
        ...options,
        onAnomaly: (anomaly) => {
          anomalies.push(anomaly);
          options?.onAnomaly?.(anomaly);
        },
      },
      messages === this._history ? this.projectionCache : undefined,
    );
    this.reportProjectionRepairs(anomalies);
    return result;
  }

  // PTL drain (reactive overflow layer): slice away the armed head of the
  // canonical-history projection — after dynamic-tool shaping, before the
  // graduated tool-result rewrites, so `applyToProjection`'s never-drops
  // promise stays intact (the drop happens upstream of it). The cutoff
  // indexes the canonical history and shaping may drop protocol messages
  // (dynamic-tool schemas, loadable announcements) ahead of it, so the first
  // surviving message is located by reference rather than by raw index. Cuts
  // land on API-round boundaries; the projector's usual wire repairs
  // (dropOrphanResults / dropLeadingNonUser) cover anything downstream.
  private applyPtlDrain(
    messages: readonly ContextMessage[],
    shaped: readonly ContextMessage[],
  ): readonly ContextMessage[] {
    const cutoff = this.agent.graduatedCompaction.armedDrainCutoff;
    if (cutoff === 0 || messages !== this._history) return shaped;
    for (let i = Math.min(cutoff, messages.length); i < messages.length; i++) {
      const index = shaped.indexOf(messages[i]!);
      if (index !== -1) return shaped.slice(index);
    }
    // Everything at/past the cutoff was protocol context stripped by shaping;
    // fail open (no drain) and let the overflow chain escalate.
    return shaped;
  }

  // Surface the projector's wire-repairs so a silently-mangled history leaves a
  // trace instead of being papered over. Deduped by signature: a repair that
  // recurs identically every send (e.g. a persistently lost result re-synthesized
  // each turn) logs once, not per step. Trailing-tail synthesis is excluded — it
  // is the expected close of an in-flight call under `synthesizeMissing`
  // (compaction / strict resend), not a defect.
  private reportProjectionRepairs(anomalies: readonly ProjectionAnomaly[]): void {
    const notable = anomalies.filter(
      (anomaly) => !(anomaly.kind === 'tool_result_synthesized' && anomaly.trailing),
    );
    if (notable.length === 0) {
      this.lastProjectionRepairSignature = null;
      return;
    }
    const signature = notable
      .map((anomaly) => ('toolCallId' in anomaly ? `${anomaly.kind}:${anomaly.toolCallId}` : anomaly.kind))
      .toSorted()
      .join('|');
    if (signature === this.lastProjectionRepairSignature) return;
    this.lastProjectionRepairSignature = signature;

    let reordered = 0;
    let synthesized = 0;
    let droppedOrphan = 0;
    let duplicateCallsDropped = 0;
    let duplicateResultsDropped = 0;
    let leadingDropped = 0;
    let assistantsMerged = 0;
    let whitespaceDropped = 0;
    let vacuousDropped = 0;
    for (const anomaly of notable) {
      if (anomaly.kind === 'tool_result_reordered') reordered += 1;
      else if (anomaly.kind === 'tool_result_synthesized') synthesized += 1;
      else if (anomaly.kind === 'orphan_tool_result_dropped') droppedOrphan += 1;
      else if (anomaly.kind === 'duplicate_tool_call_dropped') duplicateCallsDropped += 1;
      else if (anomaly.kind === 'duplicate_tool_result_dropped') duplicateResultsDropped += 1;
      else if (anomaly.kind === 'leading_non_user_dropped') leadingDropped += 1;
      else if (anomaly.kind === 'consecutive_assistants_merged') assistantsMerged += 1;
      else if (anomaly.kind === 'vacuous_message_dropped') vacuousDropped += 1;
      else whitespaceDropped += 1;
    }
    const toolCallIds = [
      ...new Set(
        notable.flatMap((anomaly) => ('toolCallId' in anomaly ? [anomaly.toolCallId] : [])),
      ),
    ].slice(0, 5);
    this.agent.log.warn('repaired the request to keep it wire-valid', {
      reordered,
      synthesized,
      droppedOrphan,
      duplicateCallsDropped,
      duplicateResultsDropped,
      leadingDropped,
      assistantsMerged,
      whitespaceDropped,
      vacuousDropped,
      toolCallIds,
    });
  }

  get messages(): Message[] {
    // The normal wire projection. `dropOrphanResults` is on for every
    // request-building projection (here, `strictMessages`, and the compaction
    // summarizer): a stray result with no matching call anywhere is wire-invalid
    // on strict providers and useless to the model, so it never reaches the
    // provider — while fragment projections (e.g. token estimation of a history
    // slice) leave it alone.
    return this.project(this.history, { dropOrphanResults: true });
  }

  // Last-resort projection for the post-400 strict resend: close every open tool
  // call (including a trailing in-flight one), drop stray tool results, dedupe
  // duplicate tool call ids (with their extra results), drop a leading non-user
  // message, and merge consecutive assistant turns, so the request is
  // wire-compliant for strict providers no matter how the history was mangled.
  // Only used when the provider has already rejected the normal projection —
  // see the adjacency fallback in `turn-step`.
  get strictMessages(): Message[] {
    return this.project(this.history, {
      synthesizeMissing: true,
      dropOrphanResults: true,
      dedupeDuplicateToolCalls: true,
      dropLeadingNonUser: true,
      mergeConsecutiveAssistants: true,
    });
  }

  // Fallback projection for the post-413 media-degraded resend: the normal
  // wire projection with all but the most recent media parts replaced by text
  // markers, so a request body bloated by accumulated base64 media fits the
  // provider's size limit. Purely read-side — the history keeps its media —
  // and only used when the provider has already rejected the normal
  // projection as too large; see the request-too-large fallback in
  // `turn-step`.
  get mediaDegradedMessages(): Message[] {
    return degradeOlderMediaParts(this.messages, MEDIA_DEGRADE_KEEP_RECENT);
  }

  /**
   * Compatibility projection that strips every media part visible now. Turn
   * recovery uses its own captured snapshot so newly produced media can pass;
   * direct callers retain the historical all-current-media behavior here.
   */
  get mediaStrippedMessages(): Message[] {
    const messages = this.messages;
    return stripMediaPartsBySnapshot(messages, captureMediaStripSnapshot(messages));
  }

  useProjectedHistoryFrom(source: ContextMemory): void {
    this.clear();
    this.pushHistory(...trimTrailingOpenToolExchange(source.project(source.history)));
  }

  finishResume(): ContextFinishResumeResult {
    this.openSteps.clear();
    const closed = this.closePendingToolResults();
    if (closed.length > 0) {
      this.resumeRepairLog.push({ kind: 'tool_calls_closed_at_resume_end', toolCallIds: closed });
      // Routine end-of-resume close of a genuinely interrupted trailing call
      // (e.g. the process died mid-tool), logged for traceability.
      this.agent.log.info('closed interrupted tool calls at end of resume', {
        closed: closed.length,
        toolCallIds: closed.slice(0, 5),
      });
    }
    return { closedToolCallIds: closed };
  }

  /**
   * Whether the restored history ends on genuine user input the assistant
   * never answered (the process died before or during the turn's first step).
   *
   * Two origin classes are transparent to the scan — it continues down to the
   * real verdict message instead of letting bookkeeping settle it:
   * - `injection` messages (except an earlier resume-continuation reminder,
   *   which settles the scan: already announced, injecting again would stack
   *   duplicates);
   * - non-answer bookkeeping that resume itself appends before this scan runs
   *   (`background_task` notifications restored by `background.reconcile()`,
   *   plus `cron_job`/`cron_missed`/`system_trigger` by class: scheduler and
   *   goal re-drives are owned by their own subsystems, not by this reminder).
   * A trailing compaction summary means the turn completed (compaction only
   *   runs at a turn boundary), so it settles the scan as "not interrupted".
   * `hook_result` stays a verdict: a UserPromptSubmit-blocked prompt is a
   * deliberate stop, not an interruption.
   *
   * Accepted misfire class (same tradeoff as Claude's heuristic): a turn that
   * FAILED cleanly before its first step produced any record — e.g. a
   * provider/auth error raised before `step.begin` — leaves the same bare
   * unanswered-prompt tail as a crash, and the append-only wire has no
   * turn-end marker to tell them apart. Both get the reminder; it is a
   * one-shot standard-tier nudge, so the cost of the false positive is one
   * reminder line. Pinned by the "first-step failure" test in resume.test.ts.
   */
  hasUnansweredTailPrompt(): boolean {
    for (let i = this._history.length - 1; i >= 0; i--) {
      const message = this._history[i]!;
      const origin = message.origin;
      const kind = origin?.kind;
      if (kind === 'injection') {
        if (origin.variant === RESUME_CONTINUATION_VARIANT) return false;
        continue;
      }
      if (
        kind === 'background_task' ||
        kind === 'cron_job' ||
        kind === 'cron_missed' ||
        kind === 'mailbox' ||
        kind === 'system_trigger'
      ) {
        continue;
      }
      if (kind === 'compaction_summary') return false;
      return isRealUserInput(message);
    }
    return false;
  }

  /**
   * Post-resume consistency audit (04i `checkResumeConsistency` analog).
   * Runs after the replay repairs (step-boundary closes, `finishResume`) so
   * anything it finds is drift the repair layer could NOT fix — e.g. an
   * assistant message written by `context.append_message` whose tool calls
   * never produced results, or messages stranded in the deferral queue by a
   * poisoned log. Read-only: findings are reported by the caller
   * (`Agent.resume`) as a warning, never repaired in place.
   */
  auditAfterResume(): readonly ResumeAuditFinding[] {
    const findings: ResumeAuditFinding[] = [];
    const openCalls = new Set<string>();
    for (const message of this._history) {
      if (message.role === 'assistant') {
        for (const call of message.toolCalls) openCalls.add(call.id);
        continue;
      }
      if (message.role !== 'tool') continue;
      const toolCallId = message.toolCallId;
      if (toolCallId === undefined) continue;
      if (!openCalls.delete(toolCallId)) {
        findings.push({ kind: 'tool_result_without_call', toolCallId });
      }
    }
    for (const toolCallId of openCalls) {
      findings.push({ kind: 'tool_call_without_result', toolCallId });
    }
    if (this.deferredMessages.length > 0) {
      findings.push({ kind: 'stranded_deferred_messages', count: this.deferredMessages.length });
    }
    return findings;
  }

  // Synthesize interrupted tool results for any still-open tool calls, closing
  // the exchange in place. Called at every replayed step boundary (see the
  // `step.begin` case) so a tool call left unresolved mid-history is closed
  // exactly where it occurred — otherwise it would keep `hasOpenToolExchange`
  // true and strand every later message in `deferredMessages`, so only the
  // trailing exchange ends up aligned. `finishResume` runs the same routine once
  // more to close a genuine trailing interruption at end of resume, and
  // `closeAbandonedToolExchange` reuses it (with a live-turn message) as the
  // turn-end teardown. Returns the ids it closed; callers own the logging.
  private closePendingToolResults(output: string = TOOL_INTERRUPTED_ON_RESUME_OUTPUT): string[] {
    if (this.pendingToolResultIds.size === 0) return [];
    const interruptedToolCallIds = [...this.pendingToolResultIds];
    for (const toolCallId of interruptedToolCallIds) {
      this.appendLoopEvent({
        type: 'tool.result',
        parentUuid: toolCallId,
        toolCallId,
        result: {
          output,
          isError: true,
        },
      });
    }
    return interruptedToolCallIds;
  }

  /**
   * Defensive teardown for a live turn that ended — normally, cancelled, or
   * failed — while recorded tool calls were still awaiting results (e.g. the
   * batch's result dispatch died after a `tool.call` was already recorded).
   * Synthesizes an error result for each dangling call so the exchange closes:
   * left open, it would keep `hasOpenToolExchange` true and strand every later
   * message in `deferredMessages`, silently swallowing user input. No-op when
   * the exchange is already closed. Returns the number of calls it closed.
   */
  closeAbandonedToolExchange(output: string): number {
    return this.closePendingToolResults(output).length;
  }

  /**
   * Restore-side recovery for a `tool.result` with no open call (04i
   * `recoverOrphanedParallelToolResults` analog, adapted to the event log).
   * Two shapes arrive here:
   *
   * - Late real result: the call was closed in place at an earlier step
   *   boundary (a parallel batch whose result was recorded after the next
   *   step began — crash/race during streaming execution). The in-place close
   *   left a synthetic interrupted placeholder claiming the result was never
   *   observed, but the real output is sitting right here in the log. Re-hang
   *   it: replace the placeholder in position with the recorded output.
   * - True orphan / stale duplicate: no placeholder to re-hang over (the call
   *   was never recorded anywhere), or the arriving result IS the placeholder
   *   text an older resume persisted — a content-identical duplicate. Drop it
   *   and ledger the loss: tool output silently vanishing must leave a trace.
   *
   * In-memory only (replay logging is suppressed): every resume re-derives
   * the re-attachment from the same records, so it cannot diverge the wire.
   */
  private recoverLateToolResult(event: LoopToolResultEvent): void {
    const placeholderIndex = this._history.findIndex(
      (message) =>
        message.role === 'tool' &&
        message.toolCallId === event.toolCallId &&
        message.isError === true &&
        message.content.length === 1 &&
        message.content[0]?.type === 'text' &&
        message.content[0].text === TOOL_INTERRUPTED_ON_RESUME_OUTPUT,
    );
    if (
      placeholderIndex === -1 ||
      event.result.output === TOOL_INTERRUPTED_ON_RESUME_OUTPUT
    ) {
      this.resumeRepairLog.push({
        kind: 'orphan_tool_result_dropped',
        toolCallId: event.toolCallId,
      });
      return;
    }
    const placeholder = this._history[placeholderIndex]!;
    const settled: ContextMessage = {
      ...createToolMessage(event.toolCallId, event.result.output),
      role: 'tool',
      isError: event.result.isError,
      note: event.result.note,
    };
    this._history[placeholderIndex] = settled;
    // Keep the replay consistent with history — otherwise the resumed
    // transcript view shows the interrupted placeholder while the model
    // context carries the recovered output.
    this.agent.replayBuilder.replaceMessage(placeholder, settled);
    this.resumeRepairLog.push({
      kind: 'late_tool_result_reattached',
      toolCallId: event.toolCallId,
    });
  }

  appendLoopEvent(event: LoopRecordedEvent): void {
    this.agent.records.logRecord({
      type: 'context.append_loop_event',
      event,
    });
    switch (event.type) {
      case 'step.begin': {
        // A new assistant step means any tool calls still pending from an
        // earlier step were interrupted (the invariant guarantees this never
        // happens live, so this is a no-op outside replay). Close them in place
        // before opening the new step so mid-history gaps stay aligned.
        const closed = this.closePendingToolResults();
        if (closed.length > 0) {
          if (this.agent.records.restoring !== null) {
            this.resumeRepairLog.push({
              kind: 'tool_calls_closed_at_step_boundary',
              toolCallIds: closed,
            });
          }
          // A mid-history gap means results were lost before this boundary —
          // a genuine defect worth investigating, unlike the expected trailing
          // interruption `finishResume` closes.
          this.agent.log.warn('closed unresolved tool calls at a step boundary', {
            closed: closed.length,
            toolCallIds: closed.slice(0, 5),
          });
        }
        const message: ContextMessage = {
          role: 'assistant',
          content: [],
          toolCalls: [],
        };
        this.pushHistory(message);
        this.openSteps.set(event.uuid, message);
        return;
      }
      case 'step.end': {
        const openStep = this.openSteps.get(event.uuid);
        this.openSteps.delete(event.uuid);
        if (event.usage !== undefined) {
          const openStepIndex = openStep === undefined ? -1 : this._history.indexOf(openStep);
          const coveredCount =
            openStepIndex === -1 ? this._history.length : openStepIndex + 1;
          const totalUsage =
            event.usage.inputCacheRead +
            event.usage.inputCacheCreation +
            event.usage.inputOther +
            event.usage.output;
          if (totalUsage > 0) {
            this._tokenCount = totalUsage;
            // The provider's count is net of the graduated rewrites the
            // request carried; those savings must not be subtracted twice
            // when the compaction gate computes the effective count.
            this.agent.graduatedCompaction.onProviderUsageRealized();
          } else {
            // The provider reported zero usage (e.g. content filter). Do not
            // overwrite the accumulated context token count with 0; add an
            // estimate for the newly covered messages so the invariant between
            // _tokenCount and tokenCountCoveredMessageCount stays intact.
            const previousCoveredCount = this.tokenCountCoveredMessageCount;
            this._tokenCount += estimateTokensForMessages(
              this._history.slice(previousCoveredCount, coveredCount),
            );
          }
          this.tokenCountCoveredMessageCount = coveredCount;
        }
        this.flushDeferredMessagesIfToolExchangeClosed();
        return;
      }
      case 'content.part': {
        const openStep = this.openSteps.get(event.stepUuid);
        if (openStep === undefined) {
          if (this.agent.records.restoring !== null) {
            // A poisoned wire log (e.g. an undo raced a live step's events)
            // must not make the session unresumable: skip the orphan part
            // instead of failing the whole replay. The live path keeps
            // throwing — an unknown step there is a real invariant break.
            this.resumeRepairLog.push({
              kind: 'orphan_step_event_skipped',
              eventType: 'content.part',
              stepUuid: event.stepUuid,
            });
            this.agent.log.warn(
              'skipping content_part for unknown step_uuid during restore',
              { stepUuid: event.stepUuid },
            );
            return;
          }
          throw new Error(
            `Received content_part for unknown step_uuid '${event.stepUuid}' (no open step_begin)`,
          );
        }
        // The open-step assistant message is the one in-place-mutated history
        // object; drop its projection-cache derivatives before growing it.
        this.projectionCache.invalidate(openStep);
        openStep.content.push(event.part);
        return;
      }
      case 'tool.call': {
        const openStep = this.openSteps.get(event.stepUuid);
        if (openStep === undefined) {
          if (this.agent.records.restoring !== null) {
            // Same restore tolerance as content.part above.
            this.resumeRepairLog.push({
              kind: 'orphan_step_event_skipped',
              eventType: 'tool.call',
              stepUuid: event.stepUuid,
            });
            this.agent.log.warn('skipping tool_call for unknown step_uuid during restore', {
              stepUuid: event.stepUuid,
              toolCallId: event.toolCallId,
            });
            return;
          }
          throw new Error(
            `Received tool_call for unknown step_uuid '${event.stepUuid}' (no open step_begin)`,
          );
        }
        // Same in-place-mutation invalidation as content.part above.
        this.projectionCache.invalidate(openStep);
        openStep.toolCalls.push({
          type: 'function',
          id: event.toolCallId,
          name: event.name,
          arguments: event.args === undefined ? null : JSON.stringify(event.args),
          extras: event.extras,
        });
        if (event.display !== undefined) {
          openStep.toolCallDisplays ??= {};
          openStep.toolCallDisplays[event.toolCallId] = event.display;
        }
        this.pendingToolResultIds.add(event.toolCallId);
        return;
      }
      case 'tool.result': {
        // A result for an id that is not awaiting one: its exchange is already
        // settled or its call is gone. During restore, run the orphan recovery
        // before dropping (04i `recoverOrphanedParallelToolResults` analog —
        // see `recoverLateToolResult`); the live path keeps the plain drop (a
        // stale duplicate from an older tail-only finishResume).
        if (!this.pendingToolResultIds.has(event.toolCallId)) {
          if (this.agent.records.restoring !== null) {
            this.recoverLateToolResult(event);
          }
          return;
        }
        // History stores the fact verbatim: the tool's own output plus the
        // structured isError/note/display/structured fields. Model-facing
        // status text (error prefix, empty placeholder) and the note are
        // rendered only at LLM projection time (see tool-result-render.ts);
        // display and structured are UI-only and never projected.
        const message = createToolMessage(event.toolCallId, event.result.output);
        this.pushHistory({
          ...message,
          role: 'tool',
          isError: event.result.isError,
          note: event.result.note,
          display: event.result.display,
          structured: event.result.structured,
        });
        this.pendingToolResultIds.delete(event.toolCallId);
        this.flushDeferredMessagesIfToolExchangeClosed();
        return;
      }
    }
  }

  appendMessage(message: ContextMessage): void {
    this.agent.records.logRecord({
      type: 'context.append_message',
      message,
    });
    if (this.hasOpenToolExchange()) {
      this.deferredMessages.push(message);
      return;
    }
    this.pushHistory(message);
  }

  private flushDeferredMessagesIfToolExchangeClosed(): void {
    if (this.pendingToolResultIds.size > 0 || this.deferredMessages.length === 0) {
      return;
    }
    this.pushHistory(...this.deferredMessages);
    this.deferredMessages = [];
  }

  private hasOpenToolExchange(): boolean {
    return this.pendingToolResultIds.size > 0;
  }

  private pushHistory(...messages: ContextMessage[]): void {
    this._history.push(...messages);
    for (const message of messages) {
      if (message.role === 'assistant') {
        this._lastAssistantAt = this.agent.records.restoring?.time ?? Date.now();
      }
      if (message.origin?.kind === 'background_task') {
        this.agent.background.markDeliveredNotification(message.origin);
      }
      this.agent.replayBuilder.push({
        type: 'message',
        message,
      });
    }
  }
}

// Split inline image-compression captions (see buildImageCompressionCaption)
// out of user prompt content. A caption may be a standalone text part (server
// route, ACP) or merged into an adjacent text segment (TUI paste), so each
// text part is scanned rather than matched whole. Text left empty once its
// captions are removed is dropped entirely.
function splitImageCompressionCaptions(content: readonly ContentPart[]): {
  captions: readonly string[];
  parts: ContentPart[];
} {
  const captions: string[] = [];
  const parts: ContentPart[] = [];
  for (const part of content) {
    if (part.type !== 'text') {
      parts.push(part);
      continue;
    }
    const extracted = extractImageCompressionCaptions(part.text);
    if (extracted.captions.length === 0) {
      parts.push(part);
      continue;
    }
    captions.push(...extracted.captions);
    if (extracted.text.trim().length > 0) {
      parts.push({ type: 'text', text: extracted.text });
    }
  }
  return { captions, parts };
}

function formatUndoUnavailableMessage(
  requestedCount: number,
  undoableCount: number,
  stoppedAtCompaction: boolean,
): string {
  const reason = stoppedAtCompaction ? ' after the last compaction' : '';
  return `Cannot undo ${formatPromptCount(requestedCount)}; only ${formatPromptCount(undoableCount)} can be undone in the active context${reason}.`;

  function formatPromptCount(count: number): string {
    return `${String(count)} ${count === 1 ? 'prompt' : 'prompts'}`;
  }
}
