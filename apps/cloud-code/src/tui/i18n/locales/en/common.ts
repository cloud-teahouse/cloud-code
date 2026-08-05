/**
 * English messages — the source of truth for the TUI i18n layer.
 *
 * Contribution rules (also mirrored in the zh-CN files):
 * - Keys are `'<domain>.<name>'`; the domain matches the file name.
 * - `{name}` placeholders are interpolated by `t()`; keep placeholder names
 *   identical across locales.
 * - Translations should aim for a *display column width* no larger than the
 *   English original (CJK glyphs are 2 columns each), so bordered boxes and
 *   aligned columns never overflow. Leave a half-width space around
 *   interpolated values (`{count} 轮`).
 */

export const common = {
  'common.hint.navigate': '↑↓ navigate',
  'common.hint.page': '←→ page',
  'common.hint.select': 'Enter select',
  'common.hint.toggle': 'Space toggle',
  'common.hint.confirm': 'Enter confirm',
  'common.hint.cancel': 'Esc cancel',
  'common.hint.back': 'Esc back',
  'common.hint.searchFocus': '/ ↑ search',
  'common.hint.searchExit': 'Esc back to list',
  'common.currentMark': '← current',
  'common.searchPlaceholder': 'Search…',
  'common.noMatches': 'No matches',
  'common.loading': 'loading…',
  'common.pageIndicator': 'Page {page}/{total}',
  'common.tooSmall': 'Terminal too narrow (need at least {width} columns)',
} as const;
