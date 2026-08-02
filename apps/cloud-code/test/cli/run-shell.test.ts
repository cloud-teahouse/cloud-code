import { execSync } from 'node:child_process';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { runShell } from '#/cli/run-shell';

import { captureProcessWrite, ExitCalled, mockProcessExit } from '../helpers/process';

const mocks = vi.hoisted(() => {
  type TuiConfigFallback = {
    theme: 'dark' | 'light' | 'auto';
    editorCommand: string | null;
    notifications: { enabled: boolean; condition: 'unfocused' | 'always' };
  };

  class TuiConfigParseError extends Error {
    readonly fallback: TuiConfigFallback;

    constructor(fallback: TuiConfigFallback) {
      super('Invalid TUI config in ~/.cloud-code/tui.toml; using defaults.');
      this.fallback = fallback;
    }
  }

  return {
    loadTuiConfig: vi.fn(),
    detectTerminalTheme: vi.fn(),
    kimiHarnessConstructor: vi.fn(),
    kimiHarnessV2Constructor: vi.fn(),
    harnessEnsureConfigFile: vi.fn(),
    harnessGetConfig: vi.fn(async () => ({
      providers: {},
      defaultModel: 'k2',
    })),
    harnessGetConfigDiagnostics: vi.fn(async () => ({ warnings: [] as readonly string[] })),
    harnessClose: vi.fn(),
    kimiTuiConstructor: vi.fn(),
    tuiStart: vi.fn(),
    tuiGetCurrentSessionId: vi.fn(() => ''),
    tuiHasSessionContent: vi.fn(() => false),
    resolveCloudCodeHome: vi.fn((homeDir?: string) => homeDir ?? '/tmp/cloud-code-test-home'),
    flushDiagnosticLogsSync: vi.fn(),
    execSync: vi.fn(),
    TuiConfigParseError,
  };
});

vi.mock('@cloud-code/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cloud-code/sdk')>();
  return {
    ...actual,
    resolveCloudCodeHome: mocks.resolveCloudCodeHome,
    flushDiagnosticLogsSync: mocks.flushDiagnosticLogsSync,
    createCloudCodeHarness: (...args: unknown[]) => {
      const options = args[0] as { readonly homeDir?: string } | undefined;
      const homeDir = options?.homeDir ?? '/tmp/cloud-code-test-home';
      mocks.kimiHarnessConstructor(...args);
      return {
        homeDir,
        ensureConfigFile: mocks.harnessEnsureConfigFile,
        getConfig: mocks.harnessGetConfig,
        getConfigDiagnostics: mocks.harnessGetConfigDiagnostics,
        close: mocks.harnessClose,
      };
    },
  };
});

vi.mock('../../src/tui/config', () => ({
  loadTuiConfig: mocks.loadTuiConfig,
  TuiConfigParseError: mocks.TuiConfigParseError,
}));

vi.mock('../../src/tui/index', () => ({
  CloudCodeTUI: class {
    onExit?: () => Promise<void>;

    constructor(...args: unknown[]) {
      mocks.kimiTuiConstructor(this, ...args);
    }

    start = mocks.tuiStart;
    getCurrentSessionId = mocks.tuiGetCurrentSessionId;
    hasSessionContent = mocks.tuiHasSessionContent;
  },
}));

vi.mock('../../src/tui/theme/detect', () => ({
  detectTerminalTheme: mocks.detectTerminalTheme,
}));

vi.mock('node:child_process', () => ({
  execSync: mocks.execSync,
}));

describe('runShell', () => {
  afterEach(() => {
    vi.clearAllMocks();
    mocks.harnessGetConfig.mockResolvedValue({
      providers: {},
      defaultModel: 'k2',
    });
    mocks.tuiGetCurrentSessionId.mockReturnValue('');
    mocks.tuiHasSessionContent.mockReturnValue(false);
    mocks.resolveCloudCodeHome.mockImplementation(
      (homeDir?: string) => homeDir ?? '/tmp/cloud-code-test-home',
    );
  });

  it('constructs CloudCodeHarness and CloudCodeTUI with startup input', async () => {
    mocks.loadTuiConfig.mockResolvedValue({
      theme: 'dark',
      language: 'en',
      editorCommand: null,
      notifications: { enabled: true, condition: 'unfocused' },
    });
    mocks.tuiStart.mockResolvedValue(undefined);
    mocks.tuiGetCurrentSessionId.mockReturnValue('ses-startup');

    const cliOptions = {
      session: undefined,
      continue: false,
      yolo: true,
      auto: false,
      plan: true,
      model: undefined,
      outputFormat: undefined,
      prompt: undefined,
      skillsDirs: [],
      agent: undefined,
      agentFiles: [],
      addDirs: ['../shared', '/tmp/extra'],
    };

    await runShell(cliOptions, '1.2.3-test');

    expect(mocks.kimiHarnessConstructor).toHaveBeenCalledWith(
      expect.objectContaining({
        identity: expect.objectContaining({
          userAgentProduct: 'cloud-code-cli',
          version: '1.2.3-test',
        }),
      }),
    );
    expect(mocks.harnessEnsureConfigFile).toHaveBeenCalledOnce();
    expect(execSync).toHaveBeenCalledWith('stty -ixon', { stdio: ['inherit', 'ignore', 'ignore'] });
    expect(mocks.kimiTuiConstructor).toHaveBeenCalledTimes(1);

    const [, harness, startupInput] = mocks.kimiTuiConstructor.mock.calls[0]!;
    expect(harness).toBeTypeOf('object');
    expect(startupInput).toMatchObject({
      cliOptions,
      additionalDirs: ['../shared', '/tmp/extra'],
      tuiConfig: {
        theme: 'dark',
        editorCommand: null,
        notifications: { enabled: true, condition: 'unfocused' },
      },
      version: '1.2.3-test',
      workDir: process.cwd(),
    });
    expect(mocks.tuiStart).toHaveBeenCalledOnce();
  });

  it('resolves the --agent profile into the TUI startup input', async () => {
    mocks.loadTuiConfig.mockResolvedValue({
      theme: 'dark',
      editorCommand: null,
      notifications: { enabled: true, condition: 'unfocused' },
    });
    mocks.tuiStart.mockResolvedValue(undefined);

    await runShell(
      {
        session: undefined,
        continue: false,
        yolo: false,
        auto: false,
        plan: false,
        model: undefined,
        outputFormat: undefined,
        prompt: undefined,
        skillsDirs: [],
        agent: 'reviewer',
        agentFiles: [],
      },
      '1.2.3-test',
    );

    const [, , startupInput] = mocks.kimiTuiConstructor.mock.calls[0]!;
    expect(startupInput).toMatchObject({ agentProfile: 'reviewer' });
  });

  it('forwards skillsDirs from CLI options to the harness', async () => {
    mocks.loadTuiConfig.mockResolvedValue({
      theme: 'dark',
      language: 'en',
      editorCommand: null,
      notifications: { enabled: true, condition: 'unfocused' },
    });
    mocks.tuiStart.mockResolvedValue(undefined);

    await runShell(
      {
        session: undefined,
        continue: false,
        yolo: false,
        auto: false,
        plan: false,
        model: undefined,
        outputFormat: undefined,
        prompt: undefined,
        skillsDirs: ['/skills'],
        agent: undefined,
        agentFiles: [],
      },
      '1.2.3-test',
    );

    expect(mocks.kimiHarnessConstructor).toHaveBeenCalledWith(
      expect.objectContaining({ skillDirs: ['/skills'] }),
    );
  });

  it('detects auto theme and forwards config parse warnings as startup notice', async () => {
    mocks.loadTuiConfig.mockRejectedValue(
      new mocks.TuiConfigParseError({
        theme: 'auto',
        editorCommand: 'vim',
        notifications: { enabled: true, condition: 'always' },
      }),
    );
    mocks.detectTerminalTheme.mockResolvedValue('light');
    mocks.tuiStart.mockResolvedValue(undefined);

    await runShell(
      {
        session: '',
        continue: false,
        yolo: false,
        auto: false,
        plan: false,
        model: undefined,
        outputFormat: undefined,
        prompt: undefined,
        skillsDirs: [],
        agent: undefined,
        agentFiles: [],
      },
      '1.2.3-test',
    );

    expect(mocks.detectTerminalTheme).toHaveBeenCalledOnce();
    const [, , startupInput] = mocks.kimiTuiConstructor.mock.calls[0]!;
    expect(startupInput).toMatchObject({
      startupNotice: 'Invalid TUI config in ~/.cloud-code/tui.toml; using defaults.',
      tuiConfig: {
        theme: 'auto',
        editorCommand: 'vim',
        notifications: { enabled: true, condition: 'always' },
      },
    });
  });

  it('forwards config.toml diagnostics as startup notices', async () => {
    mocks.loadTuiConfig.mockResolvedValue({
      theme: 'dark',
      language: 'en',
      editorCommand: null,
      notifications: { enabled: true, condition: 'unfocused' },
    });
    mocks.harnessGetConfigDiagnostics.mockResolvedValue({
      warnings: ['Ignored invalid config in config.toml: loop_control.'],
    });
    mocks.tuiStart.mockResolvedValue(undefined);

    await runShell(
      {
        session: '',
        continue: false,
        yolo: false,
        auto: false,
        plan: false,
        model: undefined,
        outputFormat: undefined,
        prompt: undefined,
        skillsDirs: [],
        agent: undefined,
        agentFiles: [],
      },
      '1.2.3-test',
    );

    const [, , startupInput] = mocks.kimiTuiConstructor.mock.calls[0]!;
    expect(startupInput).toMatchObject({
      startupNotice: 'Ignored invalid config in config.toml: loop_control.',
    });
  });

  it('flushes diagnostic logs synchronously before exiting on a runtime crash', async () => {
    mocks.loadTuiConfig.mockResolvedValue({
      theme: 'dark',
      language: 'en',
      editorCommand: null,
      notifications: { enabled: true, condition: 'unfocused' },
    });
    mocks.tuiStart.mockResolvedValue(undefined);

    const processOnSpy = vi.spyOn(process, 'on');
    const stdout = captureProcessWrite('stdout');
    const exitSpy = mockProcessExit();

    try {
      await runShell(
        {
          session: undefined,
          continue: false,
          yolo: false,
          auto: false,
          plan: false,
          model: undefined,
          outputFormat: undefined,
          prompt: undefined,
          skillsDirs: [],
          agent: undefined,
          agentFiles: [],
        },
        '1.2.3-test',
      );

      const handler = processOnSpy.mock.calls.find(
        ([event]) => event === 'uncaughtException',
      )?.[1] as ((error: unknown) => void) | undefined;
      expect(handler).toBeDefined();

      // The async log sink cannot flush before process.exit() runs, so the
      // crash handler must force a synchronous flush or the crash reason is
      // lost (regression: uncaughtException logs never reached disk).
      expect(() => handler?.(new Error('boom'))).toThrow(ExitCalled);
      expect(mocks.flushDiagnosticLogsSync).toHaveBeenCalledOnce();
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(mocks.flushDiagnosticLogsSync.mock.invocationCallOrder[0]!).toBeLessThan(
        exitSpy.mock.invocationCallOrder[0]!,
      );
    } finally {
      processOnSpy.mockRestore();
      exitSpy.mockRestore();
      stdout.restore();
    }
  });

  it('flushes diagnostic logs synchronously before exiting on an unhandled rejection', async () => {
    mocks.loadTuiConfig.mockResolvedValue({
      theme: 'dark',
      language: 'en',
      editorCommand: null,
      notifications: { enabled: true, condition: 'unfocused' },
    });
    mocks.tuiStart.mockResolvedValue(undefined);

    const processOnSpy = vi.spyOn(process, 'on');
    const stdout = captureProcessWrite('stdout');
    const exitSpy = mockProcessExit();

    try {
      await runShell(
        {
          session: undefined,
          continue: false,
          yolo: false,
          auto: false,
          plan: false,
          model: undefined,
          outputFormat: undefined,
          prompt: undefined,
          skillsDirs: [],
          agent: undefined,
          agentFiles: [],
        },
        '1.2.3-test',
      );

      const handler = processOnSpy.mock.calls.find(
        ([event]) => event === 'unhandledRejection',
      )?.[1] as ((reason: unknown) => void) | undefined;
      expect(handler).toBeDefined();

      expect(() => handler?.(new Error('boom'))).toThrow(ExitCalled);
      expect(mocks.flushDiagnosticLogsSync).toHaveBeenCalledOnce();
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(mocks.flushDiagnosticLogsSync.mock.invocationCallOrder[0]!).toBeLessThan(
        exitSpy.mock.invocationCallOrder[0]!,
      );
    } finally {
      processOnSpy.mockRestore();
      exitSpy.mockRestore();
      stdout.restore();
    }
  });

  it('closes the harness when TUI startup fails', async () => {
    mocks.loadTuiConfig.mockResolvedValue({
      theme: 'dark',
      language: 'en',
      editorCommand: null,
      notifications: { enabled: true, condition: 'unfocused' },
    });
    mocks.tuiStart.mockRejectedValue(new Error('boom'));

    await expect(
      runShell(
        {
          session: undefined,
          continue: false,
          yolo: false,
          auto: false,
          plan: false,
          model: undefined,
          outputFormat: undefined,
          prompt: undefined,
          skillsDirs: [],
          agent: undefined,
          agentFiles: [],
        },
        '1.2.3-test',
      ),
    ).rejects.toThrow('boom');

    expect(mocks.harnessClose).toHaveBeenCalledOnce();
  });

  it('prints resume instructions from the TUI exit handler', async () => {
    mocks.loadTuiConfig.mockResolvedValue({
      theme: 'dark',
      language: 'en',
      editorCommand: null,
      notifications: { enabled: true, condition: 'unfocused' },
    });
    mocks.tuiStart.mockResolvedValue(undefined);
    mocks.tuiGetCurrentSessionId.mockReturnValue('ses-1');
    mocks.tuiHasSessionContent.mockReturnValue(true);

    const stdout = captureProcessWrite('stdout');
    const stderr = captureProcessWrite('stderr');
    const exitSpy = mockProcessExit();

    try {
      await runShell(
        {
          session: undefined,
          continue: false,
          yolo: false,
          auto: false,
          plan: false,
          model: undefined,
          outputFormat: undefined,
          prompt: undefined,
          skillsDirs: [],
          agent: undefined,
          agentFiles: [],
        },
        '1.2.3-test',
      );
      const [tui] = mocks.kimiTuiConstructor.mock.calls[0]!;

      await expect((tui as { onExit: () => Promise<void> }).onExit()).rejects.toBeInstanceOf(
        ExitCalled,
      );

      expect(stdout.text()).toBe(' Bye!\n');
      expect(stderr.text()).toContain(' To resume this session: cloudcode -r ses-1');
    } finally {
      exitSpy.mockRestore();
      stdout.restore();
      stderr.restore();
    }
  });

  it('prints the opened web URL from the TUI exit handler when set', async () => {
    mocks.loadTuiConfig.mockResolvedValue({
      theme: 'dark',
      language: 'en',
      editorCommand: null,
      notifications: { enabled: true, condition: 'unfocused' },
    });
    mocks.tuiStart.mockResolvedValue(undefined);
    mocks.tuiGetCurrentSessionId.mockReturnValue('ses-1');
    mocks.tuiHasSessionContent.mockReturnValue(true);

    const stdout = captureProcessWrite('stdout');
    const stderr = captureProcessWrite('stderr');
    const exitSpy = mockProcessExit();

    try {
      await runShell(
        {
          session: undefined,
          continue: false,
          yolo: false,
          auto: false,
          plan: false,
          model: undefined,
          outputFormat: undefined,
          prompt: undefined,
          skillsDirs: [],
          agent: undefined,
          agentFiles: [],
        },
        '1.2.3-test',
      );
      const [tui] = mocks.kimiTuiConstructor.mock.calls[0]!;
      const openedUrl = 'http://127.0.0.1:58627/sessions/ses-1#token=tok-1';
      (tui as { exitOpenUrl?: string }).exitOpenUrl = openedUrl;

      await expect((tui as { onExit: () => Promise<void> }).onExit()).rejects.toBeInstanceOf(
        ExitCalled,
      );

      expect(stderr.text()).toContain(' To resume this session: cloudcode -r ses-1');
      expect(stderr.text()).toContain('open ');
      expect(stderr.text()).toContain(openedUrl);
    } finally {
      exitSpy.mockRestore();
      stdout.restore();
      stderr.restore();
    }
  });
});
