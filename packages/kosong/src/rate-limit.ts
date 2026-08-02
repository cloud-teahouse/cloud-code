/**
 * Rate-limit snapshot capture for the ChatGPT Codex backend.
 *
 * Every `/responses` reply from `chatgpt.com/backend-api/codex` carries an
 * `x-codex-*` header family describing the account's plan and quota state
 * (plan type, primary/secondary usage windows, credits). The dedicated
 * quota endpoint (`GET /wham/usage`) answers the same data on demand —
 * the /status panel reads it directly (packages/oauth `chatgpt-codex-usage.ts`)
 * — but it can refuse non-browser clients with a Cloudflare challenge, so
 * these response headers remain the always-available fallback source.
 *
 * The parsing contract mirrors codex's own (`codex-rs/codex-api/src/
 * rate_limits.rs`): a window exists only when its `used-percent` header
 * parses AND at least one of its fields carries data (an all-zero
 * `secondary` window means "no secondary window"); credits require both
 * boolean headers to parse. Backends that do not emit the family (the
 * official OpenAI API, proxies) yield `null` — callers must treat the
 * whole snapshot as absent, not as zeroed.
 */

export interface RateLimitWindowSnapshot {
  /** Percent of the window already consumed (0-100, may carry fractions). */
  readonly usedPercent: number;
  /** Window length in minutes (300 = 5h, 1440 = daily, 10080 = weekly). */
  readonly windowMinutes: number | null;
  /** Unix seconds at which the window resets. */
  readonly resetsAt: number | null;
}

export interface RateLimitCreditsSnapshot {
  readonly hasCredits: boolean;
  readonly unlimited: boolean;
  /** Raw balance string from the backend (often a number), or `null`. */
  readonly balance: string | null;
}

export interface RateLimitSnapshot {
  /** `x-codex-plan-type` (e.g. `"plus"`, `"team"`), or `null`. */
  readonly planType: string | null;
  /** `x-codex-active-limit` (e.g. `"premium"`), or `null`. */
  readonly activeLimit: string | null;
  readonly primary: RateLimitWindowSnapshot | null;
  readonly secondary: RateLimitWindowSnapshot | null;
  readonly credits: RateLimitCreditsSnapshot | null;
  /** Epoch milliseconds when these headers were captured. */
  readonly capturedAt: number;
}

/**
 * Minimal header-lookup surface. Fetch `Headers` satisfies it (and performs
 * case-insensitive lookup per spec), so SDK `withResponse()` results plug in
 * directly.
 */
export interface HeaderLookup {
  get(name: string): string | null;
}

function readTrimmed(headers: HeaderLookup, name: string): string | null {
  const value = headers.get(name);
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function readNumber(headers: HeaderLookup, name: string): number | null {
  const raw = readTrimmed(headers, name);
  if (raw === null) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function readBoolean(headers: HeaderLookup, name: string): boolean | null {
  const raw = readTrimmed(headers, name);
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return null;
}

function parseWindow(headers: HeaderLookup, prefix: string): RateLimitWindowSnapshot | null {
  const usedPercent = readNumber(headers, `${prefix}-used-percent`);
  if (usedPercent === null) return null;
  const windowMinutes = readNumber(headers, `${prefix}-window-minutes`);
  const resetsAt = readNumber(headers, `${prefix}-reset-at`);
  // An all-zero window is the backend's way of saying the window does not
  // exist (observed on the secondary window for Plus accounts).
  const hasData = usedPercent !== 0 || (windowMinutes !== null && windowMinutes !== 0) || resetsAt !== null;
  if (!hasData) return null;
  return { usedPercent, windowMinutes, resetsAt };
}

function parseCredits(headers: HeaderLookup): RateLimitCreditsSnapshot | null {
  const hasCredits = readBoolean(headers, 'x-codex-credits-has-credits');
  const unlimited = readBoolean(headers, 'x-codex-credits-unlimited');
  if (hasCredits === null || unlimited === null) return null;
  return {
    hasCredits,
    unlimited,
    balance: readTrimmed(headers, 'x-codex-credits-balance'),
  };
}

/**
 * Parse the `x-codex-*` rate-limit header family into a structured snapshot.
 * Returns `null` when none of the headers are present (non-Codex backends),
 * so a headerless response never masquerades as a zeroed quota state.
 */
export function parseCodexRateLimitHeaders(
  headers: HeaderLookup,
  capturedAt: number = Date.now(),
): RateLimitSnapshot | null {
  const planType = readTrimmed(headers, 'x-codex-plan-type');
  const activeLimit = readTrimmed(headers, 'x-codex-active-limit');
  const primary = parseWindow(headers, 'x-codex-primary');
  const secondary = parseWindow(headers, 'x-codex-secondary');
  const credits = parseCredits(headers);

  if (
    planType === null &&
    activeLimit === null &&
    primary === null &&
    secondary === null &&
    credits === null
  ) {
    return null;
  }
  return { planType, activeLimit, primary, secondary, credits, capturedAt };
}

/**
 * The Codex backend's quota-exhaustion error body, parsed. The backend
 * answers an exhausted plan with HTTP 429 and
 * `{ "error": { "type": "usage_limit_reached", "plan_type", "resets_at" } }`
 * — the same contract codex itself classifies on
 * (`codex-rs/codex-api/src/api_bridge.rs`). A transient rate limit carries
 * any other error type and must NOT parse here.
 */
export interface CodexUsageLimitError {
  /** `error.plan_type` (e.g. `"pro"`), or `null`. */
  readonly planType: string | null;
  /** `error.resets_at` (unix seconds) converted to epoch ms, or `null`. */
  readonly resetsAtMs: number | null;
}

/**
 * Recognize a quota-exhaustion error body from the Codex backend. Returns
 * `null` for anything that is not exactly `type: "usage_limit_reached"` —
 * transient 429s, non-Codex backends, and bodies from other providers all
 * fall through to the generic status handling.
 *
 * Two nesting levels are accepted, because the two consumers hand over
 * different slices of the same wire body:
 *
 *  - the full body `{ "error": { "type": "usage_limit_reached", ... } }`, and
 *  - the already-unwrapped inner error object
 *    `{ "type": "usage_limit_reached", ... }`. The OpenAI SDK v6 unwraps the
 *    body in `APIError.generate` (`error.error = body["error"]`), so the
 *    provider error converter always receives the inner object — parsing only
 *    the full-body shape silently misses every real SDK-produced 429.
 */
export function parseCodexUsageLimitError(body: unknown): CodexUsageLimitError | null {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  const nested = record['error'];
  const inner =
    nested !== null && typeof nested === 'object' && !Array.isArray(nested)
      ? (nested as Record<string, unknown>)
      : record;
  if (inner['type'] !== 'usage_limit_reached') return null;

  const planTypeRaw = inner['plan_type'];
  const planType = typeof planTypeRaw === 'string' && planTypeRaw.length > 0 ? planTypeRaw : null;
  const resetsAtRaw = inner['resets_at'];
  const resetsAt =
    typeof resetsAtRaw === 'number' && Number.isFinite(resetsAtRaw) ? resetsAtRaw : null;
  return { planType, resetsAtMs: resetsAt === null ? null : resetsAt * 1000 };
}

// The backend's machine token for quota exhaustion, matched against an error
// MESSAGE only as a last resort: a 429 whose body did not parse as JSON (a
// plain-text body, or an edge proxy relaying the backend's error as text)
// carries no structured shape for parseCodexUsageLimitError, but the token
// still shows up in the text the SDK folds into the error message. The token
// is not natural prose, so it cannot false-positive on an ordinary
// rate-limit message; callers must additionally gate on the 429 status.
const USAGE_LIMIT_REACHED_TOKEN = 'usage_limit_reached';

/**
 * Message-text counterpart of {@link parseCodexUsageLimitError} for 429s with
 * an unparseable body. Yields the quota classification with unknown
 * plan/reset — the caller fills those from the response's `x-codex-*`
 * headers, which a failed Codex response still carries.
 */
export function parseCodexUsageLimitMessage(message: string): CodexUsageLimitError | null {
  return message.includes(USAGE_LIMIT_REACHED_TOKEN) ? { planType: null, resetsAtMs: null } : null;
}

/**
 * The usage window that ran out, identified from a snapshot: the window
 * reporting 100% consumption. Primary wins ties — it is the shorter (5h)
 * window and the one an exhausted plan typically trips first.
 */
export interface ExhaustedRateLimitWindow {
  readonly name: 'primary' | 'secondary';
  readonly windowMinutes: number | null;
  /** Unix seconds at which the window resets. */
  readonly resetsAt: number | null;
}

export function exhaustedRateLimitWindow(
  snapshot: RateLimitSnapshot | null | undefined,
): ExhaustedRateLimitWindow | null {
  if (snapshot === null || snapshot === undefined) return null;
  for (const [name, window] of [
    ['primary', snapshot.primary],
    ['secondary', snapshot.secondary],
  ] as const) {
    if (window !== null && window.usedPercent >= 100) {
      return { name, windowMinutes: window.windowMinutes, resetsAt: window.resetsAt };
    }
  }
  return null;
}

// Window-length → label table, mirroring codex's own classification
// (`codex-rs/tui/src/chatwidget/rate_limits.rs`): 300 minutes is the 5h
// window, 10080 the weekly one. Matching carries the same ±5% tolerance —
// the backend's window-minutes values are nominal, not exact.
const WINDOW_LABEL_MINUTES: ReadonlyArray<readonly [number, string]> = [
  [300, '5h'],
  [1440, 'daily'],
  [10080, 'weekly'],
  [43200, 'monthly'],
  [525600, 'annual'],
];

/**
 * Label a usage window by its length in minutes (`'5h'`, `'weekly'`, …).
 * Returns `null` when the length matches no known window, so callers omit
 * the window instead of guessing.
 */
export function rateLimitWindowLabel(windowMinutes: number | null): string | null {
  if (windowMinutes === null) return null;
  for (const [minutes, label] of WINDOW_LABEL_MINUTES) {
    if (Math.abs(windowMinutes - minutes) <= minutes * 0.05) return label;
  }
  return null;
}
