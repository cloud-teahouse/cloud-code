import type { FinishReason } from './provider';
import type { RateLimitSnapshot } from './rate-limit';

/**
 * Base error for all chat provider errors.
 */
export class ChatProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChatProviderError';
  }
}

/**
 * Network-level connection failure.
 */
export class APIConnectionError extends ChatProviderError {
  constructor(message: string) {
    super(message);
    this.name = 'APIConnectionError';
  }
}

/**
 * Request timed out.
 */
export class APITimeoutError extends ChatProviderError {
  constructor(message: string) {
    super(message);
    this.name = 'APITimeoutError';
  }
}

/**
 * HTTP status error from the API.
 */
export class APIStatusError extends ChatProviderError {
  readonly statusCode: number;
  readonly requestId: string | null;
  /**
   * Server-requested backoff from the `retry-after` response header, in
   * milliseconds. When present, the retry loop honors it instead of its own
   * computed backoff — a server `Retry-After` directive overrides the local
   * exponential delay.
   */
  readonly retryAfterMs: number | null;
  /**
   * Provider trace identifier from the `x-trace-id` response header
   * (Kimi/KFC only), or `null` when the error response did not carry one.
   * A failed request usually still returns response headers, so hosts can
   * attribute the failure to its server-side request.
   */
  readonly traceId: string | null;
  /**
   * Account rate-limit snapshot parsed from the error response's
   * `x-codex-*` headers (ChatGPT Codex backend only). A failed response —
   * 429 above all — carries the same quota header family as a successful
   * one, so the provider error converter attaches the parsed snapshot here.
   * `undefined`/`null` when the error response sent none (non-Codex
   * backends). Writable because the converter sets it only after
   * `normalizeAPIStatusError` has picked the concrete subclass.
   */
  rateLimit?: RateLimitSnapshot | null;

  constructor(
    statusCode: number,
    message: string,
    requestId?: string | null,
    retryAfterMs?: number | null,
    traceId?: string | null,
  ) {
    super(message);
    this.name = 'APIStatusError';
    this.statusCode = statusCode;
    this.requestId = requestId ?? null;
    this.retryAfterMs = retryAfterMs ?? null;
    this.traceId = traceId ?? null;
  }
}

/**
 * HTTP status error that specifically means the request exceeded the model
 * context window.
 */
export class APIContextOverflowError extends APIStatusError {
  /**
   * Prompt token count parsed from the provider's overflow message, when the
   * wording carried one (see PROMPT_TOO_LONG_TOKEN_PATTERNS). `undefined`
   * when the message had no recognizable numbers — purely informational, so a
   * recovery path can size its drain precisely instead of falling back to a
   * local estimate.
   */
  readonly promptTokens?: number;
  /**
   * Context-window limit parsed from the same message, `undefined` under the
   * same conditions as `promptTokens`. The overflow gap is
   * `promptTokens - limitTokens`.
   */
  readonly limitTokens?: number;

  constructor(
    statusCode: number,
    message: string,
    requestId?: string | null,
    retryAfterMs?: number | null,
    traceId?: string | null,
    promptTokens?: number,
    limitTokens?: number,
  ) {
    super(statusCode, message, requestId, retryAfterMs, traceId);
    this.name = 'APIContextOverflowError';
    this.promptTokens = promptTokens;
    this.limitTokens = limitTokens;
  }
}

/**
 * HTTP 413 that specifically means the serialized request body exceeded the
 * provider's byte ceiling (e.g. accumulated base64 images), as opposed to a
 * token-count overflow. Token overflow is recoverable by compaction; a body
 * size rejection is not — it needs media to be dropped or shrunk.
 */
export class APIRequestTooLargeError extends APIStatusError {
  constructor(
    statusCode: number,
    message: string,
    requestId?: string | null,
    retryAfterMs?: number | null,
    traceId?: string | null,
  ) {
    super(statusCode, message, requestId, retryAfterMs, traceId);
    this.name = 'APIRequestTooLargeError';
  }
}

/**
 * HTTP status error that specifically means the provider rate-limited the
 * request.
 */
export class APIProviderRateLimitError extends APIStatusError {
  constructor(
    message: string,
    requestId?: string | null,
    retryAfterMs?: number | null,
    traceId?: string | null,
  ) {
    super(429, message, requestId, retryAfterMs, traceId);
    this.name = 'APIProviderRateLimitError';
  }
}

/**
 * HTTP 429 that specifically means the account's plan quota is exhausted
 * (the ChatGPT Codex backend's `error.type: "usage_limit_reached"`), as
 * opposed to a transient rate limit. Retrying cannot succeed until the
 * usage window resets, so this error is terminal: it stays 429-shaped
 * (extends APIProviderRateLimitError, so structural rate-limit checks keep
 * working) but is excluded from the retry budget in
 * {@link isRetryableGenerateError}.
 */
export class APIQuotaExceededError extends APIProviderRateLimitError {
  /**
   * ChatGPT plan type from the error body's `plan_type` (e.g. `"pro"`), or
   * the rate-limit snapshot's plan type as a fallback. `null` when neither
   * carried one (e.g. the mid-stream SSE variant of this error).
   */
  readonly planType: string | null;
  /**
   * Epoch milliseconds at which the exhausted usage window resets — from
   * the error body's `resets_at`, falling back to the exhausted window's
   * `reset-at` header in the attached snapshot. `null` when unknown.
   */
  readonly resetsAtMs: number | null;
  /**
   * Label of the exhausted usage window (`'5h'`, `'daily'`, `'weekly'`, …)
   * derived from the snapshot's window minutes, or `null` when no snapshot
   * identified the window.
   */
  readonly quotaWindow: string | null;

  constructor(
    message: string,
    options: {
      readonly requestId?: string | null;
      readonly retryAfterMs?: number | null;
      readonly traceId?: string | null;
      readonly planType?: string | null;
      readonly resetsAtMs?: number | null;
      readonly quotaWindow?: string | null;
    } = {},
  ) {
    super(message, options.requestId, options.retryAfterMs, options.traceId);
    this.name = 'APIQuotaExceededError';
    this.planType = options.planType ?? null;
    this.resetsAtMs = options.resetsAtMs ?? null;
    this.quotaWindow = options.quotaWindow ?? null;
  }
}

/**
 * HTTP 429 that specifically means the account's quota or balance is
 * exhausted, as opposed to a transient rate limit. Deliberately NOT a
 * subclass of `APIProviderRateLimitError`: a rate limit clears on its own
 * (retry/requeue helps), while quota exhaustion is deterministic until the
 * account is recharged — so this class is excluded from retry and from the
 * rate-limit requeue/suspend paths.
 *
 * Observed shapes: Moonshot returns `error.type =
 * "exceeded_current_quota_error"` with wording that varies by account state
 * ("You exceeded your current token quota: ... please check your account
 * balance" vs "Your account ... is suspended due to insufficient balance,
 * please recharge your account ..."); OpenAI uses `insufficient_quota` as
 * both `error.type` and `error.code`.
 */
export class APIProviderQuotaExhaustedError extends APIStatusError {
  constructor(
    message: string,
    requestId?: string | null,
    retryAfterMs?: number | null,
    traceId?: string | null,
  ) {
    super(429, message, requestId, retryAfterMs, traceId);
    this.name = 'APIProviderQuotaExhaustedError';
  }
}

/**
 * The API returned an empty response (no content, no tool calls).
 */
export class APIEmptyResponseError extends ChatProviderError {
  readonly finishReason: FinishReason | null;
  readonly rawFinishReason: string | null;

  constructor(
    message: string,
    options: {
      readonly finishReason?: FinishReason | null;
      readonly rawFinishReason?: string | null;
    } = {},
  ) {
    super(message);
    this.name = 'APIEmptyResponseError';
    this.finishReason = options.finishReason ?? null;
    this.rawFinishReason = options.rawFinishReason ?? null;
  }
}

/**
 * The single standard abort shape for the wire layer: a DOMException named
 * `'AbortError'`, matching the platform's own `AbortSignal.reason`
 * convention. Every user-cancellation path — the `generate()` driver,
 * provider error converters, stream wrappers — throws exactly this shape so
 * upstream code can recognize cancellation without SDK knowledge.
 */
export function createAbortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError');
}

/**
 * Whether `error` is any abort shape that can surface from a provider call:
 *
 *  - the standard abort DOMException (`createAbortError`, `signal.reason`),
 *  - a bare `Error` named `'AbortError'` (generic abort helpers), or
 *  - an SDK user-abort (`APIUserAbortError` in both the OpenAI and Anthropic
 *    SDKs) — recognized structurally by constructor name so this module
 *    stays SDK-free.
 */
export function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === 'AbortError') return true;
  if (error instanceof Error && error.name === 'AbortError') return true;
  return (
    typeof error === 'object' &&
    error !== null &&
    error.constructor?.name === 'APIUserAbortError'
  );
}

/**
 * The abort guard for provider error converters. Must run at the very front
 * of every error classification chain: when `error` is abort-shaped this
 * THROWS the standard abort DOMException — it never returns a converted
 * error — so a user cancellation can never be misclassified as a retryable
 * provider failure. Does nothing for non-abort errors.
 */
export function throwIfAbortError(error: unknown): void {
  if (isAbortError(error)) {
    throw createAbortError();
  }
}

export function isRetryableGenerateError(error: unknown): boolean {
  // Quota exhaustion is terminal: every retry hits the same exhausted usage
  // window until it resets, so fail on first sight instead of burning the
  // retry budget. Checked before the APIStatusError branch, which would
  // otherwise treat its inherited 429 status as a transient rate limit.
  if (error instanceof APIQuotaExceededError) {
    return false;
  }
  if (error instanceof APIConnectionError || error instanceof APITimeoutError) {
    return true;
  }
  if (error instanceof APIEmptyResponseError) {
    return true;
  }
  if (error instanceof APIStatusError) {
    // A bare 400 with no response body is almost always an edge/gateway blip
    // (e.g. Cloudflare returning an empty 400); real request rejections from
    // these backends carry a JSON error body, so a no-body 400 is transient
    // and worth retrying. Real 4xx (with bodies) keep failing fast below.
    if (error.statusCode === 400 && /\bno body\b/i.test(error.message)) {
      return true;
    }
    // Quota/balance exhaustion is a 429 but deterministic until the account
    // is recharged — retrying can never succeed, so it fails fast instead of
    // burning the whole retry budget (~2-3 minutes of backoff).
    if (error instanceof APIProviderQuotaExhaustedError) {
      return false;
    }
    // Transient statuses worth retrying: 408 (request timeout), 409
    // (lock/conflict timeout), 429 (rate limit), 5xx (server errors) and 529
    // (provider overloaded — the "engine is currently overloaded" case).
    return [408, 409, 429, 500, 502, 503, 504, 529].includes(error.statusCode);
  }
  // Fallback safety net: an unclassified provider failure — typically an
  // upstream gateway that forwards the original error only as text, with no
  // usable HTTP status (e.g. llmproxy embedding `status_code=429` in the
  // message) — lands here as a base `ChatProviderError`. Retrying beats
  // failing the run on the first transient blip. Typed `APIStatusError`
  // instances are deliberately excluded above: deterministic 4xx
  // (400/401/403/404/422) and the recovery-owned context-overflow /
  // request-too-large subclasses keep their dedicated handling instead of
  // burning retries first. Image-format rejections are likewise excluded:
  // they are deterministic per history and recovered by the media-stripped
  // resend (see isImageFormatError), so retrying the identical request first
  // would only burn the retry budget. Client-side video format rejections
  // (see isVideoFormatError) are deterministic the same way and have no
  // resend recovery at all — retrying them only re-logs the payload.
  return (
    error instanceof ChatProviderError && !isImageFormatError(error) && !isVideoFormatError(error)
  );
}

// Client-side image rejections thrown before the request is sent (kosong's
// own media whitelist in the Anthropic adapter).
const IMAGE_FORMAT_PROVIDER_MESSAGE_PATTERNS = [
  /unsupported media type for base64 image/,
  /invalid data url for image/,
] as const;

// Client-side video rejections thrown before the request is sent (kosong's
// own media whitelist in the Anthropic adapter).
const VIDEO_FORMAT_PROVIDER_MESSAGE_PATTERNS = [
  /unsupported media type for base64 video/,
  /invalid data url for video/,
] as const;

// Server-side image rejections that are safe to recover by stripping media:
// an unsupported/invalid media type or undecodable image data. These are
// deliberately narrow and grounded in the documented messages of the major
// providers (Anthropic, OpenAI, Moonshot/Kimi, Gemini) — image COUNT/SIZE
// limits or image-input-disabled errors also mention "image", but stripping
// media either over-recovers or hides a real configuration problem the user
// should see; only format/data rejections are guaranteed to be fixed by
// removing the offending image.
//
// Matching on provider message text is inherently best-effort: these strings
// are not a stable contract, so a novel phrasing is missed and the error
// propagates (the pre-recovery behavior). The entry-point format gate is the
// structural defense; this recovery only backstops the residue.
// Every pattern mentions "image" literally, and MEDIA_TYPE_FIELD_PATTERN is
// separately gated on an "image" anchor — so audio/video media rejections
// ("unsupported media type", "invalid media type") can never be classified
// as image errors here. All documented provider image rejections mention
// "image", so the restriction costs no known match.
const IMAGE_FORMAT_STATUS_MESSAGE_PATTERNS = [
  // Unsupported format — OpenAI / Moonshot "unsupported image …".
  /unsupported image (?:url|format|type)/,
  // Undecodable / corrupt image data.
  /does not represent a valid image/,
  /could not (?:process|decode) (?:the |input )?image/,
  /unable to process (?:the |input )?image/,
  /failed to decode (?:the )?image/,
  /invalid image(?: data| type| format)?/,
] as const;

// Anthropic `media_type` & Gemini `mime_type` enum violations name the field
// — recoverable only when the message is about an IMAGE. A video/audio
// `media_type` rejection must surface instead of being blindly
// media-stripped: unlike images there is no conversion-guidance path for
// video today, so dropping the user's video silently would hide the real
// error. Every documented image media_type message also mentions "image",
// so the anchor costs nothing on the known cases.
const MEDIA_TYPE_FIELD_PATTERN = /(?:media|mime)_?type/;

/**
 * Whether the provider rejected an IMAGE in the request because of its
 * FORMAT or DATA — an unsupported media type or undecodable image bytes.
 * The rejection is deterministic for a given history (the same image is
 * re-sent on every request, so the session would fail every turn), and the
 * only recovery is to resend once with all media stripped (see the
 * media-stripped resend in the agent loop). Body-size (413), context
 * overflow, image count/size limits, image-input-disabled rejections, and
 * non-image (audio/video) media rejections are excluded — the first two
 * have their own recoveries, and the rest are not fixed by stripping media.
 */
export function isImageFormatError(error: unknown): boolean {
  if (error instanceof APIStatusError) {
    if (error instanceof APIContextOverflowError) return false;
    if (error instanceof APIRequestTooLargeError) return false;
    if (error.statusCode !== 400) return false;
    const lowerMessage = error.message.toLowerCase();
    return (
      IMAGE_FORMAT_STATUS_MESSAGE_PATTERNS.some((pattern) => pattern.test(lowerMessage)) ||
      (MEDIA_TYPE_FIELD_PATTERN.test(lowerMessage) && lowerMessage.includes('image'))
    );
  }
  if (error instanceof ChatProviderError) {
    const lowerMessage = error.message.toLowerCase();
    return IMAGE_FORMAT_PROVIDER_MESSAGE_PATTERNS.some((pattern) => pattern.test(lowerMessage));
  }
  return false;
}

/**
 * Whether kosong itself rejected a VIDEO data URL before the request was
 * sent (the Anthropic adapter's base64 media whitelist). Like an image
 * format rejection this is deterministic for a given history — the same
 * bytes fail on every retry — but unlike images there is deliberately no
 * media-strip recovery for video (see the MEDIA_TYPE_FIELD_PATTERN note
 * above), so the predicate only drives the retry exclusion in
 * {@link isRetryableGenerateError}. Server-side status errors are excluded:
 * they keep their own 4xx handling.
 */
export function isVideoFormatError(error: unknown): boolean {
  if (error instanceof APIStatusError) return false;
  if (error instanceof ChatProviderError) {
    const lowerMessage = error.message.toLowerCase();
    return VIDEO_FORMAT_PROVIDER_MESSAGE_PATTERNS.some((pattern) => pattern.test(lowerMessage));
  }
  return false;
}

// `terminated` is the undici signature for an SSE/HTTP body stream that is
// dropped mid-flight (common with Node's native fetch on long reasoning
// streams). It surfaces as a raw `TypeError: terminated`, so it must be
// recognized here as a transport-layer connection failure. Shared by the
// Anthropic and OpenAI providers so a raw, non-SDK transport error classifies
// the same way regardless of which provider was streaming.
const NETWORK_RE = /network|connection|connect|disconnect|terminated/i;
const TIMEOUT_RE = /timed?\s*out|timeout|deadline/i;

/**
 * Classify a raw (non-SDK) error message into the right transport-layer
 * `ChatProviderError` subclass: a timeout becomes a retryable `APITimeoutError`,
 * a dropped connection / undici `terminated` becomes a retryable
 * `APIConnectionError`, and anything else stays a non-retryable base
 * `ChatProviderError`. Timeout is checked first so "connection timed out"
 * classifies as a timeout rather than a bare connection error.
 */
export function classifyBaseApiError(message: string): ChatProviderError {
  if (TIMEOUT_RE.test(message)) {
    return new APITimeoutError(message);
  }
  if (NETWORK_RE.test(message)) {
    return new APIConnectionError(message);
  }
  return new ChatProviderError(`Error: ${message}`);
}

const CONTEXT_OVERFLOW_MESSAGE_PATTERNS = [
  /context[ _-]?length/,
  /(?:context[ _-]?window.*exceed|exceed.*context[ _-]?window)/,
  /maximum context/,
  /exceed(?:ed|s|ing)?\s+(?:the\s+)?max(?:imum)?\s+tokens?/,
  /(?:too many tokens.*(?:prompt|input|context)|(?:prompt|input|context).*too many tokens)/,
  /prompt is too long.*maximum/,
  /input token count.*exceeds?.*maximum number of tokens/,
  /request.*exceed(?:ed|s|ing)?.*model token limit/,
] as const;

// Best-effort extraction of the actual token counts from a prompt-too-long
// message. Each pattern uses named `promptTokens`/`limitTokens` groups so the
// attribution is explicit in the regex itself — the provider wordings put the
// numbers in OPPOSITE orders (Anthropic names the prompt count first, OpenAI
// the limit first), which positional groups would be easy to silently swap.
const PROMPT_TOO_LONG_TOKEN_PATTERNS = [
  // Anthropic: "prompt is too long: 210,000 tokens > 200,000 maximum" — the
  // prompt count is left of the ">", the limit right of it.
  /prompt is too long:\s*(?<promptTokens>[\d,]+)\s*tokens?\s*>\s*(?<limitTokens>[\d,]+)\s*maximum/i,
  // OpenAI and OpenAI-compatible backends: "This model's maximum context
  // length is 4,096 tokens. However, you requested 5,000 tokens ..." (some
  // backends phrase the second half as "your messages resulted in 5,000
  // tokens") — the LIMIT comes first here, the requested prompt count second.
  /maximum context length is\s*(?<limitTokens>[\d,]+)\s*tokens?[\s\S]*?(?:requested|resulted in)\s*(?<promptTokens>[\d,]+)/i,
] as const;

interface PromptTooLongTokenCounts {
  readonly promptTokens: number;
  readonly limitTokens: number;
}

// Thousands separators are common in these messages ("210,000 tokens").
function parseTokenCount(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number.parseInt(raw.replaceAll(',', ''), 10);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * Best-effort parse of the prompt/limit token counts out of a prompt-too-long
 * provider message. Returns `undefined` when no known wording matches —
 * matching on provider message text is not a stable contract, so a novel
 * phrasing simply yields no numbers and the caller leaves the gap fields
 * unset (the pre-parse behavior).
 */
function parsePromptTooLongTokenCounts(message: string): PromptTooLongTokenCounts | undefined {
  for (const pattern of PROMPT_TOO_LONG_TOKEN_PATTERNS) {
    const groups = pattern.exec(message)?.groups;
    const promptTokens = parseTokenCount(groups?.['promptTokens']);
    const limitTokens = parseTokenCount(groups?.['limitTokens']);
    if (promptTokens !== undefined && limitTokens !== undefined) {
      return { promptTokens, limitTokens };
    }
  }
  return undefined;
}

const PROVIDER_RATE_LIMIT_MESSAGE_PATTERNS = [
  /(?:apistatuserror.*429|429.*apistatuserror)/,
  /429.*too many requests/,
  /too many requests/,
  /provider\.rate_limit/,
  /reached .*max rpm/,
  /rate[ _-]?limit(?:ed)?/,
  /rate-limited/,
] as const;

// Wordings that mean the serialized request BODY was too big, matched against
// the lowercased message of a 413. Kept separate from the context-overflow
// patterns above: those describe token counts, these describe bytes. A 413
// whose message matches neither family stays a plain `APIStatusError` —
// Vertex phrases prompt-too-long as a 413, so the status alone is not proof
// of a body-size rejection.
const REQUEST_TOO_LARGE_MESSAGE_PATTERNS = [
  // Moonshot / Kimi: "Request exceeds the maximum size".
  /request exceeds the maximum size/,
  // Reverse proxies (nginx-style HTML body): "413 Request Entity Too Large".
  /request entity too large/,
  // Anthropic: error type `request_too_large`, message "Request exceeds the
  // maximum allowed number of bytes".
  /request_too_large/,
  /exceeds? the maximum allowed number of bytes/,
  // RFC 9110 reason phrase (both the pre-2022 and current names).
  /payload too large/,
  /content too large/,
  // Plain wordings: generic gateways say "request too large"; Go's
  // http.MaxBytesReader (common in Go proxies) says "request body too large".
  /request (?:body )?too large/,
] as const;

const THINKING_EFFORT_CONFIG_DOCS_URL =
  'https://github.com/cloud-teahouse/cloud-code#readme';

const THINKING_EFFORT_STATUS_MESSAGE_PATTERNS = [
  /reasoning[_ .-]?effort/,
  /thinking[_ .-]?effort/,
  /output_config[\s\S]*effort/,
  /unsupported[\s\S]*effort/,
  /invalid[\s\S]*effort/,
] as const;

function appendThinkingEffortConfigHint(statusCode: number, message: string): string {
  if (statusCode !== 400 && statusCode !== 422) return message;
  const lowerMessage = message.toLowerCase();
  if (!THINKING_EFFORT_STATUS_MESSAGE_PATTERNS.some((pattern) => pattern.test(lowerMessage))) {
    return message;
  }
  if (message.includes(THINKING_EFFORT_CONFIG_DOCS_URL)) return message;
  return `${message}

The provider rejected the configured thinking effort. Non-Kimi providers receive effort strings without client-side mapping; choose an effort supported by the selected model. For Kimi models, check support_efforts and default_effort. See ${THINKING_EFFORT_CONFIG_DOCS_URL}`;
}

export function isContextOverflowErrorCode(code: string | null | undefined): boolean {
  return code === 'context_length_exceeded';
}

export function normalizeAPIStatusError(
  statusCode: number,
  message: string,
  requestId?: string | null,
  retryAfterMs?: number | null,
  traceId?: string | null,
): APIStatusError {
  if (statusCode === 429) {
    return new APIProviderRateLimitError(message, requestId, retryAfterMs, traceId);
  }
  // Context overflow first: Vertex returns prompt-too-long as a 413, and a
  // token overflow must keep routing to compaction even on that status.
  if (isContextOverflowStatusError(statusCode, message)) {
    const tokenCounts = parsePromptTooLongTokenCounts(message);
    return new APIContextOverflowError(
      statusCode,
      message,
      requestId,
      retryAfterMs,
      traceId,
      tokenCounts?.promptTokens,
      tokenCounts?.limitTokens,
    );
  }
  if (isRequestTooLargeStatusError(statusCode, message)) {
    return new APIRequestTooLargeError(statusCode, message, requestId, retryAfterMs, traceId);
  }
  return new APIStatusError(
    statusCode,
    appendThinkingEffortConfigHint(statusCode, message),
    requestId,
    retryAfterMs,
    traceId,
  );
}

/**
 * Read a single response header from an unknown headers-like object (anything
 * exposing a `get(name)` method, e.g. the Fetch `Headers` the SDKs carry on
 * their errors). Returns `null` when the object is not headers-like or the
 * header is absent.
 */
function readResponseHeader(headers: unknown, name: string): string | null {
  return headers !== null &&
    typeof headers === 'object' &&
    typeof (headers as { get?: unknown }).get === 'function'
    ? (headers as { get(name: string): string | null }).get(name)
    : null;
}

/**
 * Parse the provider trace identifier from the `x-trace-id` response header
 * (Kimi/KFC only). Returns `null` when the header is absent or empty.
 */
export function parseTraceId(headers: unknown): string | null {
  const raw = readResponseHeader(headers, 'x-trace-id');
  if (raw === null || raw === undefined || raw.length === 0) return null;
  return raw;
}

/**
 * Parse the server-requested backoff from the response headers into
 * milliseconds. Three directives are honored:
 *
 *  - `retry-after`: integer seconds (the standard form), or an HTTP-date —
 *    honored only when it parses to a FUTURE timestamp, since a past date
 *    asks for no wait at all.
 *  - `retry-after-ms`: a non-standard millisecond count emitted by some
 *    gateways. It takes precedence over `retry-after` when it asks for a
 *    LONGER wait than the seconds value — the more conservative directive
 *    wins — and applies on its own when `retry-after` is absent or
 *    unparseable.
 *
 * A missing or unparseable value returns null and the caller falls back to
 * its computed backoff. Shared by the provider error converters so every
 * backend honors the same server backoff directive.
 */
export function parseRetryAfterMs(headers: unknown): number | null {
  const retryAfterMsRaw = readResponseHeader(headers, 'retry-after-ms');
  const retryAfterMsValue = retryAfterMsRaw === null ? Number.NaN : Number.parseFloat(retryAfterMsRaw);
  const hasRetryAfterMs = Number.isFinite(retryAfterMsValue) && retryAfterMsValue >= 0;

  const retryAfterRaw = readResponseHeader(headers, 'retry-after');
  if (retryAfterRaw !== null && retryAfterRaw !== undefined) {
    const seconds = Number.parseInt(retryAfterRaw, 10);
    if (Number.isFinite(seconds) && seconds >= 0) {
      const secondsMs = seconds * 1000;
      return hasRetryAfterMs && retryAfterMsValue > secondsMs ? retryAfterMsValue : secondsMs;
    }
    // HTTP-date form (RFC 9110): only a future date is a backoff directive.
    if (!hasRetryAfterMs) {
      const dateMs = Date.parse(retryAfterRaw);
      if (Number.isFinite(dateMs) && dateMs > Date.now()) {
        return dateMs - Date.now();
      }
    }
  }
  return hasRetryAfterMs ? retryAfterMsValue : null;
}

export function isContextOverflowStatusError(statusCode: number, message: string): boolean {
  if (statusCode !== 400 && statusCode !== 413 && statusCode !== 422) return false;
  const lowerMessage = message.toLowerCase();
  return CONTEXT_OVERFLOW_MESSAGE_PATTERNS.some((pattern) => pattern.test(lowerMessage));
}

export function isRequestTooLargeStatusError(statusCode: number, message: string): boolean {
  if (statusCode !== 413) return false;
  const lowerMessage = message.toLowerCase();
  return REQUEST_TOO_LARGE_MESSAGE_PATTERNS.some((pattern) => pattern.test(lowerMessage));
}

// Strict providers reject a request whose assistant `tool_use`/`tool_calls` and
// `tool_result`/`tool` blocks are not correctly paired and adjacent — a missing
// result, a stray result with no matching call, or a result that does not
// immediately follow its call. Anthropic phrases this in terms of
// `tool_use`/`tool_result`. OpenAI-compatible providers phrase it in terms of
// `tool_call_id` / `role 'tool'` / `tool_calls`: Moonshot / Kimi as a
// `tool_call_id` that "is not found", and OpenAI / DeepSeek / vLLM / Qwen as a
// `role 'tool'` message without a preceding `tool_calls`, or an assistant
// `tool_calls` not followed by its tool results. The validation runs before any
// generation, so the error is a non-retryable 4xx. A caller can react by
// resending a re-projected, strictly wire-compliant request rather than leaving
// the session permanently stuck.
const TOOL_EXCHANGE_ADJACENCY_MESSAGE_PATTERNS = [
  /tool_use[\s\S]*tool_result/,
  /tool_result[\s\S]*tool_use/,
  /unexpected\s+`?tool_result/,
  // OpenAI-compatible (Moonshot / Kimi): a `tool` message references a
  // `tool_call_id` with no matching `tool_calls` entry in the preceding
  // assistant message. Observed verbatim as `tool_call_id  is not found`
  // (doubled space). Anchored on `tool_call_id` so an unrelated "not found"
  // (e.g. a 404-style body) cannot trip the recovery.
  /tool_call_id[\s\S]*not found/,
  // OpenAI / DeepSeek / vLLM and other OpenAI-compatible providers phrase the
  // same structural rejection in terms of `role 'tool'` / `tool_calls` instead
  // of Anthropic's `tool_use` / `tool_result`, in two mirror-image shapes:
  //
  //   - An orphan `tool` result whose preceding assistant carries no matching
  //     `tool_calls`: "messages with role 'tool' must be a response to a
  //     preceding message with 'tool_calls'".
  //   - An assistant `tool_calls` with no following `tool` results: "an
  //     assistant message with 'tool_calls' must be followed by tool messages
  //     responding to each 'tool_call_id'. the following tool_call_ids did not
  //     have response messages: ...", or the terse "(insufficient tool messages
  //     following tool_calls message)".
  //
  // Both are wire-structure defects the strict resend repairs (drop the orphan
  // result / synthesize the missing one). Quote style around `tool`/`tool_calls`
  // varies by provider (straight or backtick), so the anchors tolerate an
  // optional surrounding quote char.
  /role\s+['"`]?tool['"`]?\s+must be a response to a preceding message/,
  /assistant message with\s+['"`]?tool_calls['"`]?\s+must be followed by tool messages/,
  /tool_call_ids? did not have response messages/,
  /insufficient tool messages following/,
] as const;

export function isToolExchangeAdjacencyError(error: unknown): boolean {
  if (!(error instanceof APIStatusError)) return false;
  if (error instanceof APIContextOverflowError) return false;
  if (error.statusCode !== 400 && error.statusCode !== 422) return false;
  const lowerMessage = error.message.toLowerCase();
  return TOOL_EXCHANGE_ADJACENCY_MESSAGE_PATTERNS.some((pattern) => pattern.test(lowerMessage));
}

// The broader family of structural request rejections a strict provider returns
// when the message array itself is malformed — tool_use/tool_result pairing,
// empty or whitespace-only text blocks, a non-user first message, or
// non-alternating roles. All are deterministic 4xx validation failures (no
// generation happened) on a history that is re-sent every turn, so the only
// recovery is to resend a re-projected, strictly wire-compliant request rather
// than leave the session permanently stuck. Context-overflow 400s are excluded —
// they are handled by compaction, not by re-projection.
const STRUCTURAL_REQUEST_MESSAGE_PATTERNS = [
  /text content blocks must be non-empty/,
  /text content blocks must contain non-whitespace/,
  /first message must use the .*user.* role/,
  /roles must alternate/,
  /multiple .*(?:user|assistant).* roles in a row/,
  // Anthropic rejects a request whose assistant messages carry two `tool_use`
  // blocks with the same id: "messages: `tool_use` ids must be unique". Seen
  // when a provider reused a call id (e.g. per-response counter ids) earlier
  // in the session; the strict resend dedupes the ids.
  /tool_use[\s\S]*ids must be unique/,
  // Moonshot / Kimi rejects a message whose serialized form carries nothing —
  // no content, no tool_calls, an empty reasoning_content: "the message at
  // position N with role 'assistant' must not be empty". Seen when a filtered
  // response left an assistant message holding only an empty thinking part in
  // the history; the strict resend's projection drops such vacuous messages.
  /message at position \d+ with role ['"`]?[a-z]+['"`]? must not be empty/,
] as const;

export function isRecoverableRequestStructureError(error: unknown): boolean {
  if (isToolExchangeAdjacencyError(error)) return true;
  if (!(error instanceof APIStatusError)) return false;
  if (error instanceof APIContextOverflowError) return false;
  if (error.statusCode !== 400 && error.statusCode !== 422) return false;
  const lowerMessage = error.message.toLowerCase();
  return STRUCTURAL_REQUEST_MESSAGE_PATTERNS.some((pattern) => pattern.test(lowerMessage));
}

export function isProviderRateLimitError(error: unknown): boolean {
  // Quota exhaustion is a 429 but not a rate limit: the rate-limit reactions
  // (retry, requeue, suspend) cannot help until the account is recharged.
  if (error instanceof APIProviderQuotaExhaustedError) return false;
  if (error instanceof APIProviderRateLimitError) return true;

  const statusCode = getStatusCode(error);
  if (statusCode !== undefined) return statusCode === 429;

  const lowerMessage = errorMessage(error).toLowerCase();
  return PROVIDER_RATE_LIMIT_MESSAGE_PATTERNS.some((pattern) => pattern.test(lowerMessage));
}

function getStatusCode(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;

  const record = error as Record<string, unknown>;
  const statusCode = record['statusCode'];
  if (typeof statusCode === 'number') return statusCode;
  const status = record['status'];
  if (typeof status === 'number') return status;

  const response = record['response'];
  if (typeof response !== 'object' || response === null) return undefined;
  const responseRecord = response as Record<string, unknown>;
  const responseStatusCode = responseRecord['statusCode'];
  if (typeof responseStatusCode === 'number') return responseStatusCode;
  const responseStatus = responseRecord['status'];
  return typeof responseStatus === 'number' ? responseStatus : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
