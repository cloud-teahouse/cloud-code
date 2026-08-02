import { APIEmptyResponseError } from './errors';
import {
  isContentPart,
  isToolCall,
  isToolCallPart,
  mergeInPlace,
  type Message,
  type StreamedMessagePart,
  type ToolCall,
} from './message';
import { normalizeMessagesForWire } from './normalize';
import type { ChatProvider, FinishReason, GenerateOptions, StreamedMessage } from './provider';
import type { RateLimitSnapshot } from './rate-limit';
import type { Tool } from './tool';
import type { TokenUsage } from './usage';

/** Snapshot of a ToolCall excluding the internal `_streamIndex` routing field. */
type StoredToolCall = Omit<ToolCall, '_streamIndex'>;

/**
 * The result of a single {@link generate} call.
 *
 * Contains the fully-assembled assistant {@link message}, an optional
 * provider-assigned {@link id}, and token {@link usage} statistics.
 */
export interface GenerateResult {
  /** Provider-assigned response identifier, or `null` if unavailable. */
  readonly id: string | null;
  /** The fully-assembled assistant message with merged content parts and tool calls. */
  readonly message: Message;
  /** Token usage for this generation, or `null` if not reported. */
  readonly usage: TokenUsage | null;
  /**
   * Normalized finish reason reported by the provider, or `null` if no
   * finish_reason was emitted (for example, the stream was interrupted
   * before the final event).
   */
  readonly finishReason: FinishReason | null;
  /**
   * Raw provider-specific finish_reason string preserved verbatim.
   * `null` if the provider did not emit one.
   */
  readonly rawFinishReason: string | null;
  /**
   * Provider trace identifier from the `x-trace-id` response header
   * (Kimi/KFC only), or `null` when the provider does not report one.
   */
  readonly traceId?: string | null;
  /**
   * Account rate-limit snapshot from the `x-codex-*` response headers
   * (ChatGPT Codex backend only). Absent for providers that never report
   * quota headers; `null` when the backend sent none.
   */
  readonly rateLimit?: RateLimitSnapshot | null;
}

export interface GenerateCallbacks {
  onMessagePart?: (part: StreamedMessagePart) => void | Promise<void>;
  /**
   * Fires once per fully-assembled tool call after the stream drains, in the
   * order tool calls appear in the final assistant message.
   *
   * Tool calls are deliberately deferred until after the stream completes:
   * parallel-tool-call streams may interleave argument deltas across calls
   * (e.g. tc0-header → tc1-header → tc0-args → tc1-args), so firing mid-stream
   * would dispatch a tool with half-parsed arguments and trigger toolParseError.
   */
  onToolCall?: (toolCall: ToolCall) => void | Promise<void>;
  /**
   * Fires the moment a tool call leaves the pending slot at a merge boundary
   * MID-STREAM — a subsequent non-merging part proved its arguments complete.
   * Lets hosts start executing completed calls while the model is still
   * streaming (streaming tool execution).
   *
   * The last pending call never fires here: it flushes only at stream end,
   * where a stream that broke off mid-arguments is indistinguishable from a
   * complete one until the finish reason is known. Final calls are reported
   * exclusively through {@link GenerateCallbacks.onToolCall} and the returned
   * message.
   *
   * The callback receives a snapshot taken at flush time. Completion uses the
   * same merge-boundary inference that finalizes calls into
   * `message.toolCalls`; a provider that interleaves argument deltas across
   * parallel calls (non-conforming, see `onToolCall`) could fire this before
   * late-routed deltas land. Sequential-conforming providers (Anthropic,
   * OpenAI, Kimi, Gemini) are exact.
   */
  onToolCallReady?: (toolCall: ToolCall) => void | Promise<void>;
}

/**
 * Generate one assistant message by streaming from the given provider.
 *
 * Parts of the message are streamed and merged: consecutive compatible parts
 * (e.g. TextPart + TextPart, ToolCall + ToolCallPart) are merged in-place so
 * the returned message always contains fully-assembled parts.
 *
 * **Tool call completion** is inferred from merge boundaries (a non-merging
 * next part flushes the pending tool call into `message.toolCalls`) and from
 * stream end. Provider adapters translate native "done" signals into this
 * unified form; the generate loop never sees a separate done event.
 *
 * @param provider - The chat provider to generate from.
 * @param systemPrompt - System-level instruction prepended to the request.
 * @param tools - Tool definitions the model may invoke.
 * @param history - The conversation history sent as context.
 * @param callbacks - Optional streaming callbacks.
 * @param options - Optional per-call settings (e.g. an {@link AbortSignal}).
 *
 * @throws {DOMException} with name `"AbortError"` when `options.signal` is
 *   aborted before or during streaming.
 * @throws {APIEmptyResponseError} when the response contains no content and
 *   no tool calls, or only thinking content without any text or tool calls.
 */
export async function generate(
  provider: ChatProvider,
  systemPrompt: string,
  tools: Tool[],
  history: Message[],
  callbacks?: GenerateCallbacks,
  options?: GenerateOptions,
): Promise<GenerateResult> {
  const message: Message = { role: 'assistant', content: [], toolCalls: [] };
  let pendingPart: StreamedMessagePart | null = null;

  // Map from provider streaming index (e.g. OpenAI Chat `index`, Responses
  // `item_id`) to the position inside `message.toolCalls`. Used to route
  // interleaved argument deltas from parallel tool calls to the correct call.
  const toolCallIndexMap = new Map<number | string, number>();

  // Pre-flight abort check: if the caller's signal is already aborted, we
  // must not issue the provider request at all. Providers that do not
  // themselves honor `signal` would otherwise emit a network call that the
  // caller has explicitly cancelled.
  if (options?.signal?.aborted) {
    throwAbortError();
  }

  // Deferred tools are executable client-side but must not appear in the
  // request's top-level `tools[]` (their schemas travel via message-level
  // `tools` declarations; the top-level list stays byte-stable for prompt
  // caching). This is the single strip point for every provider call.
  const wireTools = tools.some((tool) => tool.deferred === true)
    ? tools.filter((tool) => tool.deferred !== true)
    : tools;

  // Defensive wire layer: guarantee message-internal wire legality (parseable
  // tool-call arguments, non-empty tool names, paired tool exchanges) before
  // any provider converter can hard-throw on malformed history. Healthy
  // history is returned as the same reference at zero cost.
  const wireHistory = normalizeMessagesForWire(history, {
    onRepair: options?.onNormalizeRepair,
  });

  options?.onRequestStart?.();
  const stream = await provider.generate(systemPrompt, wireTools, wireHistory, options);
  // Early capture: the trace id arrives with the response headers, before the
  // stream body — and before any mid-stream abort — so hosts can attribute
  // even a cancelled stream to its server-side request.
  if (stream.traceId !== undefined) {
    options?.onTraceId?.(stream.traceId);
  }

  // Post-await abort check: `provider.generate()` may have resolved before
  // noticing a mid-flight abort. Reject immediately rather than draining
  // the stream.
  await throwIfAborted(options?.signal, stream);

  // Decode-phase accounting. We split the window from the first streamed part
  // to stream end into time spent awaiting the next part (server + network) vs.
  // time spent processing each part in-process (deep copy, host callback, part
  // merge). `lastResumeAt` marks the end of the previous part's processing, so
  // the gap until the next part arrives is attributed to the server. The
  // per-part processing is wrapped in try/finally so the accounting stays
  // correct across `continue` and thrown aborts.
  let serverDecodeMs = 0;
  let clientConsumeMs = 0;
  let firstPartAt: number | undefined;
  let lastResumeAt = 0;

  for await (const part of stream) {
    const arrivedAt = Date.now();
    if (firstPartAt === undefined) {
      firstPartAt = arrivedAt;
    } else {
      serverDecodeMs += arrivedAt - lastResumeAt;
    }

    try {
      await throwIfAborted(options?.signal, stream);

      // Notify raw part callback (deep copy to avoid aliasing mutations).
      if (callbacks?.onMessagePart !== undefined) {
        await callbacks.onMessagePart(deepCopyPart(part));
        await throwIfAborted(options?.signal, stream);
      }

      // Index-based routing for parallel tool call argument deltas.
      // When a ToolCallPart arrives with an index referring to a tool call
      // that is NOT the currently-pending one, append it directly to the
      // correct ToolCall in message.toolCalls instead of relying on sequential
      // merging. This prevents argument cross-contamination across parallel calls.
      if (
        isToolCallPart(part) &&
        part.index !== undefined &&
        !isPendingToolCallAtIndex(pendingPart, part.index)
      ) {
        const arrayIdx = toolCallIndexMap.get(part.index);
        if (arrayIdx !== undefined) {
          const target = message.toolCalls[arrayIdx];
          if (target !== undefined && part.argumentsPart !== null) {
            target.arguments =
              target.arguments === null
                ? part.argumentsPart
                : target.arguments + part.argumentsPart;
          }
          continue;
        }
        // Unknown index — fall through to the sequential logic as a safety net.
      }

      if (pendingPart === null) {
        pendingPart = part;
      } else if (!mergeInPlace(pendingPart, part)) {
        // Could not merge — flush the pending part and start a new one.
        // For parallel tool calls this happens when a new ToolCall header arrives
        // while a previous ToolCall is still pending; the flush finalizes the
        // previous tool call into `message.toolCalls`.
        flushPart(message, pendingPart, toolCallIndexMap);
        if (isToolCall(pendingPart) && callbacks?.onToolCallReady !== undefined) {
          // The merge boundary proves this call's arguments are complete (the
          // stream moved on to a new part). Report a snapshot so hosts can
          // start executing while the model keeps streaming. The final pending
          // call is NOT reported here — see onToolCallReady's contract.
          await callbacks.onToolCallReady(snapshotFlushedToolCall(pendingPart));
        }
        pendingPart = part;
      }
    } finally {
      lastResumeAt = Date.now();
      clientConsumeMs += lastResumeAt - arrivedAt;
    }
  }

  await throwIfAborted(options?.signal, stream);
  if (firstPartAt !== undefined) {
    // Tail wait: from the last processed part to the stream's done signal.
    serverDecodeMs += Date.now() - lastResumeAt;
  }
  options?.onStreamEnd?.(
    firstPartAt === undefined ? undefined : { serverDecodeMs, clientConsumeMs },
  );

  // Flush the last pending part.
  if (pendingPart !== null) {
    flushPart(message, pendingPart, toolCallIndexMap);
  }
  if (message.content.length === 0 && message.toolCalls.length === 0) {
    throw new APIEmptyResponseError(
      'The API returned an empty response (no content, no tool calls).' +
        formatFinishReasonHint(stream) +
        ` Provider: ${provider.name}, model: ${provider.modelName}`,
      {
        finishReason: stream.finishReason,
        rawFinishReason: stream.rawFinishReason,
      },
    );
  }

  // Think-only response (no real text, no tool calls) is treated as incomplete.
  const hasThink = message.content.some((p) => p.type === 'think');
  const hasText = message.content.some((p) => p.type === 'text' && p.text.trim().length > 0);
  const hasToolCalls = message.toolCalls.length > 0;

  if (hasThink && !hasText && !hasToolCalls) {
    throw new APIEmptyResponseError(
      'The API returned a response containing only thinking content ' +
        'without any text or tool calls. This usually indicates the ' +
        'stream was interrupted or the output token budget was exhausted ' +
        'during reasoning.' +
        formatFinishReasonHint(stream) +
        ` Provider: ${provider.name}, model: ${provider.modelName}`,
      {
        finishReason: stream.finishReason,
        rawFinishReason: stream.rawFinishReason,
      },
    );
  }

  // Fire onToolCall for every fully-assembled tool call, in final order.
  if (callbacks?.onToolCall !== undefined) {
    for (const toolCall of message.toolCalls) {
      await throwIfAborted(options?.signal, stream);
      await callbacks.onToolCall(toolCall);
    }
  }

  const result: GenerateResult = {
    id: stream.id,
    message,
    usage: stream.usage,
    finishReason: stream.finishReason,
    rawFinishReason: stream.rawFinishReason,
  };
  const extras: { traceId?: string | null; rateLimit?: RateLimitSnapshot | null } = {};
  if (stream.traceId !== undefined) {
    extras.traceId = stream.traceId;
  }
  if (stream.rateLimit !== undefined) {
    extras.rateLimit = stream.rateLimit;
  }
  return { ...result, ...extras };
}

type CancelableStream = StreamedMessage & {
  cancel?: () => unknown;
  return?: () => unknown;
};

function throwAbortError(): never {
  throw new DOMException('The operation was aborted.', 'AbortError');
}

async function cancelStream(stream: StreamedMessage): Promise<void> {
  const cancelable = stream as CancelableStream;

  try {
    await cancelable.cancel?.();
  } catch {}

  try {
    await cancelable.return?.();
  } catch {}
}

async function throwIfAborted(signal?: AbortSignal, stream?: StreamedMessage): Promise<void> {
  if (!signal?.aborted) {
    return;
  }

  if (stream !== undefined) {
    await cancelStream(stream);
  }

  throwAbortError();
}

/** True when `pending` is a ToolCall whose _streamIndex equals `index`. */
function isPendingToolCallAtIndex(
  pending: StreamedMessagePart | null,
  index: number | string,
): pending is ToolCall {
  return pending !== null && isToolCall(pending) && pending._streamIndex === index;
}

/**
 * Append a fully-merged part to the message.
 *
 * - ContentPart -> message.content
 * - ToolCall    -> message.toolCalls (the `_streamIndex` routing key is
 *                  registered in the map and stripped before storage).
 * - ToolCallPart -> ignored (orphaned delta without a matching pending call)
 */
function flushPart(
  message: Message,
  part: StreamedMessagePart,
  toolCallIndexMap: Map<number | string, number>,
): void {
  if (isContentPart(part)) {
    message.content.push(part);
    return;
  }
  if (isToolCall(part)) {
    const streamIndex = part._streamIndex;
    const stored: StoredToolCall = {
      type: 'function',
      id: part.id,
      name: part.name,
      arguments: part.arguments,
      extras: part.extras,
    };
    const ordinal = message.toolCalls.length;
    message.toolCalls.push(stored as ToolCall);
    if (streamIndex !== undefined) {
      toolCallIndexMap.set(streamIndex, ordinal);
    }
  }
  // ToolCallPart: orphaned delta — silently ignore.
}

/**
 * Snapshot a ToolCall at its mid-stream completion boundary for
 * `onToolCallReady`, in the same stored shape {@link flushPart} produces
 * (without the internal `_streamIndex` routing field). `extras` is cloned so
 * later stream processing cannot alias-mutate the snapshot.
 */
function snapshotFlushedToolCall(part: ToolCall): ToolCall {
  const stored: StoredToolCall = {
    type: 'function',
    id: part.id,
    name: part.name,
    arguments: part.arguments,
    ...(part.extras !== undefined ? { extras: structuredClone(part.extras) } : {}),
  };
  return stored as ToolCall;
}

function formatFinishReasonHint(stream: StreamedMessage): string {
  if (stream.finishReason === null && stream.rawFinishReason === null) return '';

  const raw =
    stream.rawFinishReason === null ? '' : `, rawFinishReason=${stream.rawFinishReason}`;
  const filteredHint =
    stream.finishReason === 'filtered'
      ? ' The provider filtered the response before visible output was emitted.'
      : '';

  return ` Provider stop details: finishReason=${stream.finishReason ?? 'unknown'}${raw}.${filteredHint}`;
}

/**
 * Produce an isolating copy of a StreamedMessagePart for the raw-part
 * callback, so later in-place merges (`mergeInPlace`, argument routing)
 * cannot alias-mutate what the host already saw.
 *
 * `text`, `think`, `tool_call_part`, and `function` parts without `extras`
 * own only primitive fields (strings/numbers, which are immutable), so a
 * shallow spread is observably identical to `structuredClone` for them.
 * `function` parts with `extras` and the media parts
 * (`image_url`/`audio_url`/`video_url`) own nested objects and keep the
 * deep clone.
 */
function deepCopyPart(part: StreamedMessagePart): StreamedMessagePart {
  switch (part.type) {
    case 'text':
    case 'think':
    case 'tool_call_part':
      return { ...part };
    case 'function':
      return part.extras === undefined ? { ...part } : structuredClone(part);
    case 'image_url':
    case 'audio_url':
    case 'video_url':
      return structuredClone(part);
  }
}
