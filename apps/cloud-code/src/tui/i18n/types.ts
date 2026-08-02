/**
 * Locale types for the TUI i18n layer.
 *
 * `Locale` is a concrete, fully-supported UI language. `LocalePreference` is
 * what the user stores in `tui.toml`: a concrete locale or `'auto'` (follow
 * the system locale, see `detect.ts`).
 */

export type Locale = 'en' | 'zh-CN';

export type LocalePreference = Locale | 'auto';

export const LOCALES: readonly Locale[] = ['en', 'zh-CN'];

export const LOCALE_PREFERENCES: readonly LocalePreference[] = ['auto', 'en', 'zh-CN'];

export function isLocalePreference(value: string): value is LocalePreference {
  return value === 'auto' || value === 'en' || value === 'zh-CN';
}
