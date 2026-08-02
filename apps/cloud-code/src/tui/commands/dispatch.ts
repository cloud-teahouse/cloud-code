import type { Component, Focusable } from '@cloud-code/pi-tui';
import type { DeviceAuthorization } from '@cloud-code/oauth';
import type { EditorSlotHandle, EditorSlotMountOptions } from '../editor-slot';
import type { CloudCodeHarness, Session } from '@cloud-code/sdk';

import type { ColorToken, ThemeName } from '#/tui/theme';

import { LLM_NOT_SET_MESSAGE } from '../constant/cloud-code-tui';
import type { AuthFlowController } from '../controllers/auth-flow';
import type { BtwPanelController } from '../controllers/btw-panel';
import type { StreamingUIController } from '../controllers/streaming-ui';
import type { TasksBrowserController } from '../controllers/tasks-browser';
import type { WorkflowsBrowserController } from '../controllers/workflows-browser';
import type { TeamsBrowserController } from '../controllers/teams-browser';
import { tryHandleDanceCommand } from '../easter-eggs/dance';
import { resolveDescription, t, type LocalePreference } from '../i18n';
import type { ResolvedTheme } from '../theme/colors';
import type { TUIState } from '../tui-state';
import type {
  AppState,
  LoginProgressSpinnerHandle,
  QueuedMessage,
  StatusNoticeOptions,
  TranscriptEntry,
} from '../types';
import { formatErrorMessage } from '../utils/event-payload';
import { handleLoginCommand, handleLogoutCommand } from './auth';
import { handleBtwCommand } from './btw';
import { handleCopyCommand } from './copy';
import {
  handleAutoCommand,
  handleCompactCommand,
  handleEditorCommand,
  handleEffortCommand,
  handleLanguageCommand,
  handleModelCommand,
  handlePlanCommand,
  handleSecondaryModelCommand,
  handleThemeCommand,
  handleVimCommand,
  handleYoloCommand,
  showExperimentsPanel,
  showModelPicker,
  showPermissionPicker,
  showSettingsSelector,
} from './config';
import { handleGoalCommand } from './goal';
import { handleFastCommand } from './fast';
import { handleImportCommand } from './import';
import { handleFeedbackCommand, showMcpServers, showStatusReport, showUsage } from './info';
import { handleAddDirCommand } from './add-dir';
import { parseSlashInput } from './parse';
import { handlePluginsCommand } from './plugins';
import { handleOutputStyleCommand } from './output-style';
import { handleProviderCommand } from './provider';
import type { BuiltinSlashCommandName } from './registry';
import { handleReloadCommand, handleReloadTuiCommand } from './reload';
import { resolveSlashCommandInput, slashBusyMessage } from './resolve';
import { handleRewindCommand } from './rewind';
import { showSandboxStatus } from './sandbox';
import {
  handleExportDebugZipCommand,
  handleExportMdCommand,
  handleForkCommand,
  handleInitCommand,
  handleTitleCommand,
} from './session';
import { handleSwarmCommand } from './swarm';
import { handleCoordinatorCommand } from './coordinator';
import { handleUndoCommand } from './undo';
import { handleUpdateCommand } from './update';

// ---------------------------------------------------------------------------
// Re-exports — keep existing consumers working
// ---------------------------------------------------------------------------

export { handleLoginCommand, handleLogoutCommand } from './auth';
export { handleBtwCommand } from './btw';
export { handleCopyCommand } from './copy';
export { handleAddDirCommand } from './add-dir';
export {
  handleAutoCommand,
  handleCompactCommand,
  handleEditorCommand,
  handleEffortCommand,
  handleLanguageCommand,
  handleModelCommand,
  handlePlanCommand,
  handleSecondaryModelCommand,
  handleThemeCommand,
  handleYoloCommand,
  showModelPicker,
  showExperimentsPanel,
  showPermissionPicker,
  showSettingsSelector,
} from './config';
export { handleSwarmCommand } from './swarm';
export { handleCoordinatorCommand } from './coordinator';
export { handleFastCommand } from './fast';
export { handleFeedbackCommand, showMcpServers, showStatusReport, showUsage } from './info';
export { handlePluginsCommand } from './plugins';
export { handleImportCommand } from './import';
export { handleReloadCommand, handleReloadTuiCommand } from './reload';
export { handleGoalCommand } from './goal';
export {
  handleExportDebugZipCommand,
  handleExportMdCommand,
  handleForkCommand,
  handleInitCommand,
  handleTitleCommand,
} from './session';
export { handleUndoCommand } from './undo';
export { handleRewindCommand } from './rewind';
export { showSandboxStatus } from './sandbox';
export { handleUpdateCommand } from './update';

// ---------------------------------------------------------------------------
// Host interface
// ---------------------------------------------------------------------------

export interface SlashCommandHost {
  state: TUIState;
  session: Session | undefined;
  readonly harness: CloudCodeHarness;
  cancelInFlight: (() => void) | undefined;
  deferUserMessages: boolean;

  setAppState(patch: Partial<AppState>): void;
  resetLivePane(): void;
  showError(msg: string, options?: StatusNoticeOptions): void;
  showStatus(msg: string, color?: ColorToken, options?: StatusNoticeOptions): void;
  showNotice(title: string, detail?: string, options?: StatusNoticeOptions): void;
  appendTranscriptEntry(entry: TranscriptEntry): void;
  mountEditorReplacement(
    panel: Component & Focusable,
    options?: EditorSlotMountOptions,
  ): EditorSlotHandle;
  restoreEditor(handle?: EditorSlotHandle): void;
  restoreInputText(text: string): void;
  refreshSlashCommandAutocomplete(): void;

  // Session
  requireSession(): Session;
  switchToSession(session: Session, message: string): Promise<void>;
  reloadCurrentSessionView(session: Session, message: string): Promise<void>;
  beginSessionRequest(): void;
  failSessionRequest(message: string): void;
  sendQueuedMessage(session: Session, item: QueuedMessage): void;
  requestQueuedGoalPromotion?(): void;

  // UI
  showLoginProgressSpinner(label: string): LoginProgressSpinnerHandle;
  showLoginAuthorizationPrompt(auth: DeviceAuthorization): LoginProgressSpinnerHandle;
  showProgressSpinner(label: string): LoginProgressSpinnerHandle;

  // Theme
  applyTheme(theme: ThemeName, resolved?: ResolvedTheme): Promise<void>;
  refreshTerminalThemeTracking(): void;

  // Language
  applyLanguage(pref: LocalePreference): Promise<void>;

  // Dispatch
  stop(exitCode?: number): Promise<void>;
  setExitOpenUrl(url: string): void;
  /**
   * Register a task that takes over the process after the TUI has shut down
   * (instead of exiting): the runner awaits it and only exits when it returns.
   * Used by `/web` to keep a freshly started server attached to this terminal
   * until Ctrl+C.
   */
  setExitForegroundTask(task: (exitCode: number) => Promise<void>): void;
  showHelpPanel(): void;
  createNewSession(): Promise<void>;
  showSessionPicker(): Promise<void>;
  sendNormalUserInput(text: string): void;
  sendSkillActivation(session: Session, skillName: string, skillArgs: string): void;
  activatePluginCommand(
    session: Session,
    pluginId: string,
    commandName: string,
    args: string,
  ): void;
  readonly skillCommandMap: Map<string, string>;
  readonly pluginCommandMap: Map<string, string>;

  // Controller refs
  readonly streamingUI: StreamingUIController;
  readonly btwPanelController: BtwPanelController;
  readonly tasksBrowserController: TasksBrowserController;
  readonly workflowsBrowserController: WorkflowsBrowserController;
  readonly teamsBrowserController: TeamsBrowserController;
  readonly authFlow: AuthFlowController;
}

// ---------------------------------------------------------------------------
// Dispatch — entry point from handleUserInput
// ---------------------------------------------------------------------------

export function dispatchInput(host: SlashCommandHost, text: string): void {
  if (parseSlashInput(text) !== null) {
    void executeSlashCommand(host, text);
    return;
  }
  host.sendNormalUserInput(text);
}

async function executeSlashCommand(host: SlashCommandHost, input: string): Promise<void> {
  const parsedCommand = parseSlashInput(input);
  const intent = resolveSlashCommandInput({
    input,
    skillCommandMap: host.skillCommandMap,
    pluginCommandMap: host.pluginCommandMap,
    isStreaming: host.state.appState.streamingPhase !== 'idle',
    isCompacting: host.state.appState.isCompacting,
  });

  switch (intent.kind) {
    case 'not-command':
      return;
    case 'blocked':
      host.showError(slashBusyMessage(intent.commandName, intent.reason));
      return;
    case 'invalid':
      host.showError(t('commands.dispatch.invalid', { name: intent.commandName }));
      return;
    case 'skill': {
      const session = host.session;
      if (host.state.appState.model.trim().length === 0 || session === undefined) {
        host.showError(resolveDescription(LLM_NOT_SET_MESSAGE));
        return;
      }
      host.sendSkillActivation(session, intent.skillName, intent.args);
      return;
    }
    case 'plugin-command': {
      if (host.state.appState.model.trim().length === 0) {
        host.showError(resolveDescription(LLM_NOT_SET_MESSAGE));
        return;
      }
      const session = host.session;
      if (session === undefined) {
        host.showError(resolveDescription(LLM_NOT_SET_MESSAGE));
        return;
      }
      host.activatePluginCommand(session, intent.pluginId, intent.commandName, intent.args);
      return;
    }
    case 'message':
      // Unknown slash command: let /dance claim it before it falls through to
      // the model as a normal message. This runs *after* builtin and skill
      // resolution, so a real command or a same-named skill always wins.
      if (parsedCommand !== null && tryHandleDanceCommand(host, parsedCommand)) {
        return;
      }
      host.sendNormalUserInput(intent.input);
      return;
    case 'builtin':
      try {
        await handleBuiltInSlashCommand(host, intent.name, intent.args);
      } catch (error) {
        host.showError(formatErrorMessage(error));
      }
      return;
  }
}

async function handleBuiltInSlashCommand(
  host: SlashCommandHost,
  name: BuiltinSlashCommandName,
  args: string,
): Promise<void> {
  switch (name) {
    case 'exit':
      void host.stop();
      return;
    case 'help':
      host.showHelpPanel();
      return;
    case 'version':
      host.showStatus(t('commands.version.status', { version: host.state.appState.version }));
      return;
    case 'update':
      await handleUpdateCommand(host, args);
      return;
    case 'new':
      await host.createNewSession();
      host.state.ui.requestRender();
      return;
    case 'sessions':
      void host.showSessionPicker();
      return;
    case 'tasks':
      void host.tasksBrowserController.show();
      return;
    case 'workflows':
      host.workflowsBrowserController.show();
      return;
    case 'teams':
      host.teamsBrowserController.show();
      return;
    case 'mcp':
      void showMcpServers(host);
      return;
    case 'sandbox':
      void showSandboxStatus(host);
      return;
    case 'plugins':
      void handlePluginsCommand(host, args);
      return;
    case 'import':
      await handleImportCommand(host, args);
      return;
    case 'add-dir':
      await handleAddDirCommand(host, args);
      return;
    case 'experiments':
      await showExperimentsPanel(host);
      return;
    case 'reload':
      await handleReloadCommand(host);
      return;
    case 'reload-tui':
      await handleReloadTuiCommand(host);
      return;
    case 'editor':
      await handleEditorCommand(host, args);
      return;
    case 'vim':
      handleVimCommand(host);
      return;
    case 'theme':
      await handleThemeCommand(host, args);
      return;
    case 'language':
      await handleLanguageCommand(host, args);
      return;
    case 'output-style':
      await handleOutputStyleCommand(host, args);
      return;
    case 'model':
      await handleModelCommand(host, args);
      return;
    case 'secondary_model':
      await handleSecondaryModelCommand(host, args);
      return;
    case 'effort':
      await handleEffortCommand(host, args);
      return;
    case 'fast':
      await handleFastCommand(host, args);
      return;
    case 'provider':
      await handleProviderCommand(host);
      return;
    case 'permission':
      showPermissionPicker(host);
      return;
    case 'settings':
      showSettingsSelector(host);
      return;
    case 'usage':
      void showUsage(host);
      return;
    case 'status':
      void showStatusReport(host, args);
      return;
    case 'feedback':
      await handleFeedbackCommand(host);
      return;
    case 'btw':
      await handleBtwCommand(host, args);
      return;
    case 'title':
      await handleTitleCommand(host, args);
      return;
    case 'yolo':
      await handleYoloCommand(host, args);
      return;
    case 'auto':
      await handleAutoCommand(host, args);
      return;
    case 'plan':
      await handlePlanCommand(host, args);
      return;
    case 'swarm':
      await handleSwarmCommand(host, args);
      return;
    case 'coordinator':
      await handleCoordinatorCommand(host, args);
      return;
    case 'compact':
      await handleCompactCommand(host, args);
      return;
    case 'goal':
      await handleGoalCommand(host, args);
      return;
    case 'init':
      await handleInitCommand(host);
      return;
    case 'fork':
      await handleForkCommand(host, args);
      return;
    case 'export-md':
      await handleExportMdCommand(host, args);
      return;
    case 'export-debug-zip':
      await handleExportDebugZipCommand(host);
      return;
    case 'copy':
      await handleCopyCommand(host);
      return;
    case 'login':
      await handleLoginCommand(host);
      return;
    case 'logout':
      await handleLogoutCommand(host);
      return;
    case 'undo':
      await handleUndoCommand(host, args);
      return;
    case 'rewind':
      await handleRewindCommand(host, args);
      return;
    default:
      host.showError(t('commands.dispatch.unknown', { name: String(name) }));
      return;
  }
}
