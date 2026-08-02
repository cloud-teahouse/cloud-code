import { beforeEach, describe, expect, it, vi } from 'vitest';

import { dispatchInput } from '#/tui/commands/dispatch';
import { handleImportCommand } from '#/tui/commands/import';
import { findBuiltInSlashCommand, resolveSlashCommandAvailability } from '#/tui/commands/registry';
import { ChoicePickerComponent } from '#/tui/components/dialogs/choice-picker';
import { ImportSourceSelectorComponent } from '#/tui/components/dialogs/import-source-selector';
import { setLocalePreference, t } from '#/tui/i18n';
import type { KimiImportPlan } from '#/utils/import/types';

const mocks = vi.hoisted(() => ({
  resolveKimiSourceHome: vi.fn(() => '/mock-home/.kimi-code'),
  kimiSourceHomeExists: vi.fn(async () => true),
  buildKimiImportPlan: vi.fn(),
  applyKimiImportPlan: vi.fn(async (): Promise<unknown> => ({
    imported: { skills: 2, sessions: 1 },
    skipped: {},
    errors: [],
  })),
  countPlannedImports: vi.fn(() => 3),
  applyCredentialImport: vi.fn(async () => ({ imported: 1, errors: [] })),
}));

vi.mock('#/utils/import/kimi-import', async (importOriginal) => {
  const actual = await importOriginal<typeof import('#/utils/import/kimi-import')>();
  return {
    ...actual,
    resolveKimiSourceHome: mocks.resolveKimiSourceHome,
    kimiSourceHomeExists: mocks.kimiSourceHomeExists,
    buildKimiImportPlan: mocks.buildKimiImportPlan,
    applyKimiImportPlan: mocks.applyKimiImportPlan,
    countPlannedImports: mocks.countPlannedImports,
  };
});

vi.mock('#/utils/import/kimi-files', async (importOriginal) => {
  const actual = await importOriginal<typeof import('#/utils/import/kimi-files')>();
  return { ...actual, applyCredentialImport: mocks.applyCredentialImport };
});

function makePlan(overrides: Partial<KimiImportPlan> = {}) {
  return {
    plan: {
      sourceHome: '/mock-home/.kimi-code',
      targetHome: '/mock-home/.cloud-code',
      skills: [
        {
          name: 'skill-one',
          sourcePath: '/mock-home/.kimi-code/skills/skill-one',
          targetPath: '/mock-home/.cloud-code/skills/skill-one',
          kind: 'bundle' as const,
          action: 'import' as const,
        },
      ],
      sessions: [],
      inputHistory: [],
      credentials: [],
      blockers: [],
      ...overrides,
    },
    prepared: {},
  };
}

function makeHost(appState: Record<string, unknown> = {}) {
  const host = {
    state: {
      appState: {
        model: 'kimi-code/kimi-for-coding',
        streamingPhase: 'idle',
        isCompacting: false,
        ...appState,
      },
    },
    session: { id: 'session-1' },
    skillCommandMap: new Map<string, string>(),
    pluginCommandMap: new Map<string, string>(),
    mountEditorReplacement: vi.fn((_panel: unknown) => ({ id: 1 })),
    restoreEditor: vi.fn(),
    setAppState: vi.fn(),
    showStatus: vi.fn(),
    showError: vi.fn(),
    showNotice: vi.fn(),
    appendTranscriptEntry: vi.fn(),
    showProgressSpinner: vi.fn(() => ({ stop: vi.fn(), setLabel: vi.fn() })),
    sendSkillActivation: vi.fn(),
  };
  return host;
}

async function flushAsync(): Promise<void> {
  for (let i = 0; i < 30; i++) {
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
  }
}

const KEY_ENTER = '\r';
const KEY_DOWN = '[B';

beforeEach(() => {
  vi.clearAllMocks();
  setLocalePreference('en');
  mocks.kimiSourceHomeExists.mockResolvedValue(true);
  mocks.countPlannedImports.mockReturnValue(3);
  mocks.buildKimiImportPlan.mockResolvedValue(makePlan());
  mocks.applyKimiImportPlan.mockResolvedValue({
    imported: { skills: 2, sessions: 1 },
    skipped: {},
    errors: [],
  });
});

describe('/import registration', () => {
  it('registers as an idle-only builtin with the legacy skill name as alias', () => {
    const command = findBuiltInSlashCommand('import');
    expect(command).toBeDefined();
    expect(resolveSlashCommandAvailability(command!, '')).toBe('idle-only');
    expect(command!.aliases).toContain('import-from-cc-codex');
    // The old entry point resolves to the same builtin command.
    expect(findBuiltInSlashCommand('import-from-cc-codex')?.name).toBe('import');
  });
});

describe('/import source selection', () => {
  it('mounts the source selector when called without arguments', async () => {
    const host = makeHost();
    await handleImportCommand(host as never, '');
    expect(host.mountEditorReplacement).toHaveBeenCalledOnce();
    const panel = host.mountEditorReplacement.mock.calls[0]?.[0];
    expect(panel).toBeInstanceOf(ImportSourceSelectorComponent);
  });

  it('rejects an unknown source argument', async () => {
    const host = makeHost();
    await handleImportCommand(host as never, 'gitlab');
    expect(host.showError).toHaveBeenCalledWith(
      t('commands.import.unknownSource', { source: 'gitlab' }),
    );
    expect(host.mountEditorReplacement).not.toHaveBeenCalled();
  });

  it.each([
    ['claude', 'claude'],
    ['claude-code', 'claude'],
    ['codex', 'codex'],
    ['kimi-code', 'kimi'],
  ])('accepts %s as a source alias', async (arg, delegated) => {
    const host = makeHost();
    await handleImportCommand(host as never, arg);
    if (delegated === 'kimi') {
      expect(mocks.buildKimiImportPlan).toHaveBeenCalled();
    } else {
      expect(host.sendSkillActivation).toHaveBeenCalledWith(
        host.session,
        'import-from-cc-codex',
        delegated,
      );
    }
  });

  it('delegating via the picker: Enter on Claude Code activates the skill', async () => {
    const host = makeHost();
    await handleImportCommand(host as never, '');
    const panel = host.mountEditorReplacement.mock.calls[0]?.[0] as ImportSourceSelectorComponent;
    panel.handleInput(KEY_ENTER);
    await flushAsync();
    expect(host.restoreEditor).toHaveBeenCalled();
    expect(host.sendSkillActivation).toHaveBeenCalledWith(
      host.session,
      'import-from-cc-codex',
      'claude',
    );
  });
});

describe('/import claude|codex delegation', () => {
  it('refuses to delegate without a configured model', async () => {
    const host = makeHost({ model: '' });
    await handleImportCommand(host as never, 'claude');
    expect(host.sendSkillActivation).not.toHaveBeenCalled();
    expect(host.showError).toHaveBeenCalledOnce();
  });

  it('refuses to delegate without an active session', async () => {
    const host = makeHost();
    (host as { session?: unknown }).session = undefined;
    await handleImportCommand(host as never, 'codex');
    expect(host.sendSkillActivation).not.toHaveBeenCalled();
    expect(host.showError).toHaveBeenCalledOnce();
  });
});

describe('/import kimi deterministic flow', () => {
  it('reports a missing Kimi Code home', async () => {
    mocks.kimiSourceHomeExists.mockResolvedValue(false);
    const host = makeHost();
    await handleImportCommand(host as never, 'kimi');
    expect(host.showError).toHaveBeenCalledWith(
      t('commands.import.kimi.sourceMissing', { path: '/mock-home/.kimi-code' }),
    );
    expect(mocks.buildKimiImportPlan).not.toHaveBeenCalled();
  });

  it('shows the plan detail in the transcript and mounts the confirm picker', async () => {
    const host = makeHost();
    await handleImportCommand(host as never, 'kimi');
    await flushAsync();

    expect(host.appendTranscriptEntry).toHaveBeenCalledOnce();
    const entry = host.appendTranscriptEntry.mock.calls[0]?.[0] as { content: string };
    expect(entry.content).toContain(t('commands.import.detail.title'));
    expect(entry.content).toContain('/mock-home/.kimi-code');
    expect(entry.content).toContain('skill-one');

    expect(host.mountEditorReplacement).toHaveBeenCalledOnce();
    const panel = host.mountEditorReplacement.mock.calls[0]?.[0];
    expect(panel).toBeInstanceOf(ChoicePickerComponent);
  });

  it('applies without credentials after confirmation', async () => {
    const host = makeHost();
    await handleImportCommand(host as never, 'kimi');
    await flushAsync();
    const panel = host.mountEditorReplacement.mock.calls[0]?.[0] as ChoicePickerComponent;
    panel.handleInput(KEY_ENTER); // first option: Apply import
    await flushAsync();

    expect(mocks.applyKimiImportPlan).toHaveBeenCalledWith(
      expect.anything(),
      { includeCredentials: false, renameConflictingSkills: false },
    );
    expect(host.showNotice).toHaveBeenCalledWith(
      t('commands.import.kimi.done.title'),
      expect.stringContaining(t('commands.import.kimi.count.skills', { count: 2 })),
    );
    // No credentials in the plan -> no second picker.
    expect(host.mountEditorReplacement).toHaveBeenCalledOnce();
    expect(mocks.applyCredentialImport).not.toHaveBeenCalled();
  });

  it('offers a rename option for conflicting skills', async () => {
    mocks.buildKimiImportPlan.mockResolvedValue(
      makePlan({
        skills: [
          {
            name: 'dup',
            sourcePath: '/s/dup',
            targetPath: '/t/dup',
            kind: 'bundle',
            action: 'skip',
            skipReason: 'conflict',
            renameName: 'dup-kimi',
            renameTargetPath: '/t/dup-kimi',
          },
        ],
      }),
    );
    const host = makeHost();
    await handleImportCommand(host as never, 'kimi');
    await flushAsync();
    const panel = host.mountEditorReplacement.mock.calls[0]?.[0] as ChoicePickerComponent;
    const out = panel.render(100).join('\n');
    expect(out).toContain(t('selectors.import.confirm.applyRename.label'));

    // Move to the rename option and confirm.
    panel.handleInput(KEY_DOWN);
    panel.handleInput(KEY_ENTER);
    await flushAsync();
    expect(mocks.applyKimiImportPlan).toHaveBeenCalledWith(
      expect.anything(),
      { includeCredentials: false, renameConflictingSkills: true },
    );
  });

  it('asks about credentials only after a successful apply; yes copies them', async () => {
    mocks.buildKimiImportPlan.mockResolvedValue(
      makePlan({
        credentials: [
          {
            fileName: 'kimi-code.json',
            sourcePath: '/s/credentials/kimi-code.json',
            targetPath: '/t/credentials/kimi-code.json',
          },
        ],
      }),
    );
    const host = makeHost();
    await handleImportCommand(host as never, 'kimi');
    await flushAsync();
    // Confirm the main import.
    (host.mountEditorReplacement.mock.calls[0]?.[0] as ChoicePickerComponent).handleInput(KEY_ENTER);
    await flushAsync();

    // Credentials picker is the second mount; default selection is "No".
    expect(host.mountEditorReplacement).toHaveBeenCalledTimes(2);
    const credPicker = host.mountEditorReplacement.mock.calls[1]?.[0] as ChoicePickerComponent;
    const out = credPicker.render(110).join('\n');
    expect(out).toContain(t('selectors.import.credentials.title'));

    // Select "Yes, copy credentials".
    credPicker.handleInput(KEY_DOWN);
    credPicker.handleInput(KEY_ENTER);
    await flushAsync();
    expect(mocks.applyCredentialImport).toHaveBeenCalledOnce();
    // The main apply itself never touched credentials.
    expect(mocks.applyKimiImportPlan).toHaveBeenCalledWith(
      expect.anything(),
      { includeCredentials: false, renameConflictingSkills: false },
    );
  });

  it('declining the credentials picker copies nothing', async () => {
    mocks.buildKimiImportPlan.mockResolvedValue(
      makePlan({
        credentials: [
          {
            fileName: 'kimi-code.json',
            sourcePath: '/s/credentials/kimi-code.json',
            targetPath: '/t/credentials/kimi-code.json',
          },
        ],
      }),
    );
    const host = makeHost();
    await handleImportCommand(host as never, 'kimi');
    await flushAsync();
    (host.mountEditorReplacement.mock.calls[0]?.[0] as ChoicePickerComponent).handleInput(KEY_ENTER);
    await flushAsync();
    const credPicker = host.mountEditorReplacement.mock.calls[1]?.[0] as ChoicePickerComponent;
    credPicker.handleInput(KEY_ENTER); // "No (recommended)" is the default selection.
    await flushAsync();
    expect(mocks.applyCredentialImport).not.toHaveBeenCalled();
    expect(host.showStatus).toHaveBeenCalledWith(
      t('selectors.import.credentials.skipped'),
      'textMuted',
    );
  });

  it('reports when there is nothing new to import', async () => {
    mocks.countPlannedImports.mockReturnValue(0);
    const host = makeHost();
    await handleImportCommand(host as never, 'kimi');
    await flushAsync();
    expect(host.showNotice).toHaveBeenCalledWith(t('commands.import.kimi.nothingToImport'));
    expect(host.mountEditorReplacement).not.toHaveBeenCalled();
    expect(mocks.applyKimiImportPlan).not.toHaveBeenCalled();
  });

  it('credentials-only: says so explicitly and offers the opt-in picker directly', async () => {
    mocks.countPlannedImports.mockReturnValue(0);
    mocks.buildKimiImportPlan.mockResolvedValue(
      makePlan({
        credentials: [
          {
            fileName: 'kimi-code.json',
            sourcePath: '/s/credentials/kimi-code.json',
            targetPath: '/t/credentials/kimi-code.json',
          },
        ],
      }),
    );
    const host = makeHost();
    await handleImportCommand(host as never, 'kimi');
    await flushAsync();

    expect(host.showNotice).toHaveBeenCalledWith(t('commands.import.kimi.nothingButCredentials'));
    expect(mocks.applyKimiImportPlan).not.toHaveBeenCalled();
    // The credentials picker is mounted directly (no main apply first).
    expect(host.mountEditorReplacement).toHaveBeenCalledOnce();
    const credPicker = host.mountEditorReplacement.mock.calls[0]?.[0] as ChoicePickerComponent;
    credPicker.handleInput(KEY_DOWN);
    credPicker.handleInput(KEY_ENTER);
    await flushAsync();
    expect(mocks.applyCredentialImport).toHaveBeenCalledOnce();
  });

  it('shows the skipped tally and homedir notes in the result detail', async () => {
    mocks.applyKimiImportPlan.mockResolvedValue({
      imported: { skills: 1 },
      skipped: { skills: 2 },
      errors: [],
      notes: [{ sessionId: 'session_moved', unmatchedHomedirs: 1 }],
    });
    const host = makeHost();
    await handleImportCommand(host as never, 'kimi');
    await flushAsync();
    (host.mountEditorReplacement.mock.calls[0]?.[0] as ChoicePickerComponent).handleInput(KEY_ENTER);
    await flushAsync();

    const notice = host.showNotice.mock.calls.find(
      (call) => call[0] === t('commands.import.kimi.done.title'),
    );
    expect(notice).toBeDefined();
    const detail = notice?.[1] as string;
    expect(detail).toContain(t('commands.import.kimi.done.skippedSummary', { count: 2 }));
    expect(detail).toContain('session_moved');
    expect(detail).toContain(t('commands.import.kimi.done.reloadHint'));
  });

  it('shows the snapshot/format notes in the confirm picker notice', async () => {
    const host = makeHost();
    await handleImportCommand(host as never, 'kimi');
    await flushAsync();
    const panel = host.mountEditorReplacement.mock.calls[0]?.[0] as ChoicePickerComponent;
    const out = panel.render(110).join('\n');
    expect(out).toContain(t('selectors.import.confirm.tomlNote'));
    expect(out).toContain(t('selectors.import.confirm.snapshotNote'));
  });

  it('surfaces blockers in the confirm picker notice', async () => {
    mocks.buildKimiImportPlan.mockResolvedValue(
      makePlan({ blockers: ['/mock-home/.cloud-code/config.toml: bad TOML'] }),
    );
    const host = makeHost();
    await handleImportCommand(host as never, 'kimi');
    await flushAsync();
    const panel = host.mountEditorReplacement.mock.calls[0]?.[0] as ChoicePickerComponent;
    const out = panel.render(110).join('\n');
    expect(out).toContain('config.toml');
  });
});

describe('/import dispatch routing', () => {
  it('routes /import kimi through dispatchInput into the engine', async () => {
    const host = makeHost();
    dispatchInput(host as never, '/import kimi');
    await flushAsync();
    expect(mocks.buildKimiImportPlan).toHaveBeenCalled();
  });

  it('routes the legacy /import-from-cc-codex alias to the new command', async () => {
    const host = makeHost();
    dispatchInput(host as never, '/import-from-cc-codex');
    await flushAsync();
    expect(host.mountEditorReplacement).toHaveBeenCalledOnce();
    expect(host.mountEditorReplacement.mock.calls[0]?.[0]).toBeInstanceOf(
      ImportSourceSelectorComponent,
    );
  });

  it('is blocked while streaming', async () => {
    const host = makeHost({ streamingPhase: 'streaming' });
    dispatchInput(host as never, '/import');
    await flushAsync();
    expect(host.showError).toHaveBeenCalledOnce();
    expect(host.mountEditorReplacement).not.toHaveBeenCalled();
  });
});
