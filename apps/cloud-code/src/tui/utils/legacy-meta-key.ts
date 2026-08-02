/**
 * Normalize the legacy ESC-prefixed Alt+letter/digit encoding to CSI-u.
 *
 * Some terminals answer the Kitty keyboard-protocol query yet still deliver
 * Alt+letter as the legacy ESC-prefixed form (`\x1be`). pi-tui's matchesKey
 * only accepts that form while the protocol is inactive, so Alt+S / Alt+E /
 * Alt+D silently died there. Translate the legacy form into the equivalent
 * CSI-u sequence (modifier 3 = 1 + Alt) before any matching runs. Only
 * single letters/digits qualify; every other sequence passes through
 * untouched, and no dialog binds Alt+B/F/P/N (the legacy word/arrow
 * aliases), so the translation cannot remap a meaningful key.
 *
 * Dialogs that bind Alt+letter must route their `handleInput` data through
 * this before matching (see tabbed-model-selector, effort-selector,
 * choice-picker).
 */

import { isKittyProtocolActive } from '@cloud-code/pi-tui';

export function normalizeLegacyMetaKey(data: string): string {
  if (!isKittyProtocolActive() || data.length !== 2 || data[0] !== '\x1b') return data;
  const code = data.charCodeAt(1);
  const isLetterOrDigit = (code >= 97 && code <= 122) || (code >= 48 && code <= 57);
  return isLetterOrDigit ? `\x1b[${String(code)};3u` : data;
}
