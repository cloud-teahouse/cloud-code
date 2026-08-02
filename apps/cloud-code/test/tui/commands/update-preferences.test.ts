import { describe, expect, it, vi } from 'vitest';

import { applyUpdatePreferenceChoice } from '#/tui/commands/config';
import { darkColors } from '#/tui/theme/colors';

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

describe('update preference commands', () => {
  it('saves automatic update preference changes to tui.toml', async () => {
    const setAppState = vi.fn();
    const showStatus = vi.fn();
    const host = {
      state: {
        appState: {
          theme: 'auto' as const,
          editorCommand: null,
          notifications: { enabled: true, condition: 'unfocused' as const },
          upgrade: { autoInstall: true },
        },
        theme: { palette: darkColors },
      },
      setAppState,
      showStatus,
    };

    await applyUpdatePreferenceChoice(host, false);

    expect(mocks.saveTuiConfig).toHaveBeenCalledWith({
      theme: 'auto',
      language: 'auto',
      editorCommand: null,
      disablePasteBurst: false,
      fullscreen: true,
      vimMode: false,
      notifications: { enabled: true, condition: 'unfocused' },
      upgrade: { autoInstall: false },
    });
    expect(setAppState).toHaveBeenCalledWith({ upgrade: { autoInstall: false } });
    expect(showStatus).toHaveBeenCalledWith('Automatic updates disabled.');
  });
});
