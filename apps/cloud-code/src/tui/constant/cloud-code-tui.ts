import { DEFAULT_OAUTH_PROVIDER_NAME } from '#/constant/app';

export { DEFAULT_OAUTH_PROVIDER_NAME, OAUTH_LOGIN_REQUIRED_CODE, PRODUCT_NAME } from '#/constant/app';

// User-facing guard/hint messages. These module-level constants predate the
// runtime locale, so they store i18n KEYS (status.*); consumers resolve them
// with `resolveDescription()` at display time (same pattern as
// constant/tips.ts). Plain-text passthrough keeps them safe for non-TUI
// consumers.
export const LLM_NOT_SET_MESSAGE = 'status.llmNotSet';
export const NO_ACTIVE_SESSION_MESSAGE = 'status.noActiveSession';
export const CTRL_D_HINT = 'status.ctrlDHint';
export const CTRL_C_HINT = 'status.ctrlCHint';
export const MAIN_AGENT_ID = 'main';
export const OAUTH_LOGIN_REQUIRED_STARTUP_NOTICE = 'status.oauthLoginRequired';
export const EXIT_CONFIRM_WINDOW_MS = 1500;
// Time window for treating two consecutive Esc presses as a double-Esc, which
// opens the undo selector. Kept short (double-click feel) so two deliberate
// presses far apart don't accidentally trigger undo.
export const DOUBLE_ESC_WINDOW_MS = 600;

export function isManagedUsageProvider(
  providerKey: string | undefined,
): providerKey is typeof DEFAULT_OAUTH_PROVIDER_NAME {
  return providerKey === DEFAULT_OAUTH_PROVIDER_NAME;
}
