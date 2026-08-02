/**
 * App-level default keybindings (Cloud Code).
 *
 * These complement pi-tui's `TUI_KEYBINDINGS` (editor/select/input internal
 * actions) with chat-screen shortcuts that used to be a hardcoded
 * `matchesKey` chain in `custom-editor.ts`. The table is the single source
 * of truth: each action maps 1:1 to its former hardcoded key, so default
 * behaviour is unchanged, and users can rebind every entry via
 * `keybindings.json` (see `./loader.ts`).
 *
 * Deliberately NOT in this table (see the boundary comments at those
 * call sites):
 * - ctrl+c / ctrl+d — reserved interrupt/exit keys (same rule as Claude
 *   Code's NON_REBINDABLE list); the loader rejects attempts to bind them.
 * - Escape — a time-based state machine (autocomplete cancel, stream
 *   cancel, double-Esc undo) lives in `controllers/editor-keyboard.ts`.
 * - undo (ctrl+-) — pi-tui's own `tui.editor.undo` binding owns the key.
 * - up/down on an empty buffer, the Tab swallow, and the `!` bash-mode
 *   trigger — input guards with fall-through semantics, not standalone
 *   actions.
 */

import type { KeybindingDefinitions } from '@cloud-code/pi-tui';

/**
 * Chat-screen context. Installed as the manager's single active context at
 * startup: dialog overlays capture their own input above the editor, so no
 * dynamic context switching is needed yet. `app/dialog` and `app/editor`
 * remain available for the next migration batch (controller-level keys).
 */
export const APP_CHAT_CONTEXT = 'app/chat';

// Type-safe action ids for `KeybindingsManager.matches()`.
declare module '@cloud-code/pi-tui' {
  interface Keybindings {
    'app.chat.pasteImage': true;
    'app.chat.openExternalEditor': true;
    'app.chat.toggleToolExpand': true;
    'app.chat.steer': true;
    'app.chat.backgroundTask': true;
    'app.chat.toggleTodoExpand': true;
    'app.chat.planModeToggle': true;
  }
}

// Platform-aware default, mirroring the former hardcoded chain: Windows
// terminals reserve Ctrl-V for their own paste handling, so image paste
// listens for Alt-V there and Ctrl-V everywhere else.
const PASTE_IMAGE_KEY = process.platform === 'win32' ? 'alt+v' : 'ctrl+v';

export const APP_KEYBINDINGS = {
  'app.chat.pasteImage': {
    defaultKeys: PASTE_IMAGE_KEY,
    context: APP_CHAT_CONTEXT,
    description: 'Paste an image from the clipboard',
  },
  'app.chat.openExternalEditor': {
    defaultKeys: 'ctrl+g',
    context: APP_CHAT_CONTEXT,
    description: 'Open the draft in an external editor',
  },
  'app.chat.toggleToolExpand': {
    defaultKeys: 'ctrl+o',
    context: APP_CHAT_CONTEXT,
    description: 'Expand/collapse tool output',
  },
  'app.chat.steer': {
    defaultKeys: 'ctrl+s',
    context: APP_CHAT_CONTEXT,
    description: 'Steer the running turn with the draft and queued messages',
  },
  'app.chat.backgroundTask': {
    defaultKeys: 'ctrl+b',
    context: APP_CHAT_CONTEXT,
    description: 'Send the foreground task to the background',
  },
  'app.chat.toggleTodoExpand': {
    defaultKeys: 'ctrl+t',
    context: APP_CHAT_CONTEXT,
    description: 'Expand/collapse the todo list overflow',
  },
  'app.chat.planModeToggle': {
    defaultKeys: 'shift+tab',
    context: APP_CHAT_CONTEXT,
    description: 'Toggle plan mode',
  },
} as const satisfies KeybindingDefinitions;
