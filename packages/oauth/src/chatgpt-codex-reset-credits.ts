/**
 * ChatGPT Codex rate-limit reset credits — the redeem ("consume") flow that
 * complements the read-only `/wham/usage` count:
 *
 *   GET  {base}/wham/rate-limit-reset-credits          → credit details
 *   POST {base}/wham/rate-limit-reset-credits/consume  → redeem one
 *
 * (codex-rs/backend-client/src/client/rate_limit_resets.rs, PathStyle::ChatGptApi
 * — the `/api/codex/…` style 404s for ChatGPT OAuth accounts.)
 *
 * The consume call is idempotent per `redeem_request_id`: the caller mints a
 * fresh uuid for every user-confirmed attempt and the backend dedupes retries
 * of the same attempt (`already_redeemed`). Like the usage read, the endpoint
 * can answer with a Cloudflare challenge or 403 — failures throw and the
 * caller decides how to surface them (they are never auth failures).
 *
 * Headers mirror the usage fetch: the product User-Agent,
 * `Authorization: Bearer <access_token>`, and `ChatGPT-Account-ID` from the
 * id_token claims; the POST adds `Content-Type: application/json`.
 */

import { readApiErrorMessage } from './api-error';
import { chatGptBackendHeaders } from './chatgpt-codex';
import { isRecord, readString } from './utils';

export const CHATGPT_CODEX_RESET_CREDITS_URL =
  'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits';

const DEFAULT_TIMEOUT_MS = 8_000;

/** One redeemable reset credit from the list endpoint. */
export interface CodexResetCredit {
  /** Opaque backend identifier, sent back as `credit_id` on consume. */
  readonly id: string;
  /** Raw `reset_type` (e.g. `"codex_rate_limits"`). */
  readonly resetType: string;
  /** Raw `status` (`"available" | "redeeming" | "redeemed" | …`). */
  readonly status: string;
  /** Backend display title, or `null`. */
  readonly title: string | null;
  /** Backend display description (what the reset does), or `null`. */
  readonly description: string | null;
  /** Expiry parsed from the RFC3339 `expires_at`, epoch ms; `null` = no expiry. */
  readonly expiresAt: number | null;
}

/** The list-endpoint payload: the summary count plus per-credit details. */
export interface CodexResetCreditsList {
  readonly availableCount: number;
  /** Every credit the backend listed, in payload order (may exceed/be shorter
   * than `availableCount` — the backend caps the detail list). */
  readonly credits: readonly CodexResetCredit[];
}

/** Outcome codes of the consume endpoint (snake_case on the wire). */
export type ConsumeCodexResetCreditCode =
  | 'reset'
  | 'nothing_to_reset'
  | 'no_credit'
  | 'already_redeemed'
  /** Unrecognized code — surfaced raw so a backend addition never crashes. */
  | 'unknown';

export interface ConsumeCodexResetCreditResult {
  readonly code: ConsumeCodexResetCreditCode;
  /** Raw code string when `code` is `'unknown'`, for diagnostics. */
  readonly rawCode: string | null;
  /** `windows_reset` — how many rate-limit windows the reset touched. */
  readonly windowsReset: number;
}

export interface FetchCodexResetCreditsOptions {
  readonly accessToken: string;
  /** Account id from the id_token claims (same contract as the usage read). */
  readonly accountId?: string | undefined;
  /** Full list-endpoint URL; defaults to {@link CHATGPT_CODEX_RESET_CREDITS_URL}. */
  readonly url?: string | undefined;
  readonly userAgent?: string | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
  readonly timeoutMs?: number | undefined;
}

export interface ConsumeCodexResetCreditOptions extends FetchCodexResetCreditsOptions {
  /**
   * Idempotency key — one fresh uuid per user-confirmed attempt (the caller
   * mints it; retries of the same attempt reuse it).
   */
  readonly redeemRequestId: string;
  /** Consume a specific credit from the list; omitted = the backend picks. */
  readonly creditId?: string | undefined;
  /** Full consume-endpoint URL; defaults to the list URL + `/consume`. */
  readonly url?: string | undefined;
}

function readTimestampMs(value: unknown): number | null {
  const raw = readString(value);
  if (raw === null) return null;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function readCredit(value: unknown): CodexResetCredit | null {
  if (!isRecord(value)) return null;
  const id = readString(value['id']);
  if (id === null) return null;
  return {
    id,
    resetType: readString(value['reset_type']) ?? '',
    status: readString(value['status']) ?? '',
    title: readString(value['title']),
    description: readString(value['description']),
    expiresAt: readTimestampMs(value['expires_at']),
  };
}

/**
 * Loose parser for the list payload, same degradation contract as the usage
 * parser: a missing summary yields `availableCount: 0` with no credits, and
 * malformed credit rows are dropped rather than failing the whole read.
 */
export function parseCodexResetCreditsPayload(payload: unknown): CodexResetCreditsList {
  const record = isRecord(payload) ? payload : {};
  const count = record['available_count'];
  const credits = Array.isArray(record['credits']) ? record['credits'] : [];
  return {
    availableCount:
      typeof count === 'number' && Number.isFinite(count) && count >= 0 ? Math.trunc(count) : 0,
    credits: credits
      .map(readCredit)
      .filter((credit): credit is CodexResetCredit => credit !== null),
  };
}

/** Loose parser for the consume response; an unrecognized code never throws. */
export function parseConsumeCodexResetCreditPayload(
  payload: unknown,
): ConsumeCodexResetCreditResult {
  const record = isRecord(payload) ? payload : {};
  const rawCode = readString(record['code']);
  const code: ConsumeCodexResetCreditCode =
    rawCode === 'reset' ||
    rawCode === 'nothing_to_reset' ||
    rawCode === 'no_credit' ||
    rawCode === 'already_redeemed'
      ? rawCode
      : 'unknown';
  const windowsReset = record['windows_reset'];
  return {
    code,
    rawCode: code === 'unknown' ? rawCode : null,
    windowsReset:
      typeof windowsReset === 'number' && Number.isFinite(windowsReset)
        ? Math.trunc(windowsReset)
        : 0,
  };
}

async function requestJson<T>(
  options: FetchCodexResetCreditsOptions & { readonly method: 'GET' | 'POST' },
  url: string,
  failureLabel: string,
  parse: (payload: unknown) => T,
  body?: Record<string, string>,
): Promise<T> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const headers = chatGptBackendHeaders(options);
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      method: options.method,
      headers:
        body === undefined ? headers : { ...headers, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const message = await readApiErrorMessage(
        response,
        `Failed to ${failureLabel} (HTTP ${String(response.status)}).`,
      );
      throw new Error(message);
    }
    const payload: unknown = await response.json();
    return parse(payload);
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Failed to ${failureLabel}: request timed out.`, { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** `GET {url}` — the reset-credit details behind the usage payload's count. */
export async function fetchCodexResetCredits(
  options: FetchCodexResetCreditsOptions,
): Promise<CodexResetCreditsList> {
  return requestJson(
    { ...options, method: 'GET' },
    options.url ?? CHATGPT_CODEX_RESET_CREDITS_URL,
    'fetch ChatGPT Codex reset credits',
    parseCodexResetCreditsPayload,
  );
}

/**
 * `POST {url}` with `{redeem_request_id, credit_id?}` — redeem one reset
 * credit. Idempotent per `redeem_request_id`; throws on transport errors,
 * timeouts, and non-2xx responses.
 */
export async function consumeCodexResetCredit(
  options: ConsumeCodexResetCreditOptions,
): Promise<ConsumeCodexResetCreditResult> {
  const url = options.url ?? `${CHATGPT_CODEX_RESET_CREDITS_URL}/consume`;
  const body: Record<string, string> = { redeem_request_id: options.redeemRequestId };
  if (options.creditId !== undefined && options.creditId.length > 0) {
    body['credit_id'] = options.creditId;
  }
  return requestJson(
    { ...options, method: 'POST' },
    url,
    'consume ChatGPT Codex reset credit',
    parseConsumeCodexResetCreditPayload,
    body,
  );
}
