import type { ContentPart } from '@cloud-code/kosong';

import type { Agent } from '..';
import type { ContextMessage } from '../context';
import { estimateTokensForContentParts, estimateTokensForMessage, estimateTokensForMessages } from '../../utils/tokens';
import {
  exceedsToolResultBudget,
  extractToolResultText,
  persistedToolResultPath,
  renderPersistedToolResult,
  resolveToolResultBudgetThresholds,
  writePersistedToolResult,
} from '../turn/tool-result-budget';

/**
 * Layer-1 config: the tool-result budget. Old tool results that exceed a
 * per-result size budget are persisted to `<sessionDir>/tool-results/` (the
 * F10 mechanism) and replaced in the outgoing projection by a preview plus
 * the file path. The stored history keeps the full facts; only the projection
 * sent to the model is rewritten.
 */
export interface GraduatedToolResultBudgetConfig {
  readonly enabled: boolean;
  /**
   * Fraction of the effective context window that arms/extends this layer.
   * Deliberately below the pinpoint-clear and full-compaction triggers so the
   * cheapest, lossless-on-disk rewrite runs first.
   */
  readonly triggerRatio: number;
  /**
   * Per-result eligibility budget. Deliberately below the execution-time F10
   * limits (50KB / 2000 lines): results between the two budgets stay verbatim
   * when fresh but are the first thing traded for headroom under pressure.
   */
  readonly maxBytes: number;
  readonly maxLines: number;
  /** Tool results inside the most recent N history messages are never rewritten. */
  readonly keepRecentMessages: number;
  readonly previewHeadChars: number;
  readonly previewTailChars: number;
}

/**
 * Layer-2 config: pinpoint clear (microcompact-style). Older tool results —
 * addressed by tool_call id, never dropping the message itself — are replaced
 * by a placeholder marker, so the assistant `tool_use` / `tool_result` pairing
 * stays intact and no orphan results appear. User messages and the recent
 * tail are untouched.
 */
export interface GraduatedPinpointClearConfig {
  readonly enabled: boolean;
  /** Fraction of the effective context window that arms/extends this layer. */
  readonly triggerRatio: number;
  /** Tool results inside the most recent N history messages are never cleared. */
  readonly keepRecentMessages: number;
  /** Results smaller than this are left alone: clearing them saves nothing. */
  readonly minContentTokens: number;
  readonly clearedMarker: string;
}

/**
 * Layer-3 config: PTL drain (reactive-only). Armed exclusively by the turn's
 * overflow drain chain after the provider rejects a request as prompt-too-long
 * — never by a token ratio. Drops leading whole API rounds from the outgoing
 * projection (the stored history keeps the full facts) sized to the token gap
 * the provider reported, or a fraction of the current request estimate when
 * the error wording carried no numbers.
 */
export interface GraduatedPtlDrainConfig {
  readonly enabled: boolean;
  /** Messages inside the most recent N history messages are never drained. */
  readonly keepRecentMessages: number;
}

export interface GraduatedCompactionConfig {
  readonly toolResultBudget: GraduatedToolResultBudgetConfig;
  readonly pinpointClear: GraduatedPinpointClearConfig;
  readonly ptlDrain: GraduatedPtlDrainConfig;
}

/** Deep-partial input accepted from AgentOptions; merged over the defaults. */
export interface GraduatedCompactionConfigInput {
  readonly toolResultBudget?: Partial<GraduatedToolResultBudgetConfig>;
  readonly pinpointClear?: Partial<GraduatedPinpointClearConfig>;
  readonly ptlDrain?: Partial<GraduatedPtlDrainConfig>;
}

export const DEFAULT_GRADUATED_COMPACTION_CONFIG: GraduatedCompactionConfig = {
  toolResultBudget: {
    enabled: true,
    triggerRatio: 0.7,
    maxBytes: 16 * 1024,
    maxLines: 400,
    keepRecentMessages: 20,
    previewHeadChars: 1_000,
    previewTailChars: 1_000,
  },
  pinpointClear: {
    enabled: true,
    triggerRatio: 0.78,
    keepRecentMessages: 20,
    minContentTokens: 100,
    clearedMarker: '[Old tool result content cleared]',
  },
  ptlDrain: {
    enabled: true,
    keepRecentMessages: 20,
  },
};

export interface GraduatedLayerStats {
  /** Times the layer (re)armed on a growing history this session. */
  applications: number;
  /** Tool results the layer currently rewrites in the projection. */
  replacedResults: number;
  /** Estimated tokens the layer saved at its latest application. */
  savedTokens: number;
}

export interface GraduatedPtlDrainStats {
  /** Times the drain layer armed this session. */
  applications: number;
  /** API rounds dropped from the projection, cumulative. */
  droppedRounds: number;
  /** Estimated tokens dropped from the projection, cumulative. */
  droppedTokens: number;
}

export interface GraduatedLayerApplyRecord {
  readonly layer: 'tool_result_budget' | 'pinpoint_clear' | 'ptl_drain';
  readonly cutoff: number;
}

interface PendingPersist {
  readonly toolCallId: string;
  readonly outputPath: string;
  readonly text: string;
}

/**
 * Graduated multi-layer compaction (F5). Before the expensive LLM full
 * summary fires, two cheaper projection-side layers run in order:
 *
 *   1. tool-result budget — old oversized tool results are persisted to disk
 *      (F10) and replaced by a preview + path;
 *   2. pinpoint clear — older tool results are replaced by a placeholder
 *      marker, keyed by tool_call id so the exchange pairing survives.
 *
 * A third layer, `ptl_drain`, is reactive-only: it arms exclusively from the
 * turn's overflow drain chain after a provider prompt-too-long rejection and
 * drops leading whole API rounds from the outgoing projection.
 *
 * Each layer has its own trigger ratio (the drain layer has none), its own
 * counters (debug/records), and fails open (a layer failure is logged and
 * never blocks the next layer). Full compaction escalates only when the
 * effective token count — raw count minus what the armed layers already save
 * — still exceeds the strategy trigger. All rewrites are projection-side:
 * the stored history, replay, and transcripts keep the original facts.
 */
export class GraduatedCompaction {
  readonly config: GraduatedCompactionConfig;
  private readonly statsRecord: {
    readonly toolResultBudget: GraduatedLayerStats;
    readonly pinpointClear: GraduatedLayerStats;
    readonly ptlDrain: GraduatedPtlDrainStats;
  } = {
    toolResultBudget: { applications: 0, replacedResults: 0, savedTokens: 0 },
    pinpointClear: { applications: 0, replacedResults: 0, savedTokens: 0 },
    ptlDrain: { applications: 0, droppedRounds: 0, droppedTokens: 0 },
  };

  /**
   * Armed state, keyed by tool call id rather than history index so the
   * projection transform is robust against pre-projection shaping (dynamic
   * tool context stripping) that shifts indexes. Cutoffs are still tracked to
   * extend the armed range monotonically as the history grows.
   */
  private budgetCutoff = 0;
  private clearCutoff = 0;
  /**
   * Head-drop cutoff of the ptl_drain layer, as an index into the canonical
   * history (0 = not armed). Always lands on an API-round boundary (a user
   * message index) and only extends monotonically within a session; reset()
   * shrinks it on undo/compaction like the other cutoffs.
   */
  private drainCutoff = 0;
  private readonly budgetReplacements = new Map<string, ContentPart[]>();
  private readonly clearEligible = new Set<string>();
  private clearedMarkerPartsCache: ContentPart[] | undefined;
  /**
   * Monotonic counter bumped on EVERY mutation of `budgetReplacements` or
   * `clearEligible`, so the memoized effective-count savings (below) is
   * invalidated exactly when the armed state the scan reads has changed.
   */
  private armedStateVersion = 0;
  /**
   * Memo for `effectiveTokenCount`'s O(history) savings scan. The scan's
   * inputs are exactly: `drainCutoff`, the armed sets (versioned above), the
   * history length (appends/undo shrink it; in-place content swaps do not
   * happen on the live path — see the method), and the raw pending-inclusive
   * token count (a conservative proxy that changes on every live history
   * mutation that could move a scanned estimate, including open-step growth
   * and usage updates). `beforeStep` queries the count up to three times per
   * step (budget arm check, pinpoint arm check, full-compaction gate); the
   * memo collapses repeat queries over unchanged state to O(1) while still
   * recomputing the moment a layer arms inside the same step, preserving the
   * exact escalation semantics.
   */
  private effectiveSavingsMemo:
    | {
        readonly drainCutoff: number;
        readonly armedStateVersion: number;
        readonly historyLength: number;
        readonly rawTokenCount: number;
        readonly saved: number;
      }
    | undefined;
  /**
   * Savings already reflected in the covered token count. When the provider
   * reports usage for a request, that number is net of every rewrite armed
   * when the request was built; subtracting the same savings again in
   * `effectiveTokenCount` would double-count them, stalling layer extension
   * and deferring the full-compaction escalation past the provider's own
   * rejection. Estimate-based counts (usage-blind providers) never move this
   * off zero, preserving the original raw-minus-savings arithmetic there.
   */
  private realizedSavingsBaseline = 0;

  constructor(
    private readonly agent: Agent,
    config?: GraduatedCompactionConfigInput,
  ) {
    this.config = {
      toolResultBudget: { ...DEFAULT_GRADUATED_COMPACTION_CONFIG.toolResultBudget, ...config?.toolResultBudget },
      pinpointClear: { ...DEFAULT_GRADUATED_COMPACTION_CONFIG.pinpointClear, ...config?.pinpointClear },
      ptlDrain: { ...DEFAULT_GRADUATED_COMPACTION_CONFIG.ptlDrain, ...config?.ptlDrain },
    };
  }

  get stats(): Readonly<{
    toolResultBudget: GraduatedLayerStats;
    pinpointClear: GraduatedLayerStats;
    ptlDrain: GraduatedPtlDrainStats;
  }> {
    return this.statsRecord;
  }

  /** Armed head-drop cutoff of the ptl_drain layer (0 = not armed). */
  get armedDrainCutoff(): number {
    return this.drainCutoff;
  }

  /**
   * Monotonic version of this chain's projection rewrite, read per request by
   * the prefix-drift diagnostics: any change means mid-history tool results
   * were (un)rewritten, so the wire prefix moved without the system prompt or
   * tool table changing.
   */
  get projectionVersion(): {
    readonly budgetCutoff: number;
    readonly clearCutoff: number;
    readonly drainCutoff: number;
    readonly replacedCount: number;
  } {
    return {
      budgetCutoff: this.budgetCutoff,
      clearCutoff: this.clearCutoff,
      drainCutoff: this.drainCutoff,
      replacedCount: this.budgetReplacements.size,
    };
  }

  /**
   * Step-boundary entry point (replaces the old `microCompaction.detect()` +
   * direct `fullCompaction.beforeStep` pair): arm/extend the cheap layers,
   * then escalate to full compaction only when the effective token count
   * still crosses the strategy trigger.
   */
  async beforeStep(signal: AbortSignal): Promise<void> {
    const maxSize = this.agent.fullCompaction.getEffectiveMaxContextTokens();
    if (maxSize > 0) {
      await this.tryArmToolResultBudget(maxSize);
      this.tryArmPinpointClear(maxSize);
    }
    if (
      this.agent.fullCompaction.isCompacting ||
      this.agent.fullCompaction.shouldAutoCompact(this.effectiveTokenCount())
    ) {
      await this.agent.fullCompaction.beforeStep(signal);
    }
  }

  /**
   * PTL drain-chain level 0: arm both cheap layers immediately, ignoring their
   * trigger ratios — a provider prompt-too-long rejection means the ratios
   * already misjudged the real window. The keepRecentMessages protection of
   * each layer still applies. Idempotent: layers already armed up to the
   * current tail skip the re-scan via their cutoff checks.
   */
  async armForOverflow(): Promise<void> {
    const maxSize = this.agent.fullCompaction.getEffectiveMaxContextTokens();
    if (maxSize <= 0) return;
    await this.tryArmToolResultBudget(maxSize, true);
    this.tryArmPinpointClear(maxSize, true);
  }

  /**
   * PTL drain-chain level 1 (reactive-only; never armed by token ratios):
   * extend the drain cutoff so leading whole API rounds leave the outgoing
   * projection, accumulating round estimates until they cover
   * `gapTokens * 1.1`. Without a provider-reported gap the target falls back
   * to 20% of the current request estimate. The most recent complete round
   * and the keepRecentMessages tail always survive. Returns false without
   * changing state when the target cannot be covered inside those limits
   * (giant single round) — the caller then escalates to full compaction.
   */
  armPtlDrain(gapTokens?: number): boolean {
    const cfg = this.config.ptlDrain;
    if (!cfg.enabled) return false;
    try {
      const history = this.agent.context.history;
      const fallbackEstimate = gapTokens === undefined || gapTokens <= 0;
      const target = fallbackEstimate
        ? this.agent.fullCompaction.estimateCurrentRequestTokens() * PTL_DRAIN_FALLBACK_RATIO
        : gapTokens * PTL_DRAIN_GAP_SAFETY_FACTOR;
      // Round boundaries inside the not-yet-drained pool: the pool start plus
      // every user-message index after it. The segment after the last
      // boundary is the most recent round and is never dropped.
      const base = Math.min(this.drainCutoff, history.length);
      const boundaries: number[] = [base];
      for (let i = base + 1; i < history.length; i++) {
        if (history[i]!.role === 'user') boundaries.push(i);
      }
      const keepTailFrom = Math.max(base, history.length - cfg.keepRecentMessages);
      let covered = 0;
      let droppedRounds = 0;
      let newCutoff = base;
      for (let r = 0; r + 1 < boundaries.length; r++) {
        const end = boundaries[r + 1]!;
        if (end > keepTailFrom) break;
        covered += estimateTokensForMessages(history.slice(boundaries[r], end));
        newCutoff = end;
        droppedRounds += 1;
        if (covered >= target) break;
      }
      if (droppedRounds === 0 || covered < target) return false;
      this.drainCutoff = newCutoff;
      const layer = this.statsRecord.ptlDrain;
      layer.applications += 1;
      layer.droppedRounds += droppedRounds;
      layer.droppedTokens += covered;
      this.agent.records.logRecord({
        type: 'graduated_compaction.apply',
        layer: 'ptl_drain',
        cutoff: newCutoff,
      });
      return true;
    } catch (error) {
      // Layers fail open: a failed drain escalates to full compaction instead.
      this.agent.log.warn('graduated compaction: ptl drain layer failed', { error });
      return false;
    }
  }

  /**
   * ContextMemory calls this when a provider-reported usage count replaces
   * the covered token count (step.end with usage): the reported number is
   * already net of the armed rewrites, so the savings current at that moment
   * move into the baseline and only savings accrued afterwards are subtracted
   * from the raw count again.
   */
  onProviderUsageRealized(): void {
    if (
      this.drainCutoff === 0 &&
      this.budgetReplacements.size === 0 &&
      this.clearEligible.size === 0
    ) {
      return;
    }
    this.realizedSavingsBaseline = this.currentSavings();
  }

  /**
   * Projection hook applied by ContextMemory.project before the wire
   * projection. Pure and total: messages are never dropped (pairing
   * integrity), only tool-result content is swapped, and untouched inputs are
   * returned by reference.
   */
  applyToProjection(messages: readonly ContextMessage[]): readonly ContextMessage[] {
    if (this.budgetReplacements.size === 0 && this.clearEligible.size === 0) return messages;
    let out: ContextMessage[] | null = null;
    for (let i = 0; i < messages.length; i++) {
      const message = messages[i]!;
      if (message.role !== 'tool' || message.toolCallId === undefined) continue;
      let content: readonly ContentPart[] | undefined;
      const persisted = this.budgetReplacements.get(message.toolCallId);
      if (persisted !== undefined) content = persisted;
      if (this.clearEligible.has(message.toolCallId)) {
        const current = content ?? message.content;
        if (estimateTokensForContentParts(current) >= this.config.pinpointClear.minContentTokens) {
          content = this.clearedMarkerParts();
        }
      }
      if (content === undefined) continue;
      out ??= [...messages];
      out[i] = { ...message, content: [...content] };
    }
    return out ?? messages;
  }

  /**
   * Shrink the armed range after history mutations: full clear/compaction
   * (`maxCutoff` 0) or undo (`maxCutoff` = surviving history length). Mirrors
   * the old MicroCompaction.reset contract.
   */
  reset(maxCutoff = 0): void {
    this.budgetCutoff = Math.min(this.budgetCutoff, maxCutoff);
    this.clearCutoff = Math.min(this.clearCutoff, maxCutoff);
    this.drainCutoff = Math.min(this.drainCutoff, maxCutoff);
    if (this.budgetCutoff === 0) {
      if (this.budgetReplacements.size > 0) {
        this.budgetReplacements.clear();
        this.armedStateVersion += 1;
      }
    } else {
      this.pruneBudgetReplacements();
    }
    if (this.clearCutoff === 0) {
      if (this.clearEligible.size > 0) {
        this.clearEligible.clear();
        this.armedStateVersion += 1;
      }
    } else {
      this.rebuildClearEligible();
    }
    // The covered count the baseline was measured against is gone (clear) or
    // shrunk (undo); dropping it re-subtracts at most — the safe direction.
    this.realizedSavingsBaseline = 0;
    this.effectiveSavingsMemo = undefined;
  }

  /**
   * Records-restore entry point. Restore must not touch the filesystem (see
   * the contract in records/index.ts): the replacement texts embed
   * deterministic paths, and the files written by the live session remain on
   * disk under the same session directory. Unknown layers (written by a newer
   * version) fail open with a log line — the previous else-branch silently
   * armed the budget layer for ANY unrecognized value.
   */
  restoreLayerApply(input: GraduatedLayerApplyRecord): void {
    const cutoff = Math.min(input.cutoff, this.agent.context.history.length);
    switch (input.layer) {
      case 'tool_result_budget':
        this.armToolResultBudget(cutoff);
        return;
      case 'pinpoint_clear':
        this.armPinpointClear(cutoff);
        return;
      case 'ptl_drain':
        this.drainCutoff = Math.max(this.drainCutoff, cutoff);
        return;
      default:
        this.agent.log.warn('graduated compaction: ignoring unknown layer record', {
          layer: input.layer,
        });
    }
  }

  private async tryArmToolResultBudget(maxSize: number, force = false): Promise<void> {
    const cfg = this.config.toolResultBudget;
    if (!cfg.enabled) return;
    const nextCutoff = Math.max(0, this.agent.context.history.length - cfg.keepRecentMessages);
    if (nextCutoff <= this.budgetCutoff) return;
    if (!force && this.effectiveTokenCount() < maxSize * cfg.triggerRatio) return;
    try {
      const pending = this.armToolResultBudget(nextCutoff);
      await this.persistBudgetReplacements(pending);
      const layer = this.statsRecord.toolResultBudget;
      layer.applications += 1;
      layer.replacedResults = this.budgetReplacements.size;
      layer.savedTokens = this.measureLayerSavings('tool_result_budget');
      this.agent.records.logRecord({
        type: 'graduated_compaction.apply',
        layer: 'tool_result_budget',
        cutoff: nextCutoff,
      });
    } catch (error) {
      // Layers fail open: a failed cheap layer never blocks the next one.
      this.agent.log.warn('graduated compaction: tool-result budget layer failed', { error });
    }
  }

  private tryArmPinpointClear(maxSize: number, force = false): void {
    const cfg = this.config.pinpointClear;
    if (!cfg.enabled) return;
    const nextCutoff = Math.max(0, this.agent.context.history.length - cfg.keepRecentMessages);
    if (nextCutoff <= this.clearCutoff) return;
    if (!force && this.effectiveTokenCount() < maxSize * cfg.triggerRatio) return;
    try {
      this.armPinpointClear(nextCutoff);
      const layer = this.statsRecord.pinpointClear;
      layer.applications += 1;
      layer.replacedResults = this.clearEligible.size;
      layer.savedTokens = this.measureLayerSavings('pinpoint_clear');
      this.agent.records.logRecord({
        type: 'graduated_compaction.apply',
        layer: 'pinpoint_clear',
        cutoff: nextCutoff,
      });
    } catch (error) {
      this.agent.log.warn('graduated compaction: pinpoint clear layer failed', { error });
    }
  }

  /**
   * Build budget-layer replacements for every eligible tool result in
   * `[0, cutoff)`. Returns the file writes the caller must flush; on restore
   * the writes are skipped (no fs side effects) because the deterministic
   * paths already exist from the live session.
   */
  private armToolResultBudget(cutoff: number): readonly PendingPersist[] {
    const cfg = this.config.toolResultBudget;
    const baseThresholds = resolveToolResultBudgetThresholds({
      maxBytes: cfg.maxBytes,
      maxLines: cfg.maxLines,
      previewHeadChars: cfg.previewHeadChars,
      previewTailChars: cfg.previewTailChars,
    });
    const homedir = this.agent.homedir;
    const history = this.agent.context.history;
    const pending: PendingPersist[] = [];
    // Without a session directory the full text cannot be persisted; keep the
    // original messages rather than replacing them with dangling paths. The
    // cutoff still advances so this scan is not repeated every step.
    if (homedir === undefined) {
      this.budgetCutoff = Math.max(this.budgetCutoff, cutoff);
      return pending;
    }
    // toolCallId → tool name, for resolving the per-tool snipHint (SnipHinter
    // analog): a declared line geometry overrides the layer's character
    // preview for that result.
    const toolNameByCallId = new Map<string, string>();
    for (const message of history) {
      if (message.role !== 'assistant') continue;
      for (const call of message.toolCalls) {
        toolNameByCallId.set(call.id, call.name);
      }
    }
    const limit = Math.min(cutoff, history.length);
    for (let i = 0; i < limit; i++) {
      const message = history[i]!;
      if (message.role !== 'tool' || message.toolCallId === undefined) continue;
      if (this.budgetReplacements.has(message.toolCallId)) continue;
      // KeepPolicy.KeepErrors: error results stay verbatim — the failure text
      // is the highest-value content for not re-walking a dead end, and the
      // stored `isError` flag keys it directly (reasonix matches an `error:`
      // text prefix; the structured flag is the exact equivalent here).
      if (message.isError === true) continue;
      const text = extractToolResultText(message.content);
      if (text === undefined || !exceedsToolResultBudget(text, baseThresholds)) continue;
      const toolName = toolNameByCallId.get(message.toolCallId);
      const snipHint =
        toolName === undefined ? undefined : this.agent.tools.getBuiltinTool(toolName)?.snipHint;
      const thresholds =
        snipHint === undefined
          ? baseThresholds
          : resolveToolResultBudgetThresholds({
              maxBytes: cfg.maxBytes,
              maxLines: cfg.maxLines,
              previewHeadChars: cfg.previewHeadChars,
              previewTailChars: cfg.previewTailChars,
              previewHeadLines: snipHint.headLines,
              previewTailLines: snipHint.tailLines,
            });
      const outputPath = persistedToolResultPath(homedir, message.toolCallId, text);
      this.budgetReplacements.set(message.toolCallId, [
        {
          type: 'text',
          text: renderPersistedToolResult({
            toolCallId: message.toolCallId,
            text,
            outputPath,
            thresholds,
          }),
        },
      ]);
      pending.push({ toolCallId: message.toolCallId, outputPath, text });
    }
    if (pending.length > 0) this.armedStateVersion += 1;
    this.budgetCutoff = Math.max(this.budgetCutoff, cutoff);
    return pending;
  }

  private async persistBudgetReplacements(pending: readonly PendingPersist[]): Promise<void> {
    await Promise.all(
      pending.map(async ({ toolCallId, outputPath, text }) => {
        try {
          await writePersistedToolResult(outputPath, text);
        } catch (error) {
          // A result whose file could not be written keeps its original
          // content — a replacement pointing at a missing file would silently
          // lose the output.
          if (this.budgetReplacements.delete(toolCallId)) this.armedStateVersion += 1;
          this.agent.log.warn('graduated compaction: failed to persist tool result', {
            toolCallId,
            outputPath,
            error,
          });
        }
      }),
    );
  }

  private armPinpointClear(cutoff: number): void {
    this.clearCutoff = Math.max(this.clearCutoff, cutoff);
    this.rebuildClearEligible();
  }

  private rebuildClearEligible(): void {
    this.clearEligible.clear();
    this.armedStateVersion += 1;
    const history = this.agent.context.history;
    const limit = Math.min(this.clearCutoff, history.length);
    for (let i = 0; i < limit; i++) {
      const message = history[i]!;
      if (message.role !== 'tool' || message.toolCallId === undefined) continue;
      // KeepPolicy.KeepErrors: never clear error results (same rationale as
      // the budget layer above).
      if (message.isError === true) continue;
      if (estimateTokensForContentParts(message.content) < this.config.pinpointClear.minContentTokens) {
        continue;
      }
      this.clearEligible.add(message.toolCallId);
    }
  }

  private pruneBudgetReplacements(): void {
    const history = this.agent.context.history;
    const limit = Math.min(this.budgetCutoff, history.length);
    const alive = new Set<string>();
    for (let i = 0; i < limit; i++) {
      const message = history[i]!;
      if (message.role === 'tool' && message.toolCallId !== undefined) alive.add(message.toolCallId);
    }
    for (const toolCallId of this.budgetReplacements.keys()) {
      if (!alive.has(toolCallId)) {
        this.budgetReplacements.delete(toolCallId);
        this.armedStateVersion += 1;
      }
    }
  }

  /**
   * Raw stored-history token count minus what the armed layers save in the
   * projection. Full compaction escalates on this value, so a history whose
   * shrinkable mass is already handled never pays for an LLM summary. The
   * drained head counts as saved: without it the next step boundary would
   * escalate to a full summary right after a successful PTL drain.
   *
   * When the covered count came from provider-reported usage, it is already
   * net of the rewrites armed at request time; only savings accrued after
   * that report (`realizedSavingsBaseline`) are subtracted here, keeping the
   * result in the same units as the raw count. Public so the status surface
   * can report the same number the compaction trigger sees.
   */
  effectiveTokenCount(): number {
    const raw = this.agent.context.tokenCountWithPending;
    if (
      this.drainCutoff === 0 &&
      this.budgetReplacements.size === 0 &&
      this.clearEligible.size === 0
    ) {
      return raw;
    }
    return raw - Math.max(0, this.currentSavings() - this.realizedSavingsBaseline);
  }

  /**
   * Estimated tokens the armed layers currently save in the projection,
   * memoized per `effectiveSavingsMemo`'s key (see its doc comment).
   */
  private currentSavings(): number {
    const raw = this.agent.context.tokenCountWithPending;
    const history = this.agent.context.history;
    const memo = this.effectiveSavingsMemo;
    if (
      memo !== undefined &&
      memo.drainCutoff === this.drainCutoff &&
      memo.armedStateVersion === this.armedStateVersion &&
      memo.historyLength === history.length &&
      memo.rawTokenCount === raw
    ) {
      return memo.saved;
    }
    let saved = 0;
    const drainLimit = Math.min(this.drainCutoff, history.length);
    for (let i = 0; i < drainLimit; i++) {
      saved += estimateTokensForMessage(history[i]!);
    }
    for (let i = drainLimit; i < history.length; i++) {
      const message = history[i]!;
      if (message.role !== 'tool' || message.toolCallId === undefined) continue;
      const originalTokens = estimateTokensForContentParts(message.content);
      let projectedTokens = originalTokens;
      const persisted = this.budgetReplacements.get(message.toolCallId);
      if (persisted !== undefined) projectedTokens = estimateTokensForContentParts(persisted);
      if (
        this.clearEligible.has(message.toolCallId) &&
        projectedTokens >= this.config.pinpointClear.minContentTokens
      ) {
        projectedTokens = this.clearedMarkerTokens();
      }
      saved += originalTokens - projectedTokens;
    }
    this.effectiveSavingsMemo = {
      drainCutoff: this.drainCutoff,
      armedStateVersion: this.armedStateVersion,
      historyLength: history.length,
      rawTokenCount: raw,
      saved,
    };
    return saved;
  }

  private measureLayerSavings(layer: 'tool_result_budget' | 'pinpoint_clear'): number {
    let saved = 0;
    for (const message of this.agent.context.history) {
      if (message.role !== 'tool' || message.toolCallId === undefined) continue;
      if (layer === 'tool_result_budget') {
        const persisted = this.budgetReplacements.get(message.toolCallId);
        if (persisted === undefined) continue;
        saved +=
          estimateTokensForContentParts(message.content) - estimateTokensForContentParts(persisted);
        continue;
      }
      if (!this.clearEligible.has(message.toolCallId)) continue;
      const base = this.budgetReplacements.get(message.toolCallId) ?? message.content;
      const baseTokens = estimateTokensForContentParts(base);
      if (baseTokens < this.config.pinpointClear.minContentTokens) continue;
      saved += baseTokens - this.clearedMarkerTokens();
    }
    return saved;
  }

  private clearedMarkerParts(): ContentPart[] {
    this.clearedMarkerPartsCache ??= [
      { type: 'text', text: this.config.pinpointClear.clearedMarker },
    ];
    return this.clearedMarkerPartsCache;
  }

  private clearedMarkerTokens(): number {
    return estimateTokensForContentParts(this.clearedMarkerParts());
  }
}

/** Safety factor applied to the provider-reported overflow gap (initial value). */
const PTL_DRAIN_GAP_SAFETY_FACTOR = 1.1;
/**
 * Head-drop target as a fraction of the current request estimate, used when
 * the provider's overflow wording carried no token counts (initial value).
 */
const PTL_DRAIN_FALLBACK_RATIO = 0.2;
