import { getKeybindings, type TUI } from '@cloud-code/pi-tui';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CustomEditor } from '#/tui/components/editor/custom-editor';
import { APP_CHAT_CONTEXT, APP_KEYBINDINGS } from '#/tui/keybindings/default-bindings';
import { installAppKeybindings } from '#/tui/keybindings/manager';

function makeEditor(): CustomEditor {
  const tui = {
    requestRender: vi.fn(),
    render: vi.fn(() => []),
    terminal: { rows: 40, cols: 120 },
  } as unknown as TUI;
  return new CustomEditor(tui);
}

async function flushAsync(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

// Key data sequences for the migrated shortcuts.
const CTRL_B = '\u0002';
const CTRL_C = '\u0003';
const CTRL_D = '\u0004';
const CTRL_G = '\u0007';
const CTRL_O = '\u000F';
const CTRL_P = '\u0010';
const CTRL_S = '\u0013';
const CTRL_T = '\u0014';
const CTRL_V = '\u0016';
const CTRL_UNDERSCORE = '\u001F'; // ctrl+- / ctrl+_
const SHIFT_TAB = '\u001B[Z';

/**
 * The app defaultBindings table must map 1:1 onto the keys of the former
 * hardcoded matchesKey chain in custom-editor.ts (behaviour unchanged).
 */
const EXPECTED_DEFAULTS: Record<string, string> = {
  'app.chat.pasteImage': process.platform === 'win32' ? 'alt+v' : 'ctrl+v',
  'app.chat.openExternalEditor': 'ctrl+g',
  'app.chat.toggleToolExpand': 'ctrl+o',
  'app.chat.steer': 'ctrl+s',
  'app.chat.backgroundTask': 'ctrl+b',
  'app.chat.toggleTodoExpand': 'ctrl+t',
  'app.chat.planModeToggle': 'shift+tab',
};

beforeEach(() => {
  // Reset the global manager to defaults so user-binding installs from
  // other tests in this file never leak across cases.
  installAppKeybindings();
});

describe('APP_KEYBINDINGS table coverage', () => {
  it('covers exactly the migrated chat shortcuts', () => {
    expect(Object.keys(APP_KEYBINDINGS).toSorted()).toEqual(Object.keys(EXPECTED_DEFAULTS).toSorted());
  });

  it('resolves every action to its former hardcoded key in the chat context', () => {
    const kb = installAppKeybindings();
    for (const [action, key] of Object.entries(EXPECTED_DEFAULTS)) {
      expect(kb.getKeys(action as keyof typeof APP_KEYBINDINGS)).toEqual([key]);
      expect(kb.getDefinition(action as keyof typeof APP_KEYBINDINGS).context).toBe(
        APP_CHAT_CONTEXT,
      );
    }
  });

  it('keeps pi-tui editor/select/input definitions alongside the app actions', () => {
    const kb = installAppKeybindings();
    expect(kb.hasDefinition('tui.editor.undo')).toBe(true);
    expect(kb.hasDefinition('tui.input.submit')).toBe(true);
    expect(kb.getActiveContexts()).toEqual([APP_CHAT_CONTEXT]);
  });
});

describe('CustomEditor default dispatch (table equivalence)', () => {
  it('ctrl+g fires onOpenExternalEditor', () => {
    const editor = makeEditor();
    const onOpenExternalEditor = vi.fn();
    editor.onOpenExternalEditor = onOpenExternalEditor;

    editor.handleInput(CTRL_G);
    expect(onOpenExternalEditor).toHaveBeenCalledOnce();
  });

  it('ctrl+o fires onToggleToolExpand', () => {
    const editor = makeEditor();
    const onToggleToolExpand = vi.fn();
    editor.onToggleToolExpand = onToggleToolExpand;

    editor.handleInput(CTRL_O);
    expect(onToggleToolExpand).toHaveBeenCalledOnce();
  });

  it('ctrl+s fires onCtrlS', () => {
    const editor = makeEditor();
    const onCtrlS = vi.fn();
    editor.onCtrlS = onCtrlS;

    editor.handleInput(CTRL_S);
    expect(onCtrlS).toHaveBeenCalledOnce();
  });

  it('shift+tab fires onShiftTab', () => {
    const editor = makeEditor();
    const onShiftTab = vi.fn();
    editor.onShiftTab = onShiftTab;

    editor.handleInput(SHIFT_TAB);
    expect(onShiftTab).toHaveBeenCalledOnce();
  });

  it('ctrl+b is consumed only when the handler backgrounds a task', () => {
    const editor = makeEditor();
    const onCtrlB = vi.fn().mockReturnValue(true);
    editor.onCtrlB = onCtrlB;

    editor.handleInput(CTRL_B);
    expect(onCtrlB).toHaveBeenCalledOnce();

    // Returning false falls through to the editor default (cursor-left).
    onCtrlB.mockReturnValue(false);
    editor.handleInput('ab');
    expect(editor.getText()).toBe('ab');
    editor.handleInput(CTRL_B);
    expect(onCtrlB).toHaveBeenCalledTimes(2);
    expect(editor.getCursor()).toEqual({ line: 0, col: 1 });
  });

  it('ctrl+t is consumed only when the todo overflow toggles', () => {
    const editor = makeEditor();
    const onToggleTodoExpand = vi.fn().mockReturnValue(true);
    editor.onToggleTodoExpand = onToggleTodoExpand;

    editor.handleInput(CTRL_T);
    expect(onToggleTodoExpand).toHaveBeenCalledOnce();
  });

  it('ctrl+v routes to the image paste handler', async () => {
    const editor = makeEditor();
    const onPasteImage = vi.fn(async () => true);
    editor.onPasteImage = onPasteImage;

    editor.handleInput(CTRL_V);
    await flushAsync();
    expect(onPasteImage).toHaveBeenCalledOnce();
    expect(editor.getText()).toBe('');
  });

  it('ctrl+- undoes via the editor binding', () => {
    const editor = makeEditor();

    editor.handleInput('a');
    editor.handleInput(CTRL_UNDERSCORE);
    expect(editor.getText()).toBe('');
  });

  it('reserved keys stay hardcoded: ctrl+c fires onCtrlC, ctrl+d on empty fires onCtrlD', () => {
    const editor = makeEditor();
    const onCtrlC = vi.fn();
    const onCtrlD = vi.fn();
    editor.onCtrlC = onCtrlC;
    editor.onCtrlD = onCtrlD;

    editor.handleInput(CTRL_C);
    expect(onCtrlC).toHaveBeenCalledOnce();
    expect(onCtrlD).not.toHaveBeenCalled();

    editor.handleInput(CTRL_D);
    expect(onCtrlD).toHaveBeenCalledOnce();
  });

  it('ctrl+d with a non-empty buffer does not fire onCtrlD', () => {
    const editor = makeEditor();
    const onCtrlD = vi.fn();
    editor.onCtrlD = onCtrlD;

    editor.handleInput('a');
    editor.handleInput(CTRL_D);
    expect(onCtrlD).not.toHaveBeenCalled();
  });
});

describe('CustomEditor with user-rebound keys', () => {
  it('moves the action to the user key and drops the default', () => {
    installAppKeybindings({ 'app.chat.toggleToolExpand': 'ctrl+p' });
    const editor = makeEditor();
    const onToggleToolExpand = vi.fn();
    editor.onToggleToolExpand = onToggleToolExpand;

    editor.handleInput(CTRL_O);
    expect(onToggleToolExpand).not.toHaveBeenCalled();

    editor.handleInput(CTRL_P);
    expect(onToggleToolExpand).toHaveBeenCalledOnce();
  });

  it('disables an action bound to an empty key list', () => {
    installAppKeybindings({ 'app.chat.steer': [] });
    const editor = makeEditor();
    const onCtrlS = vi.fn();
    editor.onCtrlS = onCtrlS;

    editor.handleInput(CTRL_S);
    expect(onCtrlS).not.toHaveBeenCalled();
  });

  it('keeps reserved keys hardcoded even when user bindings are installed', () => {
    installAppKeybindings({ 'app.chat.steer': 'ctrl+x' });
    expect(getKeybindings().getKeys('app.chat.steer')).toEqual(['ctrl+x']);

    const editor = makeEditor();
    const onCtrlC = vi.fn();
    editor.onCtrlC = onCtrlC;

    editor.handleInput(CTRL_C);
    expect(onCtrlC).toHaveBeenCalledOnce();
  });
});
