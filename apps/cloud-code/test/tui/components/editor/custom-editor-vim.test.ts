import type { TUI } from '@cloud-code/pi-tui';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CustomEditor } from '#/tui/components/editor/custom-editor';
import { FooterComponent } from '#/tui/components/chrome/footer';
import { getLocalePreference, setLocalePreference } from '#/tui/i18n';
import type { AppState } from '#/tui/types';

const ESC = '\u001B';
const ANSI_SGR = /\u001B\[[0-9;]*m/g;

function strip(text: string): string {
  return text.replaceAll(ANSI_SGR, '');
}

function makeEditor(): CustomEditor {
  const tui = {
    requestRender: vi.fn(),
    render: vi.fn(() => []),
    terminal: { rows: 40, cols: 120 },
  } as unknown as TUI;
  return new CustomEditor(tui);
}

function type(editor: CustomEditor, text: string): void {
  for (const ch of text) {
    editor.handleInput(ch);
  }
}

// The suite flips the locale for the footer badge tests; restore whatever
// was active when the file loaded.
const originalPreference = getLocalePreference();

afterEach(() => {
  setLocalePreference(originalPreference);
});

describe('CustomEditor vim mode', () => {
  it('starts in INSERT and passes printable input through unchanged', () => {
    const editor = makeEditor();
    editor.setVimEnabled(true);

    type(editor, 'hello world');
    expect(editor.getVimMode()).toBe('INSERT');
    expect(editor.getText()).toBe('hello world');
  });

  it('INSERT Escape switches to NORMAL without firing the app-level onEscape', () => {
    const editor = makeEditor();
    editor.setVimEnabled(true);
    const onEscape = vi.fn();
    editor.onEscape = onEscape;
    const modes: Array<'INSERT' | 'NORMAL'> = [];
    editor.onVimModeChange = (mode) => modes.push(mode);

    type(editor, 'ab');
    editor.handleInput(ESC);

    expect(editor.getVimMode()).toBe('NORMAL');
    expect(onEscape).not.toHaveBeenCalled();
    expect(modes).toEqual(['NORMAL']);
    // Vim semantics: cursor steps one char left when leaving INSERT.
    expect(editor.getCursorOffset()).toBe(1);
  });

  it('NORMAL Escape falls through to the app-level cancel/double-Esc state machine', () => {
    const editor = makeEditor();
    editor.setVimEnabled(true);
    const onEscape = vi.fn();
    editor.onEscape = onEscape;

    type(editor, 'ab');
    editor.handleInput(ESC); // INSERT -> NORMAL (consumed by vim)
    editor.handleInput(ESC); // NORMAL: falls through

    expect(onEscape).toHaveBeenCalledTimes(1);
    expect(editor.getVimMode()).toBe('NORMAL');
  });

  it('a NORMAL Escape cancels a pending vim command before falling through', () => {
    const editor = makeEditor();
    editor.setVimEnabled(true);
    const onEscape = vi.fn();
    editor.onEscape = onEscape;

    type(editor, 'ab');
    editor.handleInput(ESC);
    type(editor, 'd'); // pending delete operator
    editor.handleInput(ESC); // cancels the operator AND reaches onEscape
    expect(onEscape).toHaveBeenCalledTimes(1);

    // 'w' now moves instead of deleting: text untouched.
    type(editor, 'w');
    expect(editor.getText()).toBe('ab');
  });

  it('NORMAL-mode keys run motions/operators instead of inserting text', () => {
    const editor = makeEditor();
    editor.setVimEnabled(true);

    type(editor, 'hello world');
    editor.handleInput(ESC);
    type(editor, '0');
    type(editor, 'dw');
    expect(editor.getText()).toBe('world');

    // 'i' returns to INSERT; typing resumes inserting.
    type(editor, 'i');
    type(editor, 'hey ');
    expect(editor.getText()).toBe('hey world');
    expect(editor.getVimMode()).toBe('INSERT');
  });

  it('does not enter bash mode from NORMAL on an empty buffer', () => {
    const editor = makeEditor();
    editor.setVimEnabled(true);
    const modeChanges: Array<'prompt' | 'bash'> = [];
    editor.onInputModeChange = (mode) => modeChanges.push(mode);

    editor.handleInput(ESC); // -> NORMAL on empty buffer
    type(editor, '!');

    expect(editor.inputMode).toBe('prompt');
    expect(modeChanges).toEqual([]);
    expect(editor.getText()).toBe('');
  });

  it('vim disabled keeps every existing behavior (zero-change regression)', () => {
    const editor = makeEditor();
    const onEscape = vi.fn();
    editor.onEscape = onEscape;

    // Printable input inserts literally.
    type(editor, 'hjkl');
    expect(editor.getText()).toBe('hjkl');
    expect(editor.getVimMode()).toBeNull();

    // Escape goes straight to the app-level handler.
    editor.handleInput(ESC);
    expect(onEscape).toHaveBeenCalledTimes(1);

    // `!` on an empty prompt still enters bash mode.
    const bashEditor = makeEditor();
    type(bashEditor, '!');
    expect(bashEditor.inputMode).toBe('bash');
  });
});

describe('FooterComponent vim mode badge', () => {
  function baseState(overrides: Partial<AppState> = {}): AppState {
    return {
      model: 'k2',
      workDir: '/tmp',
      additionalDirs: [],
      sessionId: 'sess_1',
      permissionMode: 'manual',
      planMode: false,
      thinkingEffort: 'off',
      contextUsage: 0,
      contextTokens: 0,
      maxContextTokens: 0,
      isCompacting: false,
      isReplaying: false,
      streamingPhase: 'idle',
      streamingStartTime: 0,
      theme: 'dark',
      version: 'test',
      editorCommand: null,
      notifications: { enabled: true, condition: 'unfocused' },
      availableModels: {},
      ...overrides,
    } as AppState;
  }

  it('shows INSERT / NORMAL in English', () => {
    setLocalePreference('en');
    const insert = strip(new FooterComponent(baseState({ vimMode: 'INSERT' })).render(120)[0]!);
    expect(insert).toContain('INSERT');

    const normal = strip(new FooterComponent(baseState({ vimMode: 'NORMAL' })).render(120)[0]!);
    expect(normal).toContain('NORMAL');
  });

  it('shows 插入 / 普通 in zh-CN', () => {
    setLocalePreference('zh-CN');
    const insert = strip(new FooterComponent(baseState({ vimMode: 'INSERT' })).render(120)[0]!);
    expect(insert).toContain('插入');

    const normal = strip(new FooterComponent(baseState({ vimMode: 'NORMAL' })).render(120)[0]!);
    expect(normal).toContain('普通');
  });

  it('shows no badge when vim mode is off', () => {
    setLocalePreference('en');
    const out = strip(new FooterComponent(baseState({ vimMode: null })).render(120)[0]!);
    expect(out).not.toContain('INSERT');
    expect(out).not.toContain('NORMAL');
  });
});
