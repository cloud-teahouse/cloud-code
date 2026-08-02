import {
  APIConnectionError,
  APIEmptyResponseError,
  APIProviderQuotaExhaustedError,
  APIQuotaExceededError,
  APIStatusError,
  APITimeoutError,
  ChatProviderError,
} from '@cloud-code/kosong';

import { CloudCodeError } from './classes';
import { ErrorCodes, CLOUD_CODE_ERROR_INFO, type CloudCodeErrorCode } from './codes';

/**
 * Wire-safe payload of a Kimi error.
 *
 * The structure passed across process / language boundaries (RPC, events,
 * SDK wrappers). Class identity does not survive the boundary;
 * downstream code must branch on `code` rather than `instanceof`.
 *
 * `details` is JSON-serialized. `cause` is intentionally absent -- it is
 * local-only diagnostic state and must not cross the boundary.
 */
export interface CloudCodeErrorPayload {
  readonly code: CloudCodeErrorCode;
  readonly message: string;
  readonly name?: string;
  readonly details?: Record<string, unknown>;
  readonly retryable: boolean;
}

/** Type guard for CloudCodeError. */
export function isCloudCodeError(error: unknown): error is CloudCodeError {
  return error instanceof CloudCodeError;
}

/**
 * Build a CloudCodeErrorPayload directly from a code + message (no Error instance
 * needed). Use this for synthetic error events that are signaled, not thrown
 * -- e.g. "turn busy" or "compaction failed". `retryable` is filled from
 * CLOUD_CODE_ERROR_INFO so callers cannot drift out of sync with the registry.
 */
export function makeErrorPayload(
  code: CloudCodeErrorCode,
  message: string,
  options?: { readonly details?: Record<string, unknown>; readonly name?: string },
): CloudCodeErrorPayload {
  return {
    code,
    message,
    name: options?.name,
    details: options?.details,
    retryable: CLOUD_CODE_ERROR_INFO[code].retryable,
  };
}

/**
 * Normalize any value into a CloudCodeErrorPayload.
 *
 * Recognized errors:
 * - `CloudCodeError`: passthrough.
 * - `APIQuotaExceededError`: quota_exhausted (terminal plan-quota 429).
 * - `APIStatusError`: 429 -> rate_limit, 401 -> auth_error, otherwise -> api_error.
 *   Exception: a quota-exhausted 429 maps to api_error (retryable: false) —
 *   the rate_limit code would re-mint a rate-limit error across the wire
 *   boundary and drive the swarm requeue/suspend loop, which cannot help
 *   until the account is recharged.
 * - `APIConnectionError` / `APITimeoutError`: connection_error.
 * - `ChatProviderError`: api_error.
 *
 * Anything else collapses to `internal`. We never echo `cause` or stack on
 * the wire.
 */
export function toCloudCodeErrorPayload(error: unknown): CloudCodeErrorPayload {
  if (isCloudCodeError(error)) {
    return {
      code: error.code,
      message: error.message,
      name: error.name,
      details: error.details,
      retryable: CLOUD_CODE_ERROR_INFO[error.code].retryable,
    };
  }

  if (error instanceof APIQuotaExceededError) {
    // Quota exhaustion is terminal (retryable: false) and carries the plan,
    // reset time, and exhausted window as structured details so presenters
    // (TUI guidance, SDK wrappers) can render them without re-parsing the
    // message. Checked ahead of the generic APIStatusError branch, which
    // would map its inherited 429 to the transient provider.rate_limit.
    return {
      code: ErrorCodes.PROVIDER_QUOTA_EXHAUSTED,
      message: sanitizeStatusErrorMessage(error.message),
      name: error.name,
      details: {
        statusCode: error.statusCode,
        requestId: error.requestId,
        planType: error.planType,
        resetsAtMs: error.resetsAtMs,
        quotaWindow: error.quotaWindow,
      },
      retryable: CLOUD_CODE_ERROR_INFO[ErrorCodes.PROVIDER_QUOTA_EXHAUSTED].retryable,
    };
  }

  if (error instanceof APIStatusError) {
    const code: CloudCodeErrorCode =
      error instanceof APIProviderQuotaExhaustedError
        ? ErrorCodes.PROVIDER_API_ERROR
        : error.statusCode === 429
          ? ErrorCodes.PROVIDER_RATE_LIMIT
          : error.statusCode === 401
            ? ErrorCodes.PROVIDER_AUTH_ERROR
            : ErrorCodes.PROVIDER_API_ERROR;
    return {
      code,
      message: sanitizeStatusErrorMessage(error.message),
      name: error.name,
      details: {
        statusCode: error.statusCode,
        requestId: error.requestId,
        ...rateLimitPauseDetails(error),
      },
      retryable: CLOUD_CODE_ERROR_INFO[code].retryable,
    };
  }

  if (error instanceof APIConnectionError || error instanceof APITimeoutError) {
    return {
      code: ErrorCodes.PROVIDER_CONNECTION_ERROR,
      message: error.message,
      name: error.name,
      retryable: CLOUD_CODE_ERROR_INFO[ErrorCodes.PROVIDER_CONNECTION_ERROR].retryable,
    };
  }

  if (error instanceof APIEmptyResponseError) {
    const code =
      error.finishReason === 'filtered'
        ? ErrorCodes.PROVIDER_FILTERED
        : ErrorCodes.PROVIDER_API_ERROR;
    return {
      code,
      message: error.message,
      name: error.name,
      details: {
        finishReason: error.finishReason,
        rawFinishReason: error.rawFinishReason,
      },
      retryable: CLOUD_CODE_ERROR_INFO[code].retryable,
    };
  }

  if (error instanceof ChatProviderError) {
    return {
      code: ErrorCodes.PROVIDER_API_ERROR,
      message: error.message,
      name: error.name,
      retryable: CLOUD_CODE_ERROR_INFO[ErrorCodes.PROVIDER_API_ERROR].retryable,
    };
  }

  if (error instanceof Error) {
    return {
      code: ErrorCodes.INTERNAL,
      message: error.message,
      name: error.name,
      retryable: CLOUD_CODE_ERROR_INFO[ErrorCodes.INTERNAL].retryable,
    };
  }

  return {
    code: ErrorCodes.INTERNAL,
    message: String(error),
    retryable: CLOUD_CODE_ERROR_INFO[ErrorCodes.INTERNAL].retryable,
  };
}

/**
 * Provider status errors occasionally carry an HTML body instead of a
 * structured message (for example, nginx returning
 * "413 <html><head><title>413 Request Entity Too Large</title>...</html>").
 * Extract the `<title>` when present so the wire message is human readable,
 * and strip carriage returns so the text renders cleanly in terminals — a
 * trailing `\r` combined with line-end padding would otherwise overwrite
 * the whole line. The original HTML remains available in logs and `details`.
 */
function sanitizeStatusErrorMessage(message: string): string {
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(message);
  const extracted = titleMatch?.[1]?.trim();
  const normalized = extracted !== undefined && extracted.length > 0 ? extracted : message;
  return normalized.replaceAll('\r', '');
}

/**
 * RateLimitPauseError (loop/errors.ts, C1 P2) extras for the wire payload,
 * read structurally so this module stays free of a loop import cycle: the
 * pause's resume delay and auto-resume marker let consumers (TUI countdown,
 * SDK wrappers) present the pause without class identity. Ordinary 429s
 * carry neither field and keep the plain statusCode/requestId details.
 */
function rateLimitPauseDetails(error: APIStatusError): Record<string, unknown> {
  const carrier = error as { resumeAfterMs?: unknown; autoResume?: unknown };
  if (typeof carrier.resumeAfterMs !== 'number' || carrier.autoResume !== true) return {};
  return { resumeAfterMs: carrier.resumeAfterMs, autoResume: true };
}

/**
 * Rehydrate a CloudCodeErrorPayload into a CloudCodeError. Used by SDK boundary code
 * receiving errors over RPC to re-surface them with a real class so
 * in-process consumers can still use `instanceof`.
 */
export function fromCloudCodeErrorPayload(payload: CloudCodeErrorPayload): CloudCodeError {
  return new CloudCodeError(payload.code, payload.message, {
    details: payload.details,
  });
}
