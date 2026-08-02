/**
 * User keybindings file loader.
 *
 * Loads `<dataDir>/keybindings.json` (`CLOUD_CODE_HOME` > `~/.cloud-code`)
 * in the simplified flat format:
 *
 * ```json
 * {
 *   "app.chat.toggleToolExpand": "ctrl+p",
 *   "app.chat.steer": ["ctrl+s", "ctrl+x"],
 *   "app.chat.pasteImage": []
 * }
 * ```
 *
 * A string maps an action to one key, an array to several, and an empty
 * array unbinds the action. Both pi-tui (`tui.*`) and app (`app.chat.*`)
 * actions are valid keys. Loading is fail-soft: every problem becomes a
 * warning and the offending entry (or file) is skipped, never a crash.
 *
 * Reserved keys (ctrl+c / ctrl+d — interrupt/exit, same rule as Claude
 * Code's NON_REBINDABLE list) cannot be bound to any action; entries
 * naming them are rejected. Chords are intentionally not supported.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { KeybindingConflict, KeyId, KeybindingsConfig } from '@cloud-code/pi-tui';
import { TUI_KEYBINDINGS } from '@cloud-code/pi-tui';

import { t } from '#/tui/i18n';
import { getDataDir } from '#/utils/paths';

import { APP_KEYBINDINGS } from './default-bindings';

/** Keys hardwired to interrupt/exit; binding them is rejected at load. */
export const RESERVED_KEYS: readonly string[] = ['ctrl+c', 'ctrl+d'];

const KNOWN_ACTIONS: ReadonlySet<string> = new Set([
  ...Object.keys(TUI_KEYBINDINGS),
  ...Object.keys(APP_KEYBINDINGS),
]);

export type UserKeybindingWarning =
  | { readonly kind: 'parseError'; readonly message: string }
  | { readonly kind: 'notAnObject' }
  | { readonly kind: 'unknownAction'; readonly action: string }
  | { readonly kind: 'invalidValue'; readonly action: string }
  | { readonly kind: 'reservedKey'; readonly action: string; readonly key: string };

export interface UserKeybindingsLoadResult {
  readonly bindings: KeybindingsConfig;
  readonly warnings: UserKeybindingWarning[];
}

/** Path of the user keybindings file, honouring `CLOUD_CODE_HOME`. */
export function getKeybindingsFile(): string {
  return join(getDataDir(), 'keybindings.json');
}

export function loadUserKeybindings(file: string = getKeybindingsFile()): UserKeybindingsLoadResult {
  let content: string;
  try {
    content = readFileSync(file, 'utf8');
  } catch {
    // Missing (or unreadable) file is not an error — defaults apply.
    return { bindings: {}, warnings: [] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    return {
      bindings: {},
      warnings: [{ kind: 'parseError', message: error instanceof Error ? error.message : String(error) }],
    };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { bindings: {}, warnings: [{ kind: 'notAnObject' }] };
  }

  const bindings: KeybindingsConfig = {};
  const warnings: UserKeybindingWarning[] = [];

  for (const [action, value] of Object.entries(parsed)) {
    if (!KNOWN_ACTIONS.has(action)) {
      warnings.push({ kind: 'unknownAction', action });
      continue;
    }

    const rawKeys = typeof value === 'string' ? [value] : value;
    if (!Array.isArray(rawKeys) || rawKeys.some((key) => typeof key !== 'string')) {
      warnings.push({ kind: 'invalidValue', action });
      continue;
    }

    const keys = (rawKeys as string[]).map(normalizeKeyId);
    const reserved = keys.find((key) => RESERVED_KEYS.includes(key));
    if (reserved !== undefined) {
      warnings.push({ kind: 'reservedKey', action, key: reserved });
      continue;
    }

    bindings[action] = keys as KeyId[];
  }

  return { bindings, warnings };
}

/** Case/whitespace-tolerant normalization: "Ctrl + O" → "ctrl+o". */
function normalizeKeyId(raw: string): string {
  return raw
    .split('+')
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length > 0)
    .join('+');
}

export function formatUserKeybindingWarning(warning: UserKeybindingWarning, file: string): string {
  const vars = { file };
  switch (warning.kind) {
    case 'parseError':
      return t('status.keybindings.parseError', { ...vars, message: warning.message });
    case 'notAnObject':
      return t('status.keybindings.notAnObject', vars);
    case 'unknownAction':
      return t('status.keybindings.unknownAction', { ...vars, action: warning.action });
    case 'invalidValue':
      return t('status.keybindings.invalidValue', { ...vars, action: warning.action });
    case 'reservedKey':
      return t('status.keybindings.reservedKey', {
        ...vars,
        action: warning.action,
        key: warning.key,
      });
  }
}

export function formatKeybindingConflict(conflict: KeybindingConflict, file: string): string {
  return t('status.keybindings.conflict', {
    file,
    key: conflict.key,
    actions: conflict.keybindings.join(', '),
  });
}
