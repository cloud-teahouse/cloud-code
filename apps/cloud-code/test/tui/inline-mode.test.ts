import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CloudCodeTUI, type CloudCodeTUIStartupInput } from '#/tui/cloud-code-tui';

// ---------------------------------------------------------------------------
// Inline mode (tui.toml fullscreen = false) smoke tests: the classic render
// path must still host the editor, editor-slot dialogs (mount/Esc-close), and
// children-swap takeovers. Frame math itself is pi-tui's; here we assert the
// app surfaces work against the inline tree.
// ---------------------------------------------------------------------------

function makeStartupInput(): CloudCodeTUIStartupInput {
  return {
    cliOptions: {
      session: undefined,
      continue: false,
      yolo: false,
      auto: false,
      plan: false,
      model: undefined,
      agent: undefined,
      agentFiles: [],
      outputFormat: undefined,
      prompt: undefined,
      skillsDirs: [],
    },
    tuiConfig: {
      theme: 'dark',
      language: 'auto',
      disablePasteBurst: false,
      fullscreen: false,
      editorCommand: null,
      vimMode: false,
      notifications: { enabled: true, condition: 'unfocused' },
      upgrade: { autoInstall: true },
    },
    version: '0.0.0-test',
    workDir: '/tmp/proj-a',
  };
}

function makeHarness() {
  return {
    getExperimentalFeatures: vi.fn(async () => []),
    auth: {
      status: vi.fn(),
      login: vi.fn(),
      logout: vi.fn(),
      getManagedUsage: vi.fn(),
    },
  };
}

function makeDriver(): CloudCodeTUI {
  const driver = new CloudCodeTUI(makeHarness() as never, makeStartupInput());
  // Renders are measured synchronously via ui.render(); keep the scheduled
  // writer away from the real terminal.
  vi.spyOn(driver.state.ui, 'requestRender').mockImplementation(() => {});
  return driver;
}

/** Mount editor + footer the way initMainTui does, without running init(). */
function mountEditorAndFooter(driver: CloudCodeTUI): void {
  driver.state.editorContainer.clear();
  driver.state.editorContainer.addChild(driver.state.editor);
  (driver as unknown as { mountFooter(): void }).mountFooter();
}

class MarkerPanel {
  focused = false;
  constructor(private readonly marker: string) {}
  render(): string[] {
    return [this.marker];
  }
  handleInput(): void {}
  invalidate(): void {}
}

describe('inline mode (fullscreen = false)', () => {
  let tempHome: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), 'cloud-code-inline-test-'));
    originalHome = process.env['CLOUD_CODE_HOME'];
    process.env['CLOUD_CODE_HOME'] = tempHome;
  });

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env['CLOUD_CODE_HOME'];
    } else {
      process.env['CLOUD_CODE_HOME'] = originalHome;
    }
    rmSync(tempHome, { recursive: true, force: true });
  });

  it('selects the inline render path and bottom-anchors a short session', () => {
    const driver = makeDriver();
    mountEditorAndFooter(driver);
    const { state } = driver;
    expect(state.ui.getFullscreen()).toBe(false);

    // The inline path renders the whole tree; BottomAnchorContainer pads a
    // short session with filler up to exactly one screen so the editor and
    // footer pin to the bottom rows.
    const lines = state.ui.render(80);
    expect(lines.length).toBe(Math.max(state.rootContainer.contentLines, state.terminal.rows));
    expect(lines.length).toBeGreaterThanOrEqual(state.terminal.rows);
  });

  it('mounts an editor-slot dialog and restores the editor on close (Esc path)', () => {
    const driver = makeDriver();
    mountEditorAndFooter(driver);
    const { state } = driver;

    const panel = new MarkerPanel('INLINE-DIALOG-MARKER');
    const handle = driver.mountEditorReplacement(panel, {});
    expect(state.editorContainer.children[0]).toBe(panel);
    expect(state.ui.render(80).join('\n')).toContain('INLINE-DIALOG-MARKER');

    driver.restoreEditor(handle);
    expect(state.editorContainer.children[0]).toBe(state.editor);
    expect(state.ui.render(80).join('\n')).not.toContain('INLINE-DIALOG-MARKER');
  });

  it('supports children-swap takeovers against the inline tree', () => {
    const driver = makeDriver();
    mountEditorAndFooter(driver);
    const { state } = driver;

    // The same save/clear/addChild/restore pattern the tasks/workflows/teams
    // browser controllers drive; render-mode agnostic, so it must work
    // unchanged against the inline tree.
    const savedChildren = [...state.ui.children];
    const takeover = new MarkerPanel('INLINE-TAKEOVER-MARKER');
    state.ui.clear();
    state.ui.addChild(takeover);
    state.ui.setFocus(takeover);
    const takeoverFrame = state.ui.render(80).join('\n');
    expect(takeoverFrame).toContain('INLINE-TAKEOVER-MARKER');

    state.ui.clear();
    for (const child of savedChildren) {
      state.ui.addChild(child);
    }
    state.ui.setFocus(state.editor);
    expect(state.ui.children).toEqual([state.rootContainer]);
    const restoredFrame = state.ui.render(80).join('\n');
    expect(restoredFrame).not.toContain('INLINE-TAKEOVER-MARKER');
  });
});
