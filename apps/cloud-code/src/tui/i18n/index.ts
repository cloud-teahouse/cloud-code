/**
 * TUI i18n — runtime entry point.
 *
 * Mutable module-level singleton modelled on `currentTheme`
 * (`tui/theme/theme.ts`): components call `t()` at render time, so a
 * `setLocalePreference()` + re-render hot-switches the whole UI without
 * rebuilding any component.
 *
 * Fallback chain: active locale → English → the key itself (a missing
 * English entry is a development error; surfacing the key beats rendering
 * nothing). Completeness of zh-CN is enforced at compile time via
 * `Record<MessageKey, string>`, so the runtime fallback is only a safety
 * net.
 */

import { detectSystemLocale } from './detect';
import { enMessages, type MessageKey } from './locales/en';
import { zhCnMessages } from './locales/zh-CN';
import type { Locale, LocalePreference } from './types';

export { detectSystemLocale } from './detect';
export { padEndVisible } from './pad-visible';
export {
  LOCALES,
  LOCALE_PREFERENCES,
  isLocalePreference,
  type Locale,
  type LocalePreference,
} from './types';
export { enMessages, type MessageKey } from './locales/en';

const DICTS: Record<Locale, Record<string, string>> = {
  en: enMessages,
  'zh-CN': zhCnMessages,
};

let activeLocale: Locale = 'en';
let activePreference: LocalePreference = 'auto';

/** Resolve a preference to a concrete locale ('auto' → system detection). */
export function resolveLocale(pref: LocalePreference): Locale {
  return pref === 'auto' ? detectSystemLocale() : pref;
}

export function setLocalePreference(pref: LocalePreference): void {
  activePreference = pref;
  activeLocale = resolveLocale(pref);
}

export function getActiveLocale(): Locale {
  return activeLocale;
}

export function getLocalePreference(): LocalePreference {
  return activePreference;
}

export function t(key: MessageKey, vars?: Record<string, string | number>): string {
  const raw = DICTS[activeLocale][key] ?? enMessages[key] ?? key;
  return vars === undefined ? raw : interpolate(raw, vars);
}

function interpolate(raw: string, vars: Record<string, string | number>): string {
  return raw.replace(/\{(\w+)\}/g, (match, name: string) =>
    vars[name] !== undefined ? String(vars[name]) : match,
  );
}

/**
 * Resolve a string that may be an i18n key. Builtin chrome (slash-command
 * descriptions, keyboard shortcuts, toolbar tips) stores *keys* in its
 * module-level constants; plugin/skill-provided strings are plain text and
 * pass through unchanged.
 */
export function resolveDescription(text: string): string {
  return text in enMessages ? t(text as MessageKey) : text;
}

/**
 * `t()` for keys that arrive over the wire (e.g. a tool result's display
 * ref): the key is a plain string, so membership is checked first and an
 * unknown key — a newer agent-core talking to this TUI — yields undefined
 * instead of rendering the key itself. Callers fall back to the raw text.
 */
export function tIfKnown(
  key: string,
  vars?: Record<string, string | number>,
): string | undefined {
  return key in enMessages ? t(key as MessageKey, vars) : undefined;
}

/**
 * Human-readable language name handed to the model for the system-prompt
 * `# Language` section. `'auto'` maps to `undefined` (no explicit
 * preference — the model keeps inferring from message language, matching
 * historical behaviour). Language names stay in their own tongue.
 */
export function userLanguageNameForModel(pref: LocalePreference): string | undefined {
  switch (pref) {
    case 'zh-CN':
      return '简体中文';
    case 'en':
      return 'English';
    case 'auto':
      return undefined;
  }
}
