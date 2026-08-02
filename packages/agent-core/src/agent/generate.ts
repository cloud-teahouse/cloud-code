/**
 * LLM request dispatch boundary (`Agent.generate`): builds the `generate`
 * closure every turn-loop step, retry, strict resend, and compaction round
 * goes through, layering request logging, wire-record tracing, auth
 * resolution, the wire-boundary normalize-repair report, and the Anthropic
 * thinking-effort capability warning on top of the raw kosong `generate`.
 * Sibling of `LlmRequestLogger`/`LlmRequestRecorder`, which own the two
 * tracing sinks this pipeline feeds.
 */

import type {
  ChatProvider,
  GenerateOptions,
  NormalizeRepairKind,
  generate,
} from '@cloud-code/kosong';

import type { Agent } from './agent';
import { splitGenerateOptions } from './llm-request-logger';

export class GeneratePipeline {
  private lastWireNormalizeRepairSignature: string | null = null;
  private readonly emittedThinkingEffortWarnings = new Set<string>();
  private readonly pendingThinkingEffortWarnings: Array<{
    readonly code: string;
    readonly message: string;
    readonly modelAlias: string | undefined;
    readonly model: string;
    readonly effort: string;
    readonly knownEfforts: string | undefined;
  }> = [];

  constructor(private readonly agent: Agent) {}

  createGenerate(): typeof generate {
    const agent = this.agent;
    return async (provider, systemPrompt, tools, history, callbacks, options) => {
      const { requestLogFields, generateOptions } = splitGenerateOptions(options);
      const modelAlias = agent.config.modelAlias;
      const run = (requestOptions: Parameters<typeof generate>[5]) => {
        // Mirror kosong generate()'s pre-flight abort check: a call whose
        // signal is already aborted never reaches the wire (generate throws
        // before dispatching), so it must not leave a request trace or a
        // diagnostic log line claiming a request was sent.
        if (requestOptions?.signal?.aborted !== true) {
          this.warnAboutAnthropicThinkingEffort(provider, modelAlias);
          agent.llmRequestLogger.logRequest({
            provider,
            modelAlias,
            systemPrompt,
            tools,
            messages: history,
            fields: requestLogFields,
          });
          agent.llmRequestRecorder.record({
            provider,
            systemPrompt,
            tools,
            messages: history,
            fields: requestLogFields,
          });
        }
        return agent.rawGenerate(
          provider,
          systemPrompt,
          tools,
          history,
          callbacks,
          this.withNormalizeRepairHook(requestOptions),
        );
      };
      if (generateOptions?.auth !== undefined) {
        return run(generateOptions);
      }
      const withAuth =
        modelAlias === undefined
          ? undefined
          : agent.modelProvider?.resolveAuth?.(modelAlias, { log: agent.log });
      if (withAuth === undefined) {
        return run(generateOptions);
      }
      return withAuth((auth) => {
        return run({ ...generateOptions, auth });
      });
    };
  }

  /**
   * Collect the defensive wire layer's repairs (kosong `onNormalizeRepair`)
   * and surface them like the projector's repairs: one deduped-by-signature
   * warn per distinct repair set. kosong runs the normalization
   * synchronously at the head of `generate()`, so the report fires before the
   * stream drains — a repair is visible even when the request then fails.
   */
  private withNormalizeRepairHook(requestOptions: GenerateOptions | undefined): GenerateOptions {
    const repairs: Array<{ kind: NormalizeRepairKind; toolCallId: string }> = [];
    const optionsWithHook: GenerateOptions = {
      ...requestOptions,
      onNormalizeRepair: (kind, toolCallId) => {
        repairs.push({ kind, toolCallId });
        requestOptions?.onNormalizeRepair?.(kind, toolCallId);
      },
    };
    queueMicrotask(() => {
      this.reportWireNormalizeRepairs(repairs);
    });
    return optionsWithHook;
  }

  private reportWireNormalizeRepairs(
    repairs: readonly { kind: NormalizeRepairKind; toolCallId: string }[],
  ): void {
    if (repairs.length === 0) {
      this.lastWireNormalizeRepairSignature = null;
      return;
    }
    const signature = repairs
      .map((repair) => `${repair.kind}:${repair.toolCallId}`)
      .toSorted()
      .join('|');
    if (signature === this.lastWireNormalizeRepairSignature) return;
    this.lastWireNormalizeRepairSignature = signature;

    let argumentsClosed = 0;
    let argumentsFallbackEmpty = 0;
    let emptyToolName = 0;
    let orphanToolResultDropped = 0;
    let missingToolResultSynthesized = 0;
    for (const repair of repairs) {
      if (repair.kind === 'arguments_closed') argumentsClosed += 1;
      else if (repair.kind === 'arguments_fallback_empty') argumentsFallbackEmpty += 1;
      else if (repair.kind === 'empty_tool_name') emptyToolName += 1;
      else if (repair.kind === 'orphan_tool_result_dropped') orphanToolResultDropped += 1;
      else missingToolResultSynthesized += 1;
    }
    const toolCallIds = [...new Set(repairs.map((repair) => repair.toolCallId))].slice(0, 5);
    this.agent.log.warn('normalized the request history at the wire boundary', {
      argumentsClosed,
      argumentsFallbackEmpty,
      emptyToolName,
      orphanToolResultDropped,
      missingToolResultSynthesized,
      toolCallIds,
    });
  }

  private warnAboutAnthropicThinkingEffort(
    provider: ChatProvider,
    modelAlias: string | undefined,
  ): void {
    if (provider.name !== 'anthropic') return;
    const effort = provider.thinkingEffort;
    if (effort === null || effort === 'on' || effort === 'off') return;

    let warning:
      | { readonly code: string; readonly message: string; readonly knownEfforts?: string }
      | undefined;
    try {
      const resolved =
        modelAlias === undefined
          ? undefined
          : this.agent.modelProvider?.resolveProviderConfig(modelAlias);
      if (resolved === undefined) return;

      const supportEfforts = resolved.supportEfforts?.filter((value) => value.length > 0);
      if (supportEfforts === undefined || supportEfforts.length === 0) return;
      if (supportEfforts.includes(effort)) return;
      warning = {
        code: 'anthropic-thinking-effort-not-listed',
        message: `Thinking effort "${effort}" is not listed for model "${provider.modelName}" (known: ${supportEfforts.join(', ')}). The configured value will be sent unchanged to the Anthropic-compatible backend.`,
        knownEfforts: supportEfforts.join(','),
      };
    } catch {
      // Capability diagnostics must never turn an otherwise sendable request
      // into a client-side failure.
      return;
    }

    if (warning === undefined) return;
    const key = [warning.code, modelAlias, provider.modelName, effort, warning.knownEfforts].join(
      '\u0000',
    );
    if (this.emittedThinkingEffortWarnings.has(key)) return;
    this.emittedThinkingEffortWarnings.add(key);
    const pending = {
      code: warning.code,
      message: warning.message,
      modelAlias,
      model: provider.modelName,
      effort,
      knownEfforts: warning.knownEfforts,
    };
    if (this.agent.records.restoring) {
      this.pendingThinkingEffortWarnings.push(pending);
      return;
    }
    this.publishAnthropicThinkingEffortWarning(pending);
  }

  private publishAnthropicThinkingEffortWarning(
    warning: (typeof this.pendingThinkingEffortWarnings)[number],
  ): void {
    try {
      this.agent.log.warn(warning.message, {
        modelAlias: warning.modelAlias,
        model: warning.model,
        effort: warning.effort,
        knownEfforts: warning.knownEfforts,
      });
    } catch {
      // Diagnostics must never block resume or request dispatch.
    }
    try {
      const delivery = this.agent.rpc?.emitEvent?.({
        type: 'warning',
        code: warning.code,
        message: warning.message,
      });
      void delivery?.catch(() => {});
    } catch {
      // Diagnostics must never block resume or request dispatch.
    }
  }

  flushPendingAnthropicThinkingEffortWarnings(): void {
    for (const warning of this.pendingThinkingEffortWarnings.splice(0)) {
      this.publishAnthropicThinkingEffortWarning(warning);
    }
  }

  warnAboutCurrentAnthropicThinkingEffort(): void {
    try {
      if (!this.agent.config.hasProvider) return;
      this.warnAboutAnthropicThinkingEffort(this.agent.config.provider, this.agent.config.modelAlias);
    } catch {
      // A capability warning must never make config replay or session resume fail.
    }
  }
}
