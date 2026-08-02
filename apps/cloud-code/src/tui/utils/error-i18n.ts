// Backend error-code → i18n presentation.
//
// Engine error text stays English (it is also model-facing context); the TUI
// translates the codes users hit most at the presentation boundary, falling
// back to the raw `[code] message` form for anything unmapped.

import { getActiveLocale, t, type MessageKey } from '../i18n';
import { formatErrorPayload } from './event-payload';

interface ErrorPayloadLike {
  readonly code: string;
  readonly message: string;
  readonly details?: Record<string, unknown>;
}

const TRANSLATED_CODES = new Set([
  'provider.api_error',
  'provider.rate_limit',
  'provider.quota_exhausted',
  // provider.filtered keeps its dedicated concise formatter (formatErrorPayload).
  'provider.auth_error',
  'provider.connection_error',
  'context.overflow',
  'session.closed',
  'session.not_found',
  'model.config_invalid',
  'auth.login_required',
  'loop.max_steps_exceeded',
  'goal.not_found',
  'goal.already_exists',
  'goal.budget_reached',
  'mcp.connect_failed',
]);

function stringDetail(details: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = details?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberDetail(details: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = details?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Localized presentation for a backend error payload: the engine's
 * `[code] message` stays verbatim, with localized actionable guidance (and
 * key details) appended for the codes users hit most. Returns undefined for
 * unmapped codes (the caller then uses the raw format — identical anyway).
 */
export function translateErrorPayload(error: ErrorPayloadLike): string | undefined {
  if (!TRANSLATED_CODES.has(error.code)) return undefined;
  const key = `errors.${error.code}` as MessageKey;
  const statusCode = numberDetail(error.details, 'statusCode');
  const requestId = stringDetail(error.details, 'requestId');
  const detailBits = [
    statusCode === undefined ? undefined : `(HTTP ${statusCode})`,
    requestId === undefined ? undefined : `(request ${requestId})`,
  ].filter((bit): bit is string => bit !== undefined);
  const guidance = t(key, {
    name: stringDetail(error.details, 'name') ?? stringDetail(error.details, 'server') ?? '',
    message: error.message,
    ...quotaExhaustedVars(error),
  });
  // The established presentation stays untouched (including the filtered-
  // concise formatter inside formatErrorPayload); guidance is appended.
  const details = detailBits.length > 0 ? ` ${detailBits.join(' ')}` : '';
  return `${formatErrorPayload(error)}${details} — ${guidance}`;
}

/**
 * Placeholder vars for the provider.quota_exhausted guidance: the exhausted
 * window label and the reset time, read from the engine's error details.
 * Each var is a complete clause so the catalog sentence stays grammatical
 * when the detail is unknown (the mid-stream SSE variant of this error
 * carries neither window nor reset). Empty for every other code.
 */
function quotaExhaustedVars(error: ErrorPayloadLike): Record<string, string> {
  if (error.code !== 'provider.quota_exhausted') return {};
  const zh = getActiveLocale() === 'zh-CN';
  const window = stringDetail(error.details, 'quotaWindow');
  const resetsAtMs = numberDetail(error.details, 'resetsAtMs');
  return {
    window: quotaWindowText(window, zh),
    reset:
      resetsAtMs === undefined
        ? zh
          ? '重置时间未知'
          : 'reset time unknown'
        : quotaResetText(resetsAtMs, zh),
  };
}

// Window labels for the quota guidance. The engine reports the window as a
// language-neutral token ('5h' | 'daily' | 'weekly' | …); the localized
// label lives here rather than in the catalog because it is interpolated
// into the guidance as a var, not looked up as a key.
function quotaWindowText(token: string | undefined, zh: boolean): string {
  switch (token) {
    case '5h':
      return zh ? '5h 窗口' : '5h window';
    case 'daily':
      return zh ? '每日窗口' : 'daily window';
    case 'weekly':
      return zh ? '每周窗口' : 'weekly window';
    case 'monthly':
      return zh ? '每月窗口' : 'monthly window';
    case 'annual':
      return zh ? '每年窗口' : 'annual window';
    default:
      return zh ? '用量窗口' : 'usage window';
  }
}

// Local-time `YYYY-MM-DD HH:MM` — deterministic across environments, unlike
// locale date formatting, so the rendered error is stable in tests and logs.
function quotaResetText(resetsAtMs: number, zh: boolean): string {
  const date = new Date(resetsAtMs);
  const pad = (value: number): string => String(value).padStart(2, '0');
  const timestamp = `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return zh ? `将于 ${timestamp} 重置` : `resets at ${timestamp}`;
}
