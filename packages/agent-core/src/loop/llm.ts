/**
 * LLM contract for the model capability used by the stateless loop.
 *
 * The immutable `LLM` object owns provider/model metadata, capability metadata,
 * and the system prompt. Other host concerns are injected through separate
 * surfaces.
 */

import type {
  FinishReason,
  Message,
  ModelCapability,
  RateLimitSnapshot,
  TextPart,
  ThinkPart,
  TokenUsage,
  Tool,
  ToolCall,
} from '@cloud-code/kosong';

export interface ToolCallDelta {
  readonly toolCallId: string;
  readonly name?: string | undefined;
  readonly argumentsPart?: string | undefined;
}

/**
 * LLM request source classification (C1 P2, the querySource counterpart).
 *
 * FOREGROUND sources (`loop`, `compaction`) retry through `chatWithRetry`:
 * the user is waiting on them, and rate-limit waits are bounded by the
 * foreground gates before the turn parks into an auto-resume pause.
 * BACKGROUND sources (`guardian`, `title`) must NOT retry: during a capacity
 * crunch every background retry is gateway amplification for a failure the
 * user never sees — they fail fast and fail open instead.
 */
export type LLMRequestKind = 'loop' | 'compaction' | 'guardian' | 'title';

/**
 * Whether a request source is foreground (retry-eligible). An absent kind is
 * a regular loop step — foreground. Any kind not explicitly listed here —
 * including kinds added in the future — defaults to BACKGROUND, so a new
 * background call site can never accidentally wire into `chatWithRetry`;
 * making it retry requires a deliberate opt-in here.
 */
export function isForegroundRequestKind(kind: LLMRequestKind | undefined): boolean {
  return kind === undefined || kind === 'loop' || kind === 'compaction';
}

/**
 * Request-scoped side channel from the host layers (loop, LLM adapter,
 * compaction) down to the `Agent.generate` choke point, consumed there by the
 * diagnostic logger and the wire-record request trace.
 */
export interface LLMRequestLogFields {
  readonly turnStep?: string;
  readonly attempt?: string;
  /**
   * Request purpose; absent means a regular loop step.
   *
   * Source classification contract (C1 P2, querySource): `loop`/`compaction`
   * are FOREGROUND sources — their failures surface to the user, so they ride
   * `chatWithRetry` with the foreground wait gates. `guardian`/`title` are
   * BACKGROUND sources — the user never sees them, so they must fail fast and
   * fail open WITHOUT `chatWithRetry` (title catches to null, guardian fails
   * open; see `isForegroundRequestKind`).
   */
  readonly kind?: LLMRequestKind;
  /** Set when the messages are a fallback resend projection: the strict
   * wire-compliant rebuild, the media-degraded rebuild after a
   * request-too-large rejection, or the media-stripped rebuild after an
   * image-format rejection / a second request-too-large rejection. */
  readonly projection?: 'strict' | 'media-degraded' | 'media-stripped';
  /** Compaction only: messages dropped so far by overflow/empty shrinking. */
  readonly droppedCount?: number;
}

export interface LLMStreamTiming {
  readonly firstTokenLatencyMs: number;
  readonly streamDurationMs: number;
  /**
   * Portion of `firstTokenLatencyMs` spent in-process building the request
   * (message serialization, param assembly) before the provider dispatched the
   * network call. `undefined` when the provider does not report the
   * client/server boundary (no `onRequestSent`).
   */
  readonly requestBuildMs?: number;
  /**
   * Portion of `firstTokenLatencyMs` spent waiting on the network + API server
   * from request dispatch to the first streamed token. `undefined` when the
   * provider does not report the client/server boundary.
   */
  readonly serverFirstTokenMs?: number;
  /**
   * Split of `streamDurationMs` (the decode window): time spent awaiting parts
   * from the provider (`serverDecodeMs`, server + network) vs. time spent
   * processing parts in-process (`clientConsumeMs`, host callbacks / merge).
   * `undefined` when the provider stream did not report decode accounting.
   */
  readonly serverDecodeMs?: number;
  readonly clientConsumeMs?: number;
}

export interface LLMRequestTrace {
  readonly traceId: string | undefined;
}

export class LLMRequestTraceState implements LLMRequestTrace {
  traceId: string | undefined;

  reset(): void {
    this.traceId = undefined;
  }

  capture(traceId: string | null | undefined): void {
    this.traceId = traceId ?? undefined;
  }
}

export interface LLMChatParams {
  messages: Message[];
  tools: readonly Tool[];
  signal: AbortSignal;
  requestLogFields?: LLMRequestLogFields;
  onTextDelta?: ((delta: string) => void) | undefined;
  onThinkDelta?: ((delta: string) => void) | undefined;
  onToolCallDelta?: ((delta: ToolCallDelta) => void) | undefined;
  /**
   * Fires once per tool call whose arguments are provably complete while the
   * stream is still running (a later stream part closed it). The final call
   * of a stream never fires here — it is only known complete once the stream
   * ends — so it always flows through the post-stream batch path. Used by
   * streaming tool execution; started calls are still recorded in provider
   * order after the response completes.
   */
  onToolCallReady?: ((toolCall: ToolCall) => void | Promise<void>) | undefined;
  /**
   * Fires once per completed text block. Additive relative to
   * `onTextDelta` — deltas still fire chunk-by-chunk for UI streaming.
   * Returned promises are awaited by the adapter to preserve transcript append
   * order. Durable transcript writes receive completed blocks only.
   */
  onTextPart?: ((part: TextPart) => Promise<void> | void) | undefined;
  /**
   * Fires once per completed thinking block. Additive relative to
   * `onThinkDelta` — deltas still fire chunk-by-chunk for UI streaming.
   * Returned promises are awaited by the adapter to preserve transcript append
   * order. Durable transcript writes receive completed blocks only.
   */
  onThinkPart?: ((part: ThinkPart) => Promise<void> | void) | undefined;
  trace?: LLMRequestTraceState;
  /**
   * Fires when a FAILED attempt's error carried an account rate-limit
   * snapshot (ChatGPT Codex `x-codex-*` headers, attached to the kosong
   * `APIStatusError` by the provider error converter). The retry loop fires
   * it per failed attempt, so the host's quota view refreshes while riding
   * out a 429 backoff — not only after the next successful response (the
   * success path reports via `LLMChatResponse.rateLimit`).
   */
  onRateLimit?: ((snapshot: RateLimitSnapshot) => void) | undefined;
}

export interface LLMChatResponse {
  toolCalls: ToolCall[];
  providerFinishReason?: FinishReason;
  rawFinishReason?: string;
  messageId?: string;
  usage: TokenUsage;
  streamTiming?: LLMStreamTiming;
  /** Provider trace identifier from the `x-trace-id` response header (Kimi/KFC only). */
  traceId?: string;
  /**
   * Account rate-limit snapshot from the provider's response headers
   * (ChatGPT Codex `x-codex-*` family only), captured with this response.
   */
  rateLimit?: RateLimitSnapshot;
}

export interface LLM {
  readonly systemPrompt: string;
  readonly modelName: string;
  readonly capability?: ModelCapability | undefined;
  isRetryableError?(error: unknown): boolean;
  chat(params: LLMChatParams): Promise<LLMChatResponse>;
}
