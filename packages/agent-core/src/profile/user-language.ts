/**
 * Process-wide user UI-language preference bridge.
 *
 * The interactive host (the TUI) owns the user's language preference
 * (`tui.toml` `language` key); agents need it when rendering the system
 * prompt's `# Language` section (`CLOUD_CODE_USER_LANGUAGE`). For in-process
 * hosts the simplest channel is this module-level holder: the host writes
 * it once at startup and on every `/language` switch, sessions subscribe
 * and re-render (a deliberate one-time prompt-cache bust per switch).
 *
 * Daemon-client hosts run the core in another process and cannot use this
 * bridge; they should wire an explicit RPC once one exists. Until then a
 * remote core simply sees `undefined` (language inference from messages,
 * the historical behaviour).
 */

/** Listener invoked with the new value after every effective change. */
export type UserLanguageListener = (language: string | undefined) => void;

let currentUserLanguage: string | undefined;
const listeners = new Set<UserLanguageListener>();

/** The current explicit user language, or `undefined` when unset/following the system. */
export function getUserLanguage(): string | undefined {
  return currentUserLanguage;
}

/**
 * Set the user language display name (e.g. '简体中文', 'English').
 * `undefined` (or an empty/blank string) clears the preference. No-op when
 * unchanged; listeners fire only on effective changes.
 */
export function setUserLanguage(language: string | undefined): void {
  const normalized =
    language !== undefined && language.trim().length > 0 ? language : undefined;
  if (normalized === currentUserLanguage) return;
  currentUserLanguage = normalized;
  for (const listener of listeners) {
    listener(currentUserLanguage);
  }
}

/** Subscribe to changes. Returns an unsubscribe function. */
export function onUserLanguageChange(listener: UserLanguageListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
