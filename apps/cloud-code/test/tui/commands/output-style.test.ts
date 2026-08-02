import { beforeEach, describe, expect, it, vi } from 'vitest';

import { handleOutputStyleCommand } from '#/tui/commands/output-style';
import { dispatchInput } from '#/tui/commands/dispatch';
import { OutputStyleSelectorComponent } from '#/tui/components/dialogs/output-style-selector';
import { setLocalePreference, t } from '#/tui/i18n';

const STYLES = [
  { name: 'concise', description: 'Terse responses', source: 'builtin' },
  { name: 'explanatory', description: 'Explains choices', source: 'builtin' },
  { name: 'team-voice', description: 'Team tone', source: 'project' },
] as const;

beforeEach(() => {
  setLocalePreference('en');
});

function makeSession() {
  return {
    listOutputStyles: vi.fn().mockResolvedValue([...STYLES]),
    setOutputStyle: vi.fn().mockResolvedValue(undefined),
  };
}

function makeHost(options: { configuredStyle?: string } = {}) {
  const session = makeSession();
  const config = { providers: {}, outputStyle: options.configuredStyle };
  const host = {
    state: {
      appState: {
        streamingPhase: 'idle',
        isCompacting: false,
        model: 'kimi-k2',
      },
    },
    session,
    harness: {
      getConfig: vi.fn().mockResolvedValue(config),
      setConfig: vi.fn().mockResolvedValue(config),
    },
    requireSession: vi.fn(() => session),
    skillCommandMap: new Map<string, string>(),
    pluginCommandMap: new Map<string, string>(),
    mountEditorReplacement: vi.fn(),
    restoreEditor: vi.fn(),
    showStatus: vi.fn(),
    showError: vi.fn(),
  };
  return { host, session };
}

async function flushAsync(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
  }
}

describe('/output-style command', () => {
  it('opens the picker when called without arguments', async () => {
    const { host } = makeHost();
    await handleOutputStyleCommand(host as never, '');

    expect(host.mountEditorReplacement).toHaveBeenCalledOnce();
    const panel = host.mountEditorReplacement.mock.calls[0]?.[0];
    expect(panel).toBeInstanceOf(OutputStyleSelectorComponent);
  });

  it('applies a valid style live and persists it', async () => {
    const { host, session } = makeHost();
    await handleOutputStyleCommand(host as never, 'concise');

    expect(session.setOutputStyle).toHaveBeenCalledWith('concise');
    expect(host.harness.setConfig).toHaveBeenCalledWith({ outputStyle: 'concise' });
    expect(host.showStatus).toHaveBeenCalledWith(
      t('commands.outputStyle.set', { name: 'concise' }),
    );
  });

  it('selecting default clears back to the stock prompt', async () => {
    const { host, session } = makeHost({ configuredStyle: 'concise' });
    await handleOutputStyleCommand(host as never, 'default');

    expect(session.setOutputStyle).toHaveBeenCalledWith('default');
    expect(host.harness.setConfig).toHaveBeenCalledWith({ outputStyle: 'default' });
  });

  it('reports unchanged without side effects when the style is already active', async () => {
    const { host, session } = makeHost({ configuredStyle: 'concise' });
    await handleOutputStyleCommand(host as never, 'concise');

    expect(session.setOutputStyle).not.toHaveBeenCalled();
    expect(host.harness.setConfig).not.toHaveBeenCalled();
    expect(host.showStatus).toHaveBeenCalledWith(
      t('commands.outputStyle.unchanged', { name: 'concise' }),
    );
  });

  it('rejects an unknown style without side effects', async () => {
    const { host, session } = makeHost();
    await handleOutputStyleCommand(host as never, 'nope');

    expect(session.setOutputStyle).not.toHaveBeenCalled();
    expect(host.harness.setConfig).not.toHaveBeenCalled();
    expect(host.showError).toHaveBeenCalledOnce();
    expect(host.showError.mock.calls[0]?.[0]).toContain('nope');
  });

  it('accepts project-level styles discovered by the session', async () => {
    const { host, session } = makeHost();
    await handleOutputStyleCommand(host as never, 'team-voice');

    expect(session.setOutputStyle).toHaveBeenCalledWith('team-voice');
    expect(host.harness.setConfig).toHaveBeenCalledWith({ outputStyle: 'team-voice' });
  });

  it('routes through dispatchInput: /output-style concise applies the choice', async () => {
    const { host, session } = makeHost();
    dispatchInput(host as never, '/output-style concise');
    await flushAsync();

    expect(session.setOutputStyle).toHaveBeenCalledWith('concise');
    expect(host.harness.setConfig).toHaveBeenCalledWith({ outputStyle: 'concise' });
  });

  it('routes the /style alias through dispatch', async () => {
    const { host } = makeHost();
    dispatchInput(host as never, '/style');
    await flushAsync();

    expect(host.mountEditorReplacement).toHaveBeenCalledOnce();
  });

  it('renders the picker in zh-CN with the current marker', () => {
    setLocalePreference('zh-CN');
    const picker = new OutputStyleSelectorComponent({
      styles: [...STYLES],
      currentValue: 'concise',
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });
    const out = picker.render(60).join('\n');
    expect(out).toContain('选择输出风格');
    expect(out).toContain('default（标准提示词）');
    expect(out).toContain('concise');
    setLocalePreference('en');
  });

  it('localizes builtin style descriptions in zh-CN; names and custom descriptions stay verbatim', () => {
    setLocalePreference('zh-CN');
    const picker = new OutputStyleSelectorComponent({
      styles: [...STYLES],
      currentValue: 'concise',
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });
    const out = picker.render(60).join('\n');
    // Builtin descriptions come from the zh-CN catalog, keyed by style name.
    expect(out).toContain(t('dialogs.outputStyle.builtin.conciseDescription'));
    expect(out).toContain(t('dialogs.outputStyle.builtin.explanatoryDescription'));
    expect(out).not.toContain('Terse responses');
    // Style names are identifiers and stay English; author-provided
    // descriptions (user/project/plugin styles) pass through untranslated.
    expect(out).toContain('explanatory');
    expect(out).toContain('team-voice');
    expect(out).toContain('Team tone');
    setLocalePreference('en');
  });

  it('localizes the new builtin style descriptions in zh-CN', () => {
    setLocalePreference('zh-CN');
    const picker = new OutputStyleSelectorComponent({
      styles: [
        { name: 'reviewer', description: 'Code-review voice', source: 'builtin' },
        { name: 'debugger', description: 'Hypothesis-driven troubleshooting', source: 'builtin' },
        { name: 'teacher', description: 'Patient teaching voice', source: 'builtin' },
      ],
      currentValue: 'default',
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });
    const out = picker.render(60).join('\n');
    // The bundled styles added after explanatory resolve to zh-CN descriptions
    // through the same name-keyed map; English identifiers stay verbatim.
    expect(out).toContain(t('dialogs.outputStyle.builtin.reviewerDescription'));
    expect(out).toContain(t('dialogs.outputStyle.builtin.debuggerDescription'));
    expect(out).toContain(t('dialogs.outputStyle.builtin.teacherDescription'));
    expect(out).toContain('reviewer');
    expect(out).toContain('debugger');
    expect(out).toContain('teacher');
    expect(out).not.toContain('Code-review voice');
    setLocalePreference('en');
  });
});
