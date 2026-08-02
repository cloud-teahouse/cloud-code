import { execSync, spawnSync } from 'node:child_process';

import {
  createCloudCodeHarness,
  flushDiagnosticLogsSync,
  log,
  resolveCloudCodeHome,
  setUserLanguage,
} from '@cloud-code/sdk';


import { CLI_UI_MODE } from '#/constant/app';
import type { TuiConfig } from '#/tui/config';
import { loadTuiConfig, TuiConfigParseError } from '#/tui/config';
import { CHROME_GUTTER } from '#/tui/constant/rendering';
import { setLocalePreference, t, userLanguageNameForModel } from '#/tui/i18n';
import { CloudCodeTUI } from '#/tui/index';
import { currentTheme, getColorPalette } from '#/tui/theme';
import { combineStartupNotice } from '#/tui/utils/startup';
import { toTerminalHyperlink } from '#/utils/terminal-hyperlink';
import { restoreTerminalModes } from '#/utils/terminal-restore';

import type { CLIOptions } from './options';
import { resolveAgentProfileSelection } from './agent-selection';
import { selectHarnessTransport } from './options';

import { createKimiCodeHostIdentity } from './version';

export async function runShell(
  opts: CLIOptions,
  version: string,
): Promise<void> {
  let tuiConfig: TuiConfig;
  let configWarning: string | undefined;
  try {
    tuiConfig = await loadTuiConfig();
  } catch (error) {
    if (!(error instanceof TuiConfigParseError)) throw error;
    tuiConfig = error.fallback;
    configWarning = error.message;
  }

  // Initialise the global Theme singleton before pi-tui grabs stdin.
  const palette = await getColorPalette(tuiConfig.theme);
  currentTheme.setPalette(palette);

  // Initialise the i18n singleton and hand the explicit UI-language
  // preference to the agent core (system-prompt `# Language` section).
  // Both are synchronous, in-memory — off the startup critical path.
  setLocalePreference(tuiConfig.language);
  setUserLanguage(userLanguageNameForModel(tuiConfig.language));

  const workDir = process.cwd();
  const harness = createCloudCodeHarness({
    homeDir: resolveCloudCodeHome(),
    identity: createKimiCodeHostIdentity(version),
    skillDirs: opts.skillsDirs,
    // `--server-stdio` / `--server <ws-url>` swap the in-process
    // core for the JSON-RPC protocol (spawned child or running daemon).
    transport: selectHarnessTransport(opts),
  });
  log.info('cloud-code starting', {

    version,
    uiMode: CLI_UI_MODE,
    nodeVersion: process.version,
    platform: `${process.platform}/${process.arch}`,
    workDir,
  });

  await harness.ensureConfigFile();
  for (const warning of (await harness.getConfigDiagnostics()).warnings) {
    configWarning = combineStartupNotice(configWarning, warning);
  }
  // Resolve --agent/--agent-file once for the startup session; validateOptions
  // has already rejected them alongside --session/--continue.
  const agentProfile = await resolveAgentProfileSelection(opts, workDir);
  const tui = new CloudCodeTUI(harness, {
    cliOptions: opts,
    agentProfile,
    additionalDirs: opts.addDirs?.length ? opts.addDirs : undefined,
    tuiConfig,
    version,
    workDir,
    startupNotice: configWarning,
  });

  let savedStty: string | undefined;
  try {
    // stty operates on the terminal behind stdin, so stdin must be the TTY —
    // piping /dev/null (ignore) makes stty fail with "not a tty".
    const saved = execSync('stty -g', {
      encoding: 'utf8',
      stdio: ['inherit', 'pipe', 'ignore'],
    });
    savedStty = typeof saved === 'string' ? saved.trim() : undefined;
    execSync('stty -ixon', { stdio: ['inherit', 'ignore', 'ignore'] });
  } catch {
    /* ignore */
  }
  const restoreStty = (): void => {
    if (savedStty === undefined) return;
    const args = savedStty.split(/\s+/).filter((arg) => arg.length > 0);
    if (args.length === 0) return;
    spawnSync('stty', args, { stdio: ['inherit', 'ignore', 'ignore'] });
  };

  // If we crash without going through CloudCodeTUI.stop(), the terminal is left in
  // raw mode with a hidden cursor and XON/XOFF flow control disabled. Restore
  // both before exiting so the user's shell is usable afterwards.
  const emergencyExit = (exitCode: number): void => {
    // The crash log above is only enqueued into the async sink; flush it
    // synchronously or the `process.exit()` below would drop the one line that
    // explains why we crashed. Best-effort: an exit path must never throw.
    try {
      flushDiagnosticLogsSync();
    } catch {
      /* ignore */
    }
    restoreTerminalModes();
    restoreStty();
    process.exit(exitCode);
  };
  const onUncaughtException = (error: unknown): void => {
    try {
      log.error('uncaughtException, restoring terminal and exiting', { error: String(error) });
    } catch {
      /* ignore */
    }
    emergencyExit(1);
  };
  const onUnhandledRejection = (reason: unknown): void => {
    try {
      log.error('unhandledRejection, restoring terminal and exiting', { reason: String(reason) });
    } catch {
      /* ignore */
    }
    emergencyExit(1);
  };
  process.on('uncaughtException', onUncaughtException);
  process.on('unhandledRejection', onUnhandledRejection);
  // Remove the crash handlers once the TUI exits cleanly so repeated runShell()
  // calls in the same process (e.g. tests) don't accumulate process listeners.
  const removeCrashHandlers = (): void => {
    process.off('uncaughtException', onUncaughtException);
    process.off('unhandledRejection', onUnhandledRejection);
  };

  tui.onExit = async (exitCode = 0) => {
    const sessionId = tui.getCurrentSessionId();
    const hasContent = tui.hasSessionContent();
    const gutter = ' '.repeat(CHROME_GUTTER);
    process.stdout.write(`${gutter}${t('status.exit.bye')}\n`);
    const hints: string[] = [];
    if (sessionId !== '' && hasContent) {
      hints.push(`${gutter}${t('status.exit.resume', { sessionId })}`);
    }
    if (tui.exitOpenUrl !== undefined) {
      hints.push(
        `${gutter}${t('status.exit.openUrl', { url: toTerminalHyperlink(tui.exitOpenUrl, tui.exitOpenUrl) })}`,
      );
    }
    if (hints.length > 0) {
      process.stderr.write(`\n${hints.join('\n')}\n`);
    }
    removeCrashHandlers();
    restoreStty();
    if (tui.exitForegroundTask !== undefined) {
      // `/web` starting a new server: the TUI has shut down cleanly; hand the
      // terminal to the foreground server instead of exiting. The task runs
      // until the server stops (Ctrl+C), then this process exits.
      await tui.exitForegroundTask(exitCode);
      return;
    }
    process.exit(exitCode);
  };
  try {
    await tui.start();
  } catch (error) {
    removeCrashHandlers();
    await harness.close();
    throw error;
  }
}
