import { beforeEach, describe, expect, it, vi } from 'vitest';

import { applyFullscreenChoice } from '#/tui/commands/config';

const mocks = vi.hoisted(() => ({
  saveTuiConfig: vi.fn(),
}));

vi.mock('../../../src/tui/config', async () => {
  const actual = await vi.importActual<typeof import('../../../src/tui/config.js')>(
    '../../../src/tui/config.js',
  );
  return {
    ...actual,
    saveTuiConfig: mocks.saveTuiConfig,
  };
});

function makeHost(appState: { fullscreen?: boolean }) {
  return {
    state: {
      appState: {
        theme: 'auto' as const,
        language: 'auto' as const,
        editorCommand: null,
        disablePasteBurst: false,
        vimMode: null,
        notifications: { enabled: true, condition: 'unfocused' as const },
        upgrade: { autoInstall: true },
        ...appState,
      },
      ui: { setFullscreen: vi.fn() },
    },
    setAppState: vi.fn(),
    showStatus: vi.fn(),
  };
}

describe('fullscreen mode commands', () => {
  beforeEach(() => {
    mocks.saveTuiConfig.mockClear();
  });

  it('switching to inline mode saves the preference and live-switches the render path', async () => {
    const host = makeHost({ fullscreen: true });

    await applyFullscreenChoice(host, false);

    expect(mocks.saveTuiConfig).toHaveBeenCalledWith({
      theme: 'auto',
      language: 'auto',
      editorCommand: null,
      disablePasteBurst: false,
      fullscreen: false,
      vimMode: false,
      notifications: { enabled: true, condition: 'unfocused' },
      upgrade: { autoInstall: true },
    });
    expect(host.setAppState).toHaveBeenCalledWith({ fullscreen: false });
    expect(host.state.ui.setFullscreen).toHaveBeenCalledWith(false);
    expect(host.showStatus).toHaveBeenCalledWith(
      'Fullscreen mode disabled — classic inline mode; mouse reporting is off and terminal scrollback is native.',
    );
  });

  it('switching back to fullscreen saves and live-switches', async () => {
    const host = makeHost({ fullscreen: false });

    await applyFullscreenChoice(host, true);

    expect(mocks.saveTuiConfig).toHaveBeenCalledWith(
      expect.objectContaining({ fullscreen: true }),
    );
    expect(host.setAppState).toHaveBeenCalledWith({ fullscreen: true });
    expect(host.state.ui.setFullscreen).toHaveBeenCalledWith(true);
    expect(host.showStatus).toHaveBeenCalledWith('Fullscreen mode enabled (alternate screen).');
  });

  it('an absent preference defaults to fullscreen: enabling is a no-op', async () => {
    const host = makeHost({});

    await applyFullscreenChoice(host, true);

    expect(host.showStatus).toHaveBeenCalledWith('Fullscreen mode already enabled.');
    expect(mocks.saveTuiConfig).not.toHaveBeenCalled();
    expect(host.setAppState).not.toHaveBeenCalled();
    expect(host.state.ui.setFullscreen).not.toHaveBeenCalled();
  });

  it('selecting the current mode is a no-op', async () => {
    const host = makeHost({ fullscreen: false });

    await applyFullscreenChoice(host, false);

    expect(host.showStatus).toHaveBeenCalledWith('Fullscreen mode already disabled (inline mode).');
    expect(mocks.saveTuiConfig).not.toHaveBeenCalled();
    expect(host.state.ui.setFullscreen).not.toHaveBeenCalled();
  });

  it('a failed save keeps the current mode and does not touch the render path', async () => {
    mocks.saveTuiConfig.mockRejectedValueOnce(new Error('disk full'));
    const host = makeHost({ fullscreen: true });

    await applyFullscreenChoice(host, false);

    expect(host.showStatus).toHaveBeenCalledWith(
      'Failed to save fullscreen setting: disk full',
      'error',
    );
    expect(host.setAppState).not.toHaveBeenCalled();
    expect(host.state.ui.setFullscreen).not.toHaveBeenCalled();
  });
});
