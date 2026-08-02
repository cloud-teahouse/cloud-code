/**
 * ChatGPT Codex plan-usage fetch — `GET /wham/usage` on the ChatGPT backend,
 * the path style codex's backend client uses for ChatGPT OAuth accounts
 * (codex-rs/backend-client/src/client/rate_limit_resets.rs, PathStyle::ChatGptApi).
 * The app-server style `/api/codex/usage` answers 404 for these tokens.
 *
 * The response complements the `x-codex-*` response-header snapshots captured
 * during model traffic: it is fresh on demand (no user message required) and
 * is the only payload that carries the rate-limit-reset-credit count. The
 * endpoint can still answer with a Cloudflare challenge or 403, so callers
 * must treat a failure as "keep the header snapshot", never as an account
 * error.
 *
 * Headers mirror codex's backend client (client.rs `headers()`): the product
 * User-Agent, `Authorization: Bearer <access_token>`, and
 * `ChatGPT-Account-ID` from the id_token claims.
 */

import { readApiErrorMessage } from './api-error';
import { chatGptBackendHeaders } from './chatgpt-codex';
import { isRecord, readString } from './utils';

export const CHATGPT_CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';

const DEFAULT_TIMEOUT_MS = 8_000;

/** One rate-limit window of the usage payload (seconds → minutes on read). */
export interface CodexUsageWindow {
  /** Percent of the window already consumed (0-100, may carry fractions). */
  readonly usedPercent: number;
  /** Window length in minutes (300 = 5h, 10080 = weekly). */
  readonly windowMinutes: number | null;
  /** Unix seconds at which the window resets. */
  readonly resetsAt: number | null;
}

/** Paid-credit status of the account, when the payload carries it. */
export interface CodexUsageCredits {
  readonly hasCredits: boolean;
  readonly unlimited: boolean;
  /** Raw balance string from the backend (often a number), or `null`. */
  readonly balance: string | null;
}

export interface CodexPlanUsage {
  /** `plan_type` (e.g. `"plus"`, `"pro"`), or `null`. */
  readonly planType: string | null;
  readonly primary: CodexUsageWindow | null;
  readonly secondary: CodexUsageWindow | null;
  readonly credits: CodexUsageCredits | null;
  /**
   * Redeemable usage-limit resets — the payload's
   * `rate_limit_reset_credits.applicable_available_count` (the count that
   * actually applies to this account), falling back to the raw
   * `available_count`; `null` when the payload omits the summary.
   */
  readonly resetCreditsAvailable: number | null;
  /** Epoch milliseconds when the payload was fetched. */
  readonly capturedAt: number;
}

export interface FetchCodexPlanUsageOptions {
  readonly accessToken: string;
  /**
   * Account id from the id_token claims. Optional so degraded tokens can
   * still attempt the call; the backend may reject requests without it.
   */
  readonly accountId?: string | undefined;
  /** Full endpoint URL; defaults to {@link CHATGPT_CODEX_USAGE_URL}. */
  readonly url?: string | undefined;
  readonly userAgent?: string | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
  readonly timeoutMs?: number | undefined;
  /** Wall clock for `capturedAt` (test injection point). */
  readonly now?: (() => number) | undefined;
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readWindow(value: unknown, capturedAt: number): CodexUsageWindow | null {
  if (!isRecord(value)) return null;
  const usedPercent = readNumber(value['used_percent']);
  if (usedPercent === null) return null;
  const windowSeconds = readNumber(value['limit_window_seconds']);
  return {
    usedPercent,
    windowMinutes: windowSeconds !== null && windowSeconds > 0 ? windowSeconds / 60 : null,
    resetsAt: readResetsAt(value, capturedAt),
  };
}

/**
 * Epoch-seconds reset of a window: `reset_at` when the backend stamps it,
 * otherwise derived from the relative `reset_after_seconds` against the
 * fetch time so the reset hint still renders.
 */
function readResetsAt(window: Record<string, unknown>, capturedAt: number): number | null {
  const resetAt = readNumber(window['reset_at']);
  if (resetAt !== null) return resetAt;
  const resetAfter = readNumber(window['reset_after_seconds']);
  if (resetAfter === null || resetAfter < 0) return null;
  return Math.floor(capturedAt / 1000) + Math.trunc(resetAfter);
}

function readCredits(value: unknown): CodexUsageCredits | null {
  if (!isRecord(value)) return null;
  const hasCredits = value['has_credits'];
  const unlimited = value['unlimited'];
  if (typeof hasCredits !== 'boolean' || typeof unlimited !== 'boolean') return null;
  // The wham payload types the balance as a number; older docs show a string.
  const balance = value['balance'];
  return {
    hasCredits,
    unlimited,
    balance:
      readString(balance) ??
      (typeof balance === 'number' && Number.isFinite(balance) ? String(balance) : null),
  };
}

function readResetCreditsAvailable(payload: Record<string, unknown>): number | null {
  const summary = payload['rate_limit_reset_credits'];
  if (!isRecord(summary)) return null;
  // The wham payload splits the raw count from the account-applicable one;
  // display the applicable count when both are present.
  const count =
    readNumber(summary['applicable_available_count']) ?? readNumber(summary['available_count']);
  return count !== null && count >= 0 ? Math.trunc(count) : null;
}

/**
 * Loose parser for the `/wham/usage` payload — field-level degradation to
 * `null` so a partial response never masquerades as a zeroed quota state
 * (same contract as the header parser in kosong `rate-limit.ts`).
 */
export function parseCodexPlanUsagePayload(
  payload: unknown,
  capturedAt: number,
): CodexPlanUsage {
  const record = isRecord(payload) ? payload : {};
  const rateLimit = isRecord(record['rate_limit']) ? record['rate_limit'] : {};
  return {
    planType: readString(record['plan_type']),
    primary: readWindow(rateLimit['primary_window'], capturedAt),
    secondary: readWindow(rateLimit['secondary_window'], capturedAt),
    credits: readCredits(record['credits']),
    resetCreditsAvailable: readResetCreditsAvailable(record),
    capturedAt,
  };
}

/**
 * `GET {url}` with the OAuth bearer (+ account id) and parse the payload.
 * Throws on transport errors, timeouts, and non-2xx responses — the caller
 * decides whether the failure is fatal (login flows) or a fallback trigger
 * (status surfaces).
 */
export async function fetchCodexPlanUsage(
  options: FetchCodexPlanUsageOptions,
): Promise<CodexPlanUsage> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = options.url ?? CHATGPT_CODEX_USAGE_URL;
  const headers = chatGptBackendHeaders(options);

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, { headers, signal: controller.signal });
    if (!response.ok) {
      const message = await readApiErrorMessage(
        response,
        `Failed to fetch ChatGPT Codex usage (HTTP ${String(response.status)}).`,
      );
      throw new Error(message);
    }
    const payload: unknown = await response.json();
    return parseCodexPlanUsagePayload(payload, options.now?.() ?? Date.now());
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('Failed to fetch ChatGPT Codex usage: request timed out.');
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
