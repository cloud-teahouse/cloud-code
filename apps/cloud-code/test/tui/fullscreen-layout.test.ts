import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CloudCodeTUI, type CloudCodeTUIStartupInput } from '#/tui/cloud-code-tui';

// ---------------------------------------------------------------------------
// Fullscreen layout wiring — region structure, config gate, notice routing.
// Frame composition / pinning / scrolling math lives in pi-tui's own tests
// (packages/pi-tui/test/tui-fullscreen.test.ts); here we assert the app wires
// the regions up correctly.
// ---------------------------------------------------------------------------

function makeStartupInput(overrides?: { fullscreen?: boolean }): CloudCodeTUIStartupInput {
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
      fullscreen: overrides?.fullscreen ?? true,
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

function makeDriver(overrides?: { fullscreen?: boolean }): CloudCodeTUI {
  const driver = new CloudCodeTUI(makeHarness() as never, makeStartupInput(overrides));
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

function renderNotice(driver: CloudCodeTUI): string {
  return driver.state.noticeContainer.render(80).join('\n');
}

describe('fullscreen layout wiring', () => {
  let tempHome: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), 'cloud-code-layout-test-'));
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

  it('mounts transcript + slot under the root; slot holds the chrome in order', () => {
    const driver = makeDriver();
    const { state } = driver;
    expect(state.ui.children).toEqual([state.rootContainer]);
    expect(state.rootContainer.children).toEqual([
      state.transcriptContainer,
      state.slotContainer,
    ]);
    expect(state.slotContainer.children).toEqual([
      state.noticeContainer,
      state.activityContainer,
      state.todoPanelContainer,
      state.queueContainer,
      state.btwPanelContainer,
      state.swarmContainer,
      state.editorContainer,
    ]);
  });

  it('footer lands at the very end of the slot, right below the editor', () => {
    const driver = makeDriver();
    mountEditorAndFooter(driver);
    const children = driver.state.slotContainer.children;
    const footerWrap = children.at(-1)!;
    expect(children.at(-2)).toBe(driver.state.editorContainer);
    expect(footerWrap).not.toBe(driver.state.footer);
    // The footer sits inside the gutter wrap as its only child.
    expect((footerWrap as unknown as { children: unknown[] }).children).toEqual([
      driver.state.footer,
    ]);
  });

  it('fullscreen mode is on by default and honors the config gate', () => {
    expect(makeDriver().state.ui.getFullscreen()).toBe(true);
    expect(makeDriver({ fullscreen: false }).state.ui.getFullscreen()).toBe(false);
  });

  it('layout regions resolve to transcript + slot', () => {
    const driver = makeDriver();
    const { ui, transcriptContainer, slotContainer } = driver.state;
    // Indirectly observable: the regions must stay mounted so the fullscreen
    // frame uses the split path rather than the whole-tree fallback.
    expect(ui.children[0]).toBe(driver.state.rootContainer);
    expect(driver.state.rootContainer.children).toContain(transcriptContainer);
    expect(driver.state.rootContainer.children).toContain(slotContainer);
  });
});

describe('notice routing', () => {
  let tempHome: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), 'cloud-code-layout-test-'));
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

  it('showStatus defaults to the notice slot, not the transcript', () => {
    const driver = makeDriver();
    driver.showStatus('first');
    expect(driver.state.noticeContainer.children).toHaveLength(1);
    expect(driver.state.transcriptContainer.children).toHaveLength(0);
    expect(renderNotice(driver)).toContain('first');
  });

  it('a newer transient notice replaces the previous one (single slot)', () => {
    const driver = makeDriver();
    driver.showStatus('first');
    driver.showStatus('second');
    expect(driver.state.noticeContainer.children).toHaveLength(1);
    expect(renderNotice(driver)).toContain('second');
    expect(renderNotice(driver)).not.toContain('first');

    driver.showNotice('title-x', 'detail-y');
    expect(driver.state.noticeContainer.children).toHaveLength(1);
    expect(renderNotice(driver)).toContain('title-x');
    expect(renderNotice(driver)).toContain('detail-y');
    expect(renderNotice(driver)).not.toContain('second');
  });

  it('showError is transient by default', () => {
    const driver = makeDriver();
    driver.showError('boom');
    expect(driver.state.noticeContainer.children).toHaveLength(1);
    expect(driver.state.transcriptContainer.children).toHaveLength(0);
    expect(renderNotice(driver)).toContain('boom');
  });

  it('{ transcript: true } pins the message into the transcript', () => {
    const driver = makeDriver();
    driver.showStatus('pinned-status', 'warning', { transcript: true });
    driver.showNotice('pinned-title', 'pinned-detail', { transcript: true });
    driver.showError('pinned-error', { transcript: true });

    const transcript = driver.state.transcriptContainer.render(80).join('\n');
    expect(transcript).toContain('pinned-status');
    expect(transcript).toContain('pinned-title');
    expect(transcript).toContain('pinned-detail');
    expect(transcript).toContain('pinned-error');
    expect(driver.state.transcriptContainer.children).toHaveLength(3);
    // The notice slot was never touched.
    expect(driver.state.noticeContainer.children).toHaveLength(0);
  });

  it('session resets clear the transient notice slot', () => {
    const driver = makeDriver();
    driver.showStatus('stale-notice');
    expect(driver.state.noticeContainer.children).toHaveLength(1);
    (driver as unknown as { clearTranscriptAndRedraw(): void }).clearTranscriptAndRedraw();
    expect(driver.state.noticeContainer.children).toHaveLength(0);
  });

  it('transcript-pinned notices do not clobber the transient slot', () => {
    const driver = makeDriver();
    driver.showStatus('ephemeral');
    driver.showStatus('recorded', undefined, { transcript: true });
    expect(renderNotice(driver)).toContain('ephemeral');
    expect(driver.state.transcriptContainer.render(80).join('\n')).toContain('recorded');
  });
});
