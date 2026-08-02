import type { Locale } from './types';

/**
 * Best-effort system locale detection from POSIX locale environment
 * variables (`LC_ALL` > `LC_MESSAGES` > `LANG`). Any `zh*` locale maps to
 * `zh-CN` (Simplified is the only Chinese target for now); anything else —
 * including Windows, which does not set these — falls back to `en`.
 */
export function detectSystemLocale(): Locale {
  const raw = process.env['LC_ALL'] || process.env['LC_MESSAGES'] || process.env['LANG'] || '';
  return raw.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
}
