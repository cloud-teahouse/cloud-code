/**
 * Global keybindings manager installation for the app.
 *
 * The app shares one pi-tui `KeybindingsManager`: pi-tui components keep
 * resolving their `tui.*` actions from it (via `getKeybindings()`), while
 * app-level `app.chat.*` actions live in the same registry so user
 * overrides and conflict detection span both namespaces.
 */

import {
  getKeybindings,
  type KeybindingsConfig,
  KeybindingsManager,
  setKeybindings,
  TUI_KEYBINDINGS,
} from '@cloud-code/pi-tui';

import { APP_CHAT_CONTEXT, APP_KEYBINDINGS } from './default-bindings';

/**
 * Install the merged (pi-tui + app) keybindings manager as the global one,
 * activating the chat context. User bindings are applied on top of both
 * default tables; conflicts are available via `manager.getConflicts()`.
 */
export function installAppKeybindings(userBindings: KeybindingsConfig = {}): KeybindingsManager {
  const manager = new KeybindingsManager({ ...TUI_KEYBINDINGS, ...APP_KEYBINDINGS }, userBindings);
  manager.setActiveContexts([APP_CHAT_CONTEXT]);
  setKeybindings(manager);
  return manager;
}

/**
 * Install the default (no user bindings) manager unless one with app
 * definitions is already in place. `CustomEditor` calls this so tests and
 * embedders that skip startup wiring still get the documented defaults;
 * the startup path installs the user-aware manager first and wins.
 */
export function ensureAppKeybindings(): void {
  if (getKeybindings().hasDefinition('app.chat.planModeToggle')) return;
  installAppKeybindings();
}
