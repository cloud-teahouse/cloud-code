/**
 * Durable request-trace recorder: writes the observability records
 * (`llm.tools_snapshot`, `llm.request`) that make every outbound model
 * request reconstructable from the wire log. Called from the single
 * `Agent.generate` choke point, so loop steps, retry attempts, strict
 * resends, and compaction rounds all leave a trace.
 *
 * Sibling of `LlmRequestLogger` (diagnostic log lines, hashes only); this
 * class owns the wire-record side. See the observability-records note in
 * `records/types.ts` for the persistence contract.
 */

import { KimiChatProvider, type ChatProvider, type Message, type Tool, type TokenUsage } from '@cloud-code/kosong';

import { parseBooleanEnv, parseFloatEnv, resolveConfigValue } from '#/config/resolve';
import { resolveThinkingKeep } from '#/config/cloud-code-env-params';
import type { CloudCodeConfig } from '#/config/schema';

import type { Agent } from '.';
import type { LLMRequestLogFields } from '../loop';
import { fingerprint, toolSignature } from './llm-request-logger';
import {
  captureShape,
  compareShape,
  type PrefixDriftReason,
  type PrefixShape,
} from './prefix-shape';

/**
 * How often a "prefix stable" summary line is logged while cache diagnostics
 * are enabled (every Nth settled request without drift).
 */
const PREFIX_STABLE_LOG_INTERVAL = 10;

/**
 * `debug.cacheDiagnostics` in config, overridable by
 * `CLOUD_CODE_DEBUG_CACHE=1` (env wins, following the `resolveConfigValue`
 * pattern used by the other env-tunable settings). Shared with the system
 * prompt assembly, which gates its per-section diagnostics dump on the same
 * switch.
 */
export function cacheDiagnosticsEnabled(config: CloudCodeConfig | undefined): boolean {
  return resolveConfigValue({
    env: process.env,
    envKey: 'CLOUD_CODE_DEBUG_CACHE',
    configValue: config?.debug?.cacheDiagnostics,
    defaultValue: false,
    parseEnv: parseBooleanEnv,
  });
}

export class LlmRequestRecorder {
  /** Hashes of tool tables already durable in this wire log. */
  private readonly seenToolsHashes = new Set<string>();
  /**
   * Identity cache over the last wire tool table. Tool instances are treated
   * as immutable and are stable across steps (rebuilt only by
   * `initializeBuiltinTools` / MCP re-registration), so element-wise identity
   * implies content equality — the common per-step path costs no hashing.
   */
  private lastWireTools: readonly Tool[] | undefined;
  private lastToolsHash: string | undefined;
  private lastSystemPrompt: string | undefined;
  private lastSystemPromptHash: string | undefined;
  /**
   * Prefix shape of the previously recorded request; the drift attribution
   * baseline. Undefined until the first record (and after restore — a resumed
   * session re-baselines on its first request instead of reporting a
   * spurious drift against a shape it never captured).
   */
  private lastShape: PrefixShape | undefined;
  /**
   * Drift of the most recently recorded request, waiting to be correlated
   * with that request's cache counters once its usage lands
   * (`reportUsageSettled`). Overwritten if another request is recorded first
   * (a failed retry attempt leaves no usage; the successful resend's drift is
   * the one worth attributing).
   */
  private pendingDrift: {
    readonly reasons: readonly PrefixDriftReason[];
    readonly shape: PrefixShape;
    readonly systemPromptChangedSections: readonly string[] | undefined;
  } | undefined;
  /** Settled requests since the last "prefix stable" summary log. */
  private stableSettledRequests = 0;

  constructor(private readonly agent: Agent) {}

  /** Replay: a snapshot with this hash is already durable; never re-log it. */
  restoreToolsSnapshot(hash: string): void {
    this.seenToolsHashes.add(hash);
  }

  record(input: {
    readonly provider: ChatProvider;
    readonly systemPrompt: string;
    readonly tools: readonly Tool[];
    readonly messages: readonly Message[];
    readonly fields: LLMRequestLogFields | undefined;
  }): void {
    const { provider, systemPrompt, messages } = input;
    const fields = input.fields ?? {};
    // Deferred tools are stripped by kosong generate() before the provider
    // sees them; snapshot what actually goes on the wire. In disclosure mode
    // this keeps the snapshot byte-stable across select_tools loads.
    const wireTools = input.tools.filter((tool) => tool.deferred !== true);
    const toolsHash = this.toolsHashFor(wireTools);
    if (!this.seenToolsHashes.has(toolsHash)) {
      this.seenToolsHashes.add(toolsHash);
      this.agent.records.logRecord({
        type: 'llm.tools_snapshot',
        hash: toolsHash,
        tools: toolSignature(wireTools),
      });
    }

    const systemPromptHash = this.systemPromptHashFor(systemPrompt);
    // Prefix-drift attribution (F7): compare the per-request prefix shape
    // against the previous request. Cheap — both hashes are already computed
    // above; the shape only adds the comparison.
    const shape = captureShape({
      systemHash: systemPromptHash,
      toolsHash,
      projection: fields.projection,
      graduatedVersion: this.agent.graduatedCompaction.projectionVersion,
      historyLength: messages.length,
    });
    const previousShape = this.lastShape;
    const driftReasons = compareShape(previousShape, shape);
    this.lastShape = shape;
    // Section-level refinement of a `system` drift: name the sections
    // that moved. Undefined when either prompt is not a known assembly (e.g.
    // an override prompt set directly through `config.update`) — the
    // dimension-level attribution above still stands on its own then.
    const systemPromptChangedSections =
      previousShape !== undefined && driftReasons.includes('system')
        ? this.agent.systemPromptSections.attributeDrift(previousShape.systemHash, shape.systemHash)
        : undefined;
    this.pendingDrift =
      driftReasons.length > 0 ? { reasons: driftReasons, shape, systemPromptChangedSections } : undefined;

    const modelAlias = this.agent.config.modelAlias;
    // Mirror the ConfigState.provider pipeline for Kimi-only request params:
    // env sampling overrides and the preserved-thinking keep passthrough
    // reach the wire only for Kimi providers, resolved by the same exported
    // helpers used at construction. thinkingEffort needs no mirroring — the
    // Kimi provider derives it from the request body's thinking payload, so
    // env effort overrides are already reflected in the read value.
    const isCloudCodeProvider = provider instanceof KimiChatProvider;
    this.agent.records.logRecord({
      type: 'llm.request',
      kind: fields.kind ?? 'loop',
      provider: provider.name,
      model: provider.modelName,
      modelAlias,
      thinkingEffort: provider.thinkingEffort ?? undefined,
      thinkingKeep: isCloudCodeProvider
        ? resolveThinkingKeep(
            process.env,
            this.agent.kimiConfig?.thinking?.keep,
            provider.thinkingEffort ?? 'off',
          )
        : undefined,
      temperature: isCloudCodeProvider
        ? parseFloatEnv(process.env['KIMI_MODEL_TEMPERATURE'], 'KIMI_MODEL_TEMPERATURE')
        : undefined,
      topP: isCloudCodeProvider
        ? parseFloatEnv(process.env['KIMI_MODEL_TOP_P'], 'KIMI_MODEL_TOP_P')
        : undefined,
      maxTokens: provider.maxCompletionTokens,
      betaApi:
        modelAlias === undefined
          ? undefined
          : this.agent.kimiConfig?.models?.[modelAlias]?.betaApi,
      toolSelect: this.agent.toolSelectEnabled,
      systemPromptHash,
      systemPrompt:
        systemPrompt === this.agent.config.systemPrompt ? undefined : systemPrompt,
      toolsHash,
      messageCount: messages.length,
      turnStep: fields.turnStep,
      attempt: fields.attempt,
      projection: fields.projection,
      droppedCount: fields.droppedCount,
      prefixDriftReasons: driftReasons.length > 0 ? driftReasons : undefined,
      systemPromptChangedSections,
    });
  }

  /**
   * Correlate the settled request's cache counters with its prefix drift and
   * emit the F7 cache diagnostics. Called from `UsageRecorder.record`, the
   * single point where a request's provider-reported usage lands. No-op
   * unless `debug.cacheDiagnostics` / `CLOUD_CODE_DEBUG_CACHE` is on — the
   * comparison itself always runs (it is cheap and feeds the durable
   * `llm.request.prefixDriftReasons`), only the log fan-out is
   * gated.
   */
  reportUsageSettled(usage: TokenUsage): void {
    if (this.agent.records.restoring) return;
    const pending = this.pendingDrift;
    this.pendingDrift = undefined;
    if (!this.cacheDiagnosticsEnabled()) return;

    if (pending !== undefined) {
      this.agent.log.warn('llm prefix drift', {
        reasons: pending.reasons.join(','),
        historyLength: pending.shape.historyLength,
        cache_read: usage.inputCacheRead,
        cache_creation: usage.inputCacheCreation,
        ...(pending.systemPromptChangedSections !== undefined
          ? { system_sections: pending.systemPromptChangedSections.join(',') }
          : {}),
      });
      this.stableSettledRequests = 0;
      return;
    }

    this.stableSettledRequests += 1;
    if (this.stableSettledRequests % PREFIX_STABLE_LOG_INTERVAL === 0) {
      this.agent.log.info('llm prefix stable', {
        settledRequests: this.stableSettledRequests,
        cache_read: usage.inputCacheRead,
        cache_creation: usage.inputCacheCreation,
      });
    }
  }

  /**
   * `debug.cacheDiagnostics` in config, overridable by
   * `CLOUD_CODE_DEBUG_CACHE=1` — see the exported {@link cacheDiagnosticsEnabled}.
   */
  private cacheDiagnosticsEnabled(): boolean {
    return cacheDiagnosticsEnabled(this.agent.kimiConfig);
  }

  private toolsHashFor(wireTools: readonly Tool[]): string {
    if (this.lastToolsHash !== undefined && sameToolInstances(this.lastWireTools, wireTools)) {
      return this.lastToolsHash;
    }
    const hash = fingerprint(JSON.stringify(toolSignature(wireTools)));
    this.lastWireTools = wireTools;
    this.lastToolsHash = hash;
    return hash;
  }

  private systemPromptHashFor(systemPrompt: string): string {
    if (this.lastSystemPromptHash === undefined || systemPrompt !== this.lastSystemPrompt) {
      this.lastSystemPrompt = systemPrompt;
      this.lastSystemPromptHash = fingerprint(systemPrompt);
    }
    return this.lastSystemPromptHash;
  }
}

function sameToolInstances(
  previous: readonly Tool[] | undefined,
  current: readonly Tool[],
): boolean {
  if (previous === undefined || previous.length !== current.length) return false;
  for (let i = 0; i < current.length; i++) {
    if (previous[i] !== current[i]) return false;
  }
  return true;
}
