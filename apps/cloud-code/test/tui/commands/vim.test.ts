import type { TUI } from '@cloud-code/pi-tui';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { handleVimCommand } from '#/tui/commands/config';
import { dispatchInput } from '#/tui/commands/dispatch';
import { findBuiltInSlashCommand, resolveSlashCommandAvailability } from '#/tui/commands/registry';
import { CustomEditor } from '#/tui/components/editor/custom-editor';
import { setLocalePreference, t } from '#/tui/i18n';

const ESC = '\u001B';

function makeEditor(): CustomEditor {
  const tui = {
    requestRender: vi.fn(),
    render: vi.fn(() => []),
    terminal: { rows: 40, cols: 120 },
  } as unknown as TUI;
  return new CustomEditor(tui);
}

function makeHost(editor: CustomEditor) {
  return {
    state: {
      editor,
      appState: {
        theme: 'auto',
        language: 'auto',
        editorCommand: null,
        disablePasteBurst: false,
        notifications: { enabled: true, condition: 'unfocused' },
        upgrade: { autoInstall: true },
        streamingPhase: 'idle',
        isCompacting: false,
        model: 'kimi-k2',
        vimMode: null,
      },
    },
    session: undefined,
    skillCommandMap: new Map<string, string>(),
    pluginCommandMap: new Map<string, string>(),
    setAppState: vi.fn(),
    showNotice: vi.fn(),
    showStatus: vi.fn(),
    showError: vi.fn(),
  };
}

async function flushAsync(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
  }
}

beforeEach(() => {
  setLocalePreference('en');
});

describe('/vim command', () => {
  it('is registered as an always-available builtin', () => {
    const command = findBuiltInSlashCommand('vim');
    expect(command).toBeDefined();
    expect(command?.aliases).toEqual([]);
    expect(resolveSlashCommandAvailability(command!, '')).toBe('always');
    expect(command?.description).toBe('commands.vim.description');
  });

  it('enables vim editing and mirrors INSERT into AppState', () => {
    const editor = makeEditor();
    const host = makeHost(editor);

    handleVimCommand(host as never);

    expect(editor.isVimEnabled()).toBe(true);
    expect(editor.getVimMode()).toBe('INSERT');
    expect(host.setAppState).toHaveBeenCalledWith({ vimMode: 'INSERT' });
    expect(host.showNotice).toHaveBeenCalledWith(
      t('commands.vim.on'),
      t('commands.vim.onDetail'),
    );
  });

  it('disables vim editing and clears the AppState mirror', () => {
    const editor = makeEditor();
    editor.setVimEnabled(true);
    const host = makeHost(editor);

    handleVimCommand(host as never);

    expect(editor.isVimEnabled()).toBe(false);
    expect(editor.getVimMode()).toBeNull();
    expect(host.setAppState).toHaveBeenCalledWith({ vimMode: null });
    expect(host.showNotice).toHaveBeenCalledWith(t('commands.vim.off'), undefined);
  });

  it('disabling mid-NORMAL drops the editor back to INSERT semantics', () => {
    const editor = makeEditor();
    editor.setVimEnabled(true);
    editor.handleInput('a');
    editor.handleInput(ESC); // -> NORMAL
    const host = makeHost(editor);

    handleVimCommand(host as never);

    expect(editor.isVimEnabled()).toBe(false);
    // Plain-editor behavior is back: printable keys insert literally. The
    // cursor sits one char left of where INSERT left it (vim's Escape
    // semantics), so 'h' lands before 'a'.
    editor.handleInput('h');
    expect(editor.getText()).toBe('ha');
  });

  it('does not persist the toggle (session-only, codex /vim parity)', () => {
    const editor = makeEditor();
    const host = makeHost(editor);

    handleVimCommand(host as never);

    // No saveTuiConfig / harness.setConfig on the host surface at all:
    // the persisted default stays with editor.vim_mode in tui.toml.
    expect(host.setAppState).toHaveBeenCalledTimes(1);
    expect(host.showStatus).not.toHaveBeenCalled();
    expect(host.showError).not.toHaveBeenCalled();
  });

  it('routes through dispatchInput', async () => {
    const editor = makeEditor();
    const host = makeHost(editor);

    dispatchInput(host as never, '/vim');
    await flushAsync();

    expect(editor.isVimEnabled()).toBe(true);
    expect(host.setAppState).toHaveBeenCalledWith({ vimMode: 'INSERT' });
  });

  it('shows the notice in zh-CN', () => {
    setLocalePreference('zh-CN');
    const editor = makeEditor();
    const host = makeHost(editor);

    handleVimCommand(host as never);

    expect(host.showNotice).toHaveBeenCalledWith(
      'Vim 模式：开',
      'Esc 进入普通模式；仅本次会话有效——在 tui.toml 中设置 editor.vim_mode 可持久化。',
    );
    setLocalePreference('en');
  });
});
