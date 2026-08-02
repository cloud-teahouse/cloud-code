import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  formatKeybindingConflict,
  formatUserKeybindingWarning,
  getKeybindingsFile,
  loadUserKeybindings,
  RESERVED_KEYS,
} from '#/tui/keybindings/loader';
import { installAppKeybindings } from '#/tui/keybindings/manager';

let dir: string;
let savedHome: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cloud-code-keybindings-'));
  savedHome = process.env['CLOUD_CODE_HOME'];
  process.env['CLOUD_CODE_HOME'] = dir;
});

afterEach(() => {
  if (savedHome === undefined) {
    delete process.env['CLOUD_CODE_HOME'];
  } else {
    process.env['CLOUD_CODE_HOME'] = savedHome;
  }
  rmSync(dir, { recursive: true, force: true });
  // Leave the global manager back at defaults for other test files.
  installAppKeybindings();
});

function writeKeybindings(content: string): string {
  const file = join(dir, 'keybindings.json');
  writeFileSync(file, content);
  return file;
}

describe('getKeybindingsFile', () => {
  it('follows the CLOUD_CODE_HOME redirect', () => {
    expect(getKeybindingsFile()).toBe(join(dir, 'keybindings.json'));
  });
});

describe('loadUserKeybindings', () => {
  it('returns empty bindings and no warnings when the file is missing', () => {
    const result = loadUserKeybindings();
    expect(result.bindings).toEqual({});
    expect(result.warnings).toEqual([]);
  });

  it('loads a valid file and normalizes key casing/whitespace', () => {
    writeKeybindings(
      JSON.stringify({
        'app.chat.steer': 'Ctrl + X',
        'app.chat.toggleToolExpand': ['ctrl+p', 'CTRL+Q'],
      }),
    );
    const result = loadUserKeybindings();
    expect(result.warnings).toEqual([]);
    expect(result.bindings).toEqual({
      'app.chat.steer': ['ctrl+x'],
      'app.chat.toggleToolExpand': ['ctrl+p', 'ctrl+q'],
    });
  });

  it('accepts an empty array to unbind an action', () => {
    writeKeybindings(JSON.stringify({ 'app.chat.steer': [] }));
    const result = loadUserKeybindings();
    expect(result.warnings).toEqual([]);
    expect(result.bindings).toEqual({ 'app.chat.steer': [] });
  });

  it('accepts pi-tui tui.* actions as well as app actions', () => {
    writeKeybindings(JSON.stringify({ 'tui.editor.undo': 'ctrl+z' }));
    const result = loadUserKeybindings();
    expect(result.warnings).toEqual([]);
    expect(result.bindings).toEqual({ 'tui.editor.undo': ['ctrl+z'] });
  });

  it('warns and skips unknown actions', () => {
    writeKeybindings(
      JSON.stringify({ 'app.chat.nope': 'ctrl+x', 'app.chat.steer': 'ctrl+y' }),
    );
    const result = loadUserKeybindings();
    expect(result.bindings).toEqual({ 'app.chat.steer': ['ctrl+y'] });
    expect(result.warnings).toEqual([{ kind: 'unknownAction', action: 'app.chat.nope' }]);
  });

  it.each(RESERVED_KEYS)('rejects bindings to reserved key %s', (reserved) => {
    writeKeybindings(JSON.stringify({ 'app.chat.steer': reserved }));
    const result = loadUserKeybindings();
    expect(result.bindings).toEqual({});
    expect(result.warnings).toEqual([{ kind: 'reservedKey', action: 'app.chat.steer', key: reserved }]);
  });

  it('rejects reserved keys case-insensitively, including inside arrays', () => {
    writeKeybindings(JSON.stringify({ 'app.chat.steer': ['ctrl+x', 'Ctrl+C'] }));
    const result = loadUserKeybindings();
    expect(result.bindings).toEqual({});
    expect(result.warnings).toEqual([
      { kind: 'reservedKey', action: 'app.chat.steer', key: 'ctrl+c' },
    ]);
  });

  it('warns and uses defaults for malformed JSON', () => {
    const file = writeKeybindings('{ not json');
    const result = loadUserKeybindings(file);
    expect(result.bindings).toEqual({});
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.kind).toBe('parseError');
  });

  it('warns when the top level is not an object', () => {
    writeKeybindings('[["app.chat.steer", "ctrl+x"]]');
    const result = loadUserKeybindings();
    expect(result.bindings).toEqual({});
    expect(result.warnings).toEqual([{ kind: 'notAnObject' }]);
  });

  it('warns and skips values that are not a string or string array', () => {
    writeKeybindings(JSON.stringify({ 'app.chat.steer': 42, 'app.chat.steer2': 'ctrl+x' }));
    const result = loadUserKeybindings();
    expect(result.warnings).toEqual([
      { kind: 'invalidValue', action: 'app.chat.steer' },
      { kind: 'unknownAction', action: 'app.chat.steer2' },
    ]);
    expect(result.bindings).toEqual({});
  });

  it('surfaces user binding conflicts through the installed manager', () => {
    writeKeybindings(
      JSON.stringify({
        'app.chat.steer': 'ctrl+x',
        'app.chat.toggleToolExpand': 'ctrl+x',
      }),
    );
    const { bindings, warnings } = loadUserKeybindings();
    expect(warnings).toEqual([]);

    const manager = installAppKeybindings(bindings);
    expect(manager.getConflicts()).toEqual([
      { key: 'ctrl+x', keybindings: ['app.chat.steer', 'app.chat.toggleToolExpand'] },
    ]);
  });
});

describe('warning formatting', () => {
  it('renders every warning kind with the file and action visible', () => {
    const file = getKeybindingsFile();
    const messages = [
      formatUserKeybindingWarning({ kind: 'parseError', message: 'boom' }, file),
      formatUserKeybindingWarning({ kind: 'notAnObject' }, file),
      formatUserKeybindingWarning({ kind: 'unknownAction', action: 'app.chat.nope' }, file),
      formatUserKeybindingWarning({ kind: 'invalidValue', action: 'app.chat.steer' }, file),
      formatUserKeybindingWarning(
        { kind: 'reservedKey', action: 'app.chat.steer', key: 'ctrl+c' },
        file,
      ),
      formatKeybindingConflict(
        { key: 'ctrl+x', keybindings: ['app.chat.steer', 'app.chat.toggleToolExpand'] },
        file,
      ),
    ];
    for (const message of messages) {
      expect(message).toContain(file);
    }
    expect(messages[2]).toContain('app.chat.nope');
    expect(messages[4]).toContain('ctrl+c');
    expect(messages[5]).toContain('ctrl+x');
  });
});
