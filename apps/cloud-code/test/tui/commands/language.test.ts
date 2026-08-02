import { describe, expect, it, vi, beforeEach } from 'vitest';

import { handleLanguageCommand } from '#/tui/commands/config';
import { dispatchInput } from '#/tui/commands/dispatch';
import { LanguageSelectorComponent } from '#/tui/components/dialogs/language-selector';
import { setLocalePreference, t } from '#/tui/i18n';

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

beforeEach(() => {
  mocks.saveTuiConfig.mockClear();
  setLocalePreference('en');
});

function makeHost(appState: Record<string, unknown> = {}) {
  return {
    state: {
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
        ...appState,
      },
    },
    session: undefined,
    skillCommandMap: new Map<string, string>(),
    pluginCommandMap: new Map<string, string>(),
    mountEditorReplacement: vi.fn(),
    restoreEditor: vi.fn(),
    setAppState: vi.fn(),
    showStatus: vi.fn(),
    showError: vi.fn(),
    applyLanguage: vi.fn().mockResolvedValue(undefined),
  };
}

async function flushAsync(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
  }
}

describe('/language command', () => {
  it('opens the language picker when called without arguments', async () => {
    const host = makeHost();
    await handleLanguageCommand(host as never, '');

    expect(host.mountEditorReplacement).toHaveBeenCalledOnce();
    const panel = host.mountEditorReplacement.mock.calls[0]?.[0];
    expect(panel).toBeInstanceOf(LanguageSelectorComponent);
    expect(mocks.saveTuiConfig).not.toHaveBeenCalled();
    expect(host.applyLanguage).not.toHaveBeenCalled();
  });

  it('persists and applies a valid direct argument', async () => {
    setLocalePreference('en');
    const host = makeHost();
    await handleLanguageCommand(host as never, 'zh-CN');

    expect(mocks.saveTuiConfig).toHaveBeenCalledWith({
      theme: 'auto',
      language: 'zh-CN',
      editorCommand: null,
      disablePasteBurst: false,
      fullscreen: true,
      vimMode: false,
      notifications: { enabled: true, condition: 'unfocused' },
      upgrade: { autoInstall: true },
    });
    expect(host.applyLanguage).toHaveBeenCalledWith('zh-CN');
    expect(host.showStatus).toHaveBeenCalledWith(
      t('commands.language.set', { name: t('dialogs.language.zh-CN') }),
    );
  });

  it('accepts the lang values auto and en', async () => {
    const host = makeHost({ language: 'zh-CN' });
    await handleLanguageCommand(host as never, 'auto');
    expect(host.applyLanguage).toHaveBeenCalledWith('auto');
  });

  it('reports unchanged without saving or applying', async () => {
    setLocalePreference('en');
    const host = makeHost({ language: 'zh-CN' });
    await handleLanguageCommand(host as never, 'zh-CN');

    expect(mocks.saveTuiConfig).not.toHaveBeenCalled();
    expect(host.applyLanguage).not.toHaveBeenCalled();
    expect(host.showStatus).toHaveBeenCalledWith(
      t('commands.language.unchanged', { name: t('dialogs.language.zh-CN') }),
    );
  });

  it('rejects an invalid value without side effects', async () => {
    const host = makeHost();
    await handleLanguageCommand(host as never, 'fr');

    expect(host.showError).toHaveBeenCalledOnce();
    const message = host.showError.mock.calls[0]?.[0] as string;
    expect(message).toContain('fr');
    expect(mocks.saveTuiConfig).not.toHaveBeenCalled();
    expect(host.applyLanguage).not.toHaveBeenCalled();
  });

  it('routes through dispatchInput: /language zh-CN applies the choice', async () => {
    const host = makeHost();
    dispatchInput(host as never, '/language zh-CN');
    await flushAsync();

    expect(host.applyLanguage).toHaveBeenCalledWith('zh-CN');
    expect(mocks.saveTuiConfig).toHaveBeenCalledWith(
      expect.objectContaining({ language: 'zh-CN' }),
    );
  });

  it('routes the /lang alias through dispatch', async () => {
    const host = makeHost();
    dispatchInput(host as never, '/lang en');
    await flushAsync();

    expect(host.applyLanguage).toHaveBeenCalledWith('en');
  });

  it('renders picker options in the active locale, language names untranslated', () => {
    setLocalePreference('zh-CN');
    const picker = new LanguageSelectorComponent({
      currentValue: 'auto',
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });
    const out = picker.render(60).join('\n');
    expect(out).toContain('选择语言');
    expect(out).toContain('自动（跟随系统语言环境）');
    expect(out).toContain('English');
    expect(out).toContain('简体中文');
    setLocalePreference('en');
  });
});
