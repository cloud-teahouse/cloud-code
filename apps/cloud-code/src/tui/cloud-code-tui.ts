import type { DeviceAuthorization } from '@cloud-code/oauth';
import { log, setUserLanguage } from '@cloud-code/sdk';

import type {
  ApprovalRequest,
  ApprovalResponse,
  BackgroundTaskInfo,
  CreateSessionOptions,
  CloudCodeHarness,
  PermissionMode,
  PromptPart,
  Session,
} from '@cloud-code/sdk';

import {
  deleteAllKittyImages,
  type AutocompleteItem,
  type Component,
  type Focusable,
  getCapabilities,
  type OverlayHandle,
  Spacer,
} from '@cloud-code/pi-tui';
import { resolve } from 'pathe';

import type { CLIOptions } from '#/cli/options';
import { copyTextToClipboard } from '#/utils/clipboard/clipboard-text';
import { appendInputHistory, loadInputHistory } from '#/utils/history/input-history';
import { openUrl } from '#/utils/open-url';
import { getInputHistoryFile } from '#/utils/paths';
import { detectFdPath, ensureFdPath } from '#/utils/process/fd-detect';
import { quoteShellArg } from '#/utils/shell-quote';
import { restoreTerminalModes } from '#/utils/terminal-restore';

import { BannerProvider } from './banner/banner-provider';
import { readBannerDisplayState, writeBannerDisplayState } from './banner/state';
import {
  BUILTIN_SLASH_COMMANDS,
  buildPluginSlashCommands,
  buildSkillSlashCommands,
  isExperimentalFlagEnabled,
  setExperimentalFeatures,
  sortSlashCommands,
  type CloudCodeSlashCommand,
  type SkillListSession,
} from './commands';
import * as slashCommands from './commands/dispatch';
import { BannerComponent } from './components/chrome/banner';
import { DeviceCodeBoxComponent } from './components/chrome/device-code-box';
import { FloatingDialogSurface } from './components/chrome/floating-dialog-surface';
import { GutterContainer } from './components/chrome/gutter-container';
import { TakeoverNoticeMirror } from './components/chrome/takeover-notice-mirror';
import { MoonLoader, type SpinnerStyle } from './components/chrome/moon-loader';
import { WelcomeComponent } from './components/chrome/welcome';
import { pickRandomWorkingTip } from './components/chrome/working-tips';
import {
  ApprovalPanelComponent,
  type ApprovalPanelResponse,
} from './components/dialogs/approval-panel';
import {
  ApprovalPreviewViewer,
  type ApprovalPreviewBlock,
} from './components/dialogs/approval-preview';
import { CompactionComponent } from './components/dialogs/compaction';
import { HelpPanelComponent, VIM_NORMAL_SHORTCUTS } from './components/dialogs/help-panel';
import { QuestionDialogComponent } from './components/dialogs/question-dialog';
import { SessionPickerComponent, type SessionRow } from './components/dialogs/session-picker';
import {
  FileMentionProvider,
  type SlashAutocompleteCommand,
} from './components/editor/file-mention-provider';
import { AssistantMessageComponent } from './components/messages/assistant-message';
import { BackgroundAgentStatusComponent } from './components/messages/background-agent-status';
import { CronMessageComponent } from './components/messages/cron-message';
import { buildGoalMarker } from './components/messages/goal-markers';
import {
  GoalCompletionMessageComponent,
  GoalSetMessageComponent,
} from './components/messages/goal-panel';
import { PluginCommandComponent } from './components/messages/plugin-command';
import { ShellRunComponent } from './components/messages/shell-run';
import { SkillActivationComponent } from './components/messages/skill-activation';
import {
  NoticeMessageComponent,
  StatusMessageComponent,
} from './components/messages/status-message';
import { StepSummaryComponent } from './components/messages/step-summary';
import { ThinkingComponent } from './components/messages/thinking';
import { ToolCallComponent } from './components/messages/tool-call';
import {
  ReplayTurnBoundaryComponent,
  UserMessageComponent,
} from './components/messages/user-message';
import { ActivityPaneComponent, type ActivityPaneMode } from './components/panes/activity-pane';
import { QueuePaneComponent } from './components/panes/queue-pane';
import type { TuiConfig } from './config';
import {
  LLM_NOT_SET_MESSAGE,
  MAIN_AGENT_ID,
  NO_ACTIVE_SESSION_MESSAGE,
  PRODUCT_NAME,
} from './constant/cloud-code-tui';
import { CHROME_GUTTER } from './constant/rendering';
import { MAX_TERMINAL_TITLE_LENGTH } from './constant/terminal';
import { AuthFlowController } from './controllers/auth-flow';
import { BtwPanelController } from './controllers/btw-panel';
import { ClipboardImageHintController } from './controllers/clipboard-image-hint';
import { EditorKeyboardController } from './controllers/editor-keyboard';
import { SessionEventHandler, type InterruptRecall } from './controllers/session-event-handler';
import { SessionReplayRenderer } from './controllers/session-replay';
import { StreamingUIController } from './controllers/streaming-ui';
import { TasksBrowserController } from './controllers/tasks-browser';
import { WorkflowsBrowserController } from './controllers/workflows-browser';
import type { WorkflowTracker } from './controllers/workflows-tracker';
import { TeamsBrowserController } from './controllers/teams-browser';
import type { TeamTracker } from './controllers/teams-tracker';
import { installRainbowDance } from './easter-eggs/dance';
import {
  resolveDescription,
  setLocalePreference,
  t,
  userLanguageNameForModel,
  type LocalePreference,
} from './i18n';
import {
  formatKeybindingConflict,
  formatUserKeybindingWarning,
  getKeybindingsFile,
  loadUserKeybindings,
} from './keybindings/loader';
import { installAppKeybindings } from './keybindings/manager';
import { adaptPanelResponse } from './reverse-rpc/approval/adapter';
import { ApprovalController } from './reverse-rpc/approval/controller';
import { createApprovalRequestHandler } from './reverse-rpc/approval/handler';
import { registerReverseRPCHandlers } from './reverse-rpc/index';
import { QuestionController } from './reverse-rpc/question/controller';
import { createQuestionAskHandler } from './reverse-rpc/question/handler';
import type { ApprovalPanelData, QuestionPanelData } from './reverse-rpc/types';
import { currentTheme, getColorPalette, getBuiltInPalette, isBuiltInTheme } from './theme';
import type { ColorToken, ResolvedTheme, ThemeName } from './theme';
import { createTUIState, type TUIState } from './tui-state';
import {
  INITIAL_LIVE_PANE,
  type AppState,
  type CloudCodeTUIOptions,
  type LivePaneState,
  type LoginProgressSpinnerHandle,
  type QueuedMessage,
  type SteerInputItem,
  type StatusNoticeOptions,
  type TranscriptEntry,
  type TUIStartupOptions,
  type TUIStartupState,
} from './types';
import { hasDispose, isClickExpandable, isExpandable } from './utils/component-capabilities';
import { isDeadTerminalError } from './utils/dead-terminal';
import { formatErrorMessage } from './utils/event-payload';
import { pickForegroundTasks } from './utils/foreground-task';
import { ImageAttachmentStore, type ImageAttachment } from './utils/image-attachment-store';
import { extractMediaAttachments, rewriteMediaPlaceholders } from './utils/image-placeholder';
import { REPLAY_TURN_LIMIT } from './utils/message-replay';
import { hasPatchChanges } from './utils/object-patch';
import { planSessionTitleFromPlan } from './utils/plan-session-title';
import { sessionRowsForPicker } from './utils/session-picker-rows';
import { formatBashOutputForDisplay } from './utils/shell-output';
import { combineStartupNotice, isOAuthLoginRequiredError } from './utils/startup';
import { installTerminalFocusTracking } from './utils/terminal-focus';
import { notifyTerminalOnce } from './utils/terminal-notification';
import { installTerminalThemeTracking } from './utils/terminal-theme';
import { detectTmuxKeyboardWarning } from './utils/tmux-keyboard';
import type { EditorSlotHandle, EditorSlotKind, EditorSlotMountOptions } from './editor-slot';
import {
  getTranscriptComponentEntry,
  markTranscriptComponent,
} from './utils/transcript-component-metadata';
import { nextTranscriptId } from './utils/transcript-id';
import {
  TRANSCRIPT_EXPAND_TURNS,
  TRANSCRIPT_HYSTERESIS,
  TRANSCRIPT_KEEP_RECENT_ASSISTANT,
  TRANSCRIPT_KEEP_RECENT_ASSISTANT_COMPLETED,
  TRANSCRIPT_KEEP_RECENT_STEPS,
  TRANSCRIPT_MAX_TURNS,
  TRANSCRIPT_WINDOW_ENABLED,
  groupTurns,
  turnsToTrim,
} from './utils/transcript-window';

export type { TUIState } from './tui-state';
export { createTUIState } from './tui-state';
export type {
  CloudCodeTUIOptions,
  LoginProgressSpinnerHandle,
  TUIStartupOptions,
  TUIStartupState,
} from './types';

export interface CloudCodeTUIStartupInput {
  readonly cliOptions: CLIOptions;
  /** Profile name resolved from cliOptions --agent/--agent-file (see resolveAgentProfileSelection). */
  readonly agentProfile?: string;
  readonly additionalDirs?: readonly string[];
  readonly tuiConfig: TuiConfig;
  readonly version: string;
  readonly workDir: string;
  readonly startupNotice?: string;

}

type EffectiveActivityPaneMode = ActivityPaneMode | 'idle' | 'session';
type LoadingTipKind = 'moon' | 'composing';

function loadingTipKind(mode: EffectiveActivityPaneMode): LoadingTipKind | undefined {
  if (mode === 'waiting' || mode === 'tool') return 'moon';
  if (mode === 'composing') return 'composing';
  return undefined;
}

function sameStringArrays(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * Resolve i18n keys carried in argument-completion descriptions (builtin
 * subcommand specs) at materialization time; plain-text descriptions
 * (directory paths, plugin-provided text) pass through unchanged.
 */
function resolveAutocompleteDescriptions(
  items: AutocompleteItem[] | null,
): AutocompleteItem[] | null {
  return (
    items?.map((item) =>
      item.description === undefined
        ? item
        : { ...item, description: resolveDescription(item.description) },
    ) ?? null
  );
}

/** Working-tip constants hold i18n keys; resolve for display. */
function resolveTipText(tip: string | undefined): string | undefined {
  return tip === undefined ? undefined : resolveDescription(tip);
}

type MutableCreateSessionOptions = {
  -readonly [P in keyof CreateSessionOptions]: CreateSessionOptions[P];
};

function createInitialAppState(input: CloudCodeTUIStartupInput): AppState {
  const startupPermission: PermissionMode = input.cliOptions.auto
    ? 'auto'
    : input.cliOptions.yolo
      ? 'yolo'
      : 'manual';
  return {
    model: '',
    workDir: input.workDir,
    additionalDirs: [...(input.additionalDirs ?? [])],
    sessionId: '',
    permissionMode: startupPermission,
    planMode: input.cliOptions.plan,
    inputMode: 'prompt',
    swarmMode: false,
    coordinatorMode: false,
    thinkingEffort: 'off',
    serviceTier: null,
    contextUsage: 0,
    contextTokens: 0,
    maxContextTokens: 0,
    isCompacting: false,
    isReplaying: false,
    streamingPhase: 'idle',
    streamingStartTime: 0,
    theme: input.tuiConfig.theme,
    language: input.tuiConfig.language,
    version: input.version,
    editorCommand: input.tuiConfig.editorCommand,
    disablePasteBurst: input.tuiConfig.disablePasteBurst,
    fullscreen: input.tuiConfig.fullscreen,
    vimMode: input.tuiConfig.vimMode ? 'INSERT' : null,
    notifications: input.tuiConfig.notifications,
    upgrade: input.tuiConfig.upgrade,
    statusLine: input.tuiConfig.statusLine,
    availableModels: {},
    availableProviders: {},
    sessionTitle: null,
    goal: null,
    mcpServersSummary: null,
    banner: undefined,
  };
}

interface SendMessageOptions {
  readonly parts?: readonly PromptPart[];
  readonly imageAttachmentIds?: readonly number[];
  readonly hasMedia?: boolean;
}

/**
 * Flatten steer items into the payload `session.steer` expects: the
 * historical `'\n\n'`-joined string when nothing carries media, or a
 * merged part list when any item has extracted media parts (queued image
 * messages, or the editor draft after placeholder extraction).
 *
 * Items are separated by the historical `'\n\n'`, which merges into the
 * adjacent text part. The one exception is two touching media parts: a
 * standalone `{type:'text',text:'\n\n'}` between them would be rejected
 * by `normalizePromptInput` as an empty text part, so the separator is
 * dropped there (media parts are self-delimiting anyway).
 */
function combineSteerInput(items: readonly SteerInputItem[]): string | PromptPart[] {
  const hasMedia = items.some((item) => item.parts !== undefined && item.parts.length > 0);
  if (!hasMedia) return items.map((item) => item.text).join('\n\n');
  const parts: PromptPart[] = [];
  for (const item of items) {
    const startsWithMedia =
      item.parts !== undefined && item.parts.length > 0 && item.parts[0]?.type !== 'text';
    const lastIsMedia = parts.length > 0 && parts.at(-1)?.type !== 'text';
    if (parts.length > 0 && !(lastIsMedia && startsWithMedia)) {
      appendSteerText(parts, '\n\n');
    }
    if (item.parts !== undefined && item.parts.length > 0) {
      for (const part of item.parts) {
        if (part.type === 'text') appendSteerText(parts, part.text);
        else parts.push(part);
      }
    } else {
      appendSteerText(parts, item.text);
    }
  }
  return parts;
}

function appendSteerText(parts: PromptPart[], text: string): void {
  const last = parts.at(-1);
  if (last?.type === 'text') {
    parts[parts.length - 1] = { type: 'text', text: last.text + text };
    return;
  }
  parts.push({ type: 'text', text });
}

/** How long the one-shot "moved to background" footer hint stays visible. */
const DETACH_HINT_DISPLAY_MS = 4_000;

/**
 * How long a transient notice at the top of the slot stays visible before it
 * auto-clears. Recorded notices (`transcript: true`) are unaffected — they
 * scroll with the message flow by design.
 */
const NOTICE_DISPLAY_MS = 8_000;

/** Ticks per second for the transient-notice countdown gauge. */
const NOTICE_COUNTDOWN_TICK_MS = 500;

/** Notices that can render their remaining lifetime as a shrinking gauge. */
function hasNoticeCountdown(
  component: Component,
): component is Component & { setCountdown(remaining: number | undefined): void } {
  return typeof (component as { setCountdown?: unknown }).setCountdown === 'function';
}

export class CloudCodeTUI {
  readonly harness: CloudCodeHarness;
  readonly options: CloudCodeTUIOptions;
  session: Session | undefined;
  state: TUIState;
  private readonly approvalController = new ApprovalController();
  private readonly questionController = new QuestionController();
  private readonly reverseRpcDisposers: Array<() => void> = [];
  private skillCommands: readonly CloudCodeSlashCommand[] = [];
  readonly skillCommandMap = new Map<string, string>();
  private pluginCommands: readonly CloudCodeSlashCommand[] = [];
  readonly pluginCommandMap = new Map<string, string>();
  private readonly imageStore = new ImageAttachmentStore();
  private fdPath: string | null = detectFdPath();
  private fdDownloadStarted = false;
  sessionEventUnsubscribe: (() => void) | undefined;
  cancelInFlight: (() => void) | undefined;
  deferUserMessages = false;
  aborted = false;
  private terminalFocusTrackingDispose: (() => void) | undefined;
  private terminalThemeTrackingDispose: (() => void) | undefined;
  private clipboardImageHintController: ClipboardImageHintController | undefined;
  private uninstallRainbowDance: () => void;
  private signalCleanupHandlers: Array<() => void> = [];
  private isShuttingDown = false;
  private backgroundRefreshPromise: Promise<void> | undefined;

  private startupNotice: string | undefined;
  private lastActivityMode: string | undefined;
  private currentLoadingTip: { kind: LoadingTipKind; tip: string | undefined } | undefined =
    undefined;
  private lastHistoryContent: string | undefined;
  /**
   * T4 optimistic echo: transcript-entry id of the user bubble appended by
   * the latest `sendMessageInternal`, pending confirmation. Cleared by
   * `confirmUserEcho` (the session's `prompt.submitted` event) or by
   * `removePendingUserEcho` when the prompt call fails.
   */
  private pendingUserEchoId: string | undefined;
  // Live `!` shell output entries, keyed by commandId so concurrent commands
  // each update their own card and stale events are dropped. Mutated in place
  // as `shell.output` events arrive; removed when the command completes.
  // `taskId` (from `shell.started`) lets ctrl+b detach the exact task.
  private readonly shellOutputStreams = new Map<
    string,
    { entry: TranscriptEntry; component: ShellRunComponent; taskId?: string }
  >();
  readonly streamingUI: StreamingUIController;
  readonly authFlow: AuthFlowController;
  readonly btwPanelController: BtwPanelController;
  readonly sessionEventHandler: SessionEventHandler;
  readonly sessionReplay: SessionReplayRenderer;
  readonly tasksBrowserController: TasksBrowserController;
  readonly workflowsBrowserController: WorkflowsBrowserController;
  readonly teamsBrowserController: TeamsBrowserController;
  readonly editorKeyboard: EditorKeyboardController;

  /** Timer that auto-clears the one-shot "moved to background" footer hint. */
  private detachHintClearTimer: ReturnType<typeof setTimeout> | undefined;
  private noticeClearTimer: ReturnType<typeof setTimeout> | undefined;
  private noticeCountdownInterval: ReturnType<typeof setInterval> | undefined;

  // The currently-mounted approval panel, if any. Kept so the full-screen
  // preview viewer can restore focus to the exact same instance (and its
  // selection / feedback state) when it closes.
  private activeApprovalPanel: ApprovalPanelComponent | undefined;
  // Active full-screen approval preview. While set, the root UI's normal
  // children are stashed in `savedChildren`; closing restores them.
  private approvalPreview:
    | {
        component: ApprovalPreviewViewer;
        savedChildren: readonly Component[];
        panel: ApprovalPanelComponent;
      }
    | undefined;

  public onExit?: (exitCode?: number) => Promise<void>;

  /** URL opened in the browser just before exit (e.g. by `/web`); printed by onExit. */
  public exitOpenUrl: string | undefined;

  /**
   * Task that takes over the process after the TUI shuts down, instead of
   * exiting (`/web` starting a new server: the server keeps this terminal
   * attached until Ctrl+C). Set via {@link setExitForegroundTask}.
   */
  public exitForegroundTask: ((exitCode: number) => Promise<void>) | undefined;

  constructor(harness: CloudCodeHarness, startupInput: CloudCodeTUIStartupInput) {
    this.harness = harness;
    const tuiOptions: CloudCodeTUIOptions = {
      initialAppState: createInitialAppState(startupInput),
      startup: {
        sessionFlag: startupInput.cliOptions.session,
        continueLast: startupInput.cliOptions.continue,
        yolo: startupInput.cliOptions.yolo,
        auto: startupInput.cliOptions.auto,
        plan: startupInput.cliOptions.plan,
        model: startupInput.cliOptions.model,
        agentProfile: startupInput.agentProfile,
        agentFiles: startupInput.cliOptions.agentFiles,
        startupNotice: startupInput.startupNotice,
      },
    };
    this.options = tuiOptions;

    this.startupNotice = startupInput.startupNotice;

    // Install the merged (pi-tui + app.chat) keybindings manager with the
    // user's keybindings.json applied on top. Runs before createTUIState so
    // CustomEditor's ensureAppKeybindings() sees the user-aware manager.
    // Load/validation problems and conflicts degrade to a startup notice.
    const userKeybindings = loadUserKeybindings();
    const keybindings = installAppKeybindings(userKeybindings.bindings);
    const keybindingsFile = getKeybindingsFile();
    const keybindingWarnings = [
      ...userKeybindings.warnings.map((warning) =>
        formatUserKeybindingWarning(warning, keybindingsFile),
      ),
      ...keybindings.getConflicts().map((conflict) =>
        formatKeybindingConflict(conflict, keybindingsFile),
      ),
    ];
    if (keybindingWarnings.length > 0) {
      this.startupNotice = combineStartupNotice(this.startupNotice, keybindingWarnings.join('\n'));
    }

    this.state = createTUIState(tuiOptions);
    this.uninstallRainbowDance = installRainbowDance(() => {
      this.state.ui.requestRender();
    });

    this.reverseRpcDisposers.push(
      ...registerReverseRPCHandlers(this.approvalController, this.questionController, {
        showApprovalPanel: (payload) => {
          this.showApprovalPanel(payload);
        },
        hideApprovalPanel: () => {
          this.hideApprovalPanel();
        },
        showQuestionDialog: (payload) => {
          this.showQuestionDialog(payload);
        },
        hideQuestionDialog: () => {
          this.hideQuestionDialog();
        },
      }),
    );
    this.streamingUI = new StreamingUIController(this);
    this.authFlow = new AuthFlowController(this);
    this.btwPanelController = new BtwPanelController(this);
    this.sessionEventHandler = new SessionEventHandler(this);
    this.sessionReplay = new SessionReplayRenderer(this);
    this.tasksBrowserController = new TasksBrowserController(this);
    this.workflowsBrowserController = new WorkflowsBrowserController(this);
    this.teamsBrowserController = new TeamsBrowserController(this);
    this.editorKeyboard = new EditorKeyboardController(this, this.imageStore);
    this.editorKeyboard.install();
    this.buildLayout();
  }

  // =========================================================================
  // Autocomplete & Skill Commands
  // =========================================================================

  private getSlashCommands(): readonly CloudCodeSlashCommand[] {
    const builtins = sortSlashCommands(BUILTIN_SLASH_COMMANDS).filter((command) =>
      isExperimentalFlagEnabled(command.experimentalFlag),
    );
    return [...builtins, ...this.skillCommands, ...this.pluginCommands];
  }

  private setupAutocomplete(): void {
    const slashCommands: SlashAutocompleteCommand[] = this.getSlashCommands().map((cmd) => {
      const completer = cmd.completeArgs;
      return {
        name: cmd.name,
        aliases: cmd.aliases,
        // Builtin descriptions and argument hints are i18n keys; plugin/skill
        // text passes through.
        description: resolveDescription(cmd.description),
        ...(cmd.argumentHint !== undefined
          ? { argumentHint: resolveDescription(cmd.argumentHint) }
          : {}),
        ...(completer !== undefined
          ? { getArgumentCompletions: (prefix: string) => resolveAutocompleteDescriptions(completer(prefix)) }
          : {}),
      };
    });
    const provider = new FileMentionProvider(
      slashCommands,
      this.state.appState.workDir,
      this.fdPath,
      this.state.appState.additionalDirs,
      () => this.state.appState.inputMode,
    );
    this.state.editor.setAutocompleteProvider(provider);

    const argumentHints = new Map<string, string>();
    for (const cmd of slashCommands) {
      if (cmd.argumentHint === undefined) continue;
      argumentHints.set(cmd.name, cmd.argumentHint);
      for (const alias of cmd.aliases ?? []) {
        argumentHints.set(alias, cmd.argumentHint);
      }
    }
    this.state.editor.setArgumentHints(argumentHints);
  }

  refreshSlashCommandAutocomplete(): void {
    this.setupAutocomplete();
  }

  async refreshSkillCommands(session?: SkillListSession): Promise<void> {
    if (session === undefined) {
      this.skillCommands = [];
      this.skillCommandMap.clear();
      this.setupAutocomplete();
      return;
    }

    let skills;
    try {
      skills = await session.listSkills();
    } catch {
      return;
    }
    const skillCommands = buildSkillSlashCommands(skills);
    this.skillCommands = skillCommands.commands;
    this.skillCommandMap.clear();
    for (const [commandName, skillName] of skillCommands.commandMap) {
      this.skillCommandMap.set(commandName, skillName);
    }
    this.setupAutocomplete();
  }

  async refreshPluginCommands(session?: Session): Promise<void> {
    if (session === undefined) {
      this.pluginCommands = [];
      this.pluginCommandMap.clear();
      this.setupAutocomplete();
      return;
    }

    let defs;
    try {
      defs = await session.listPluginCommands();
    } catch {
      return;
    }
    const pluginSlashCommands = buildPluginSlashCommands(defs);
    this.pluginCommands = pluginSlashCommands.commands;
    this.pluginCommandMap.clear();
    for (const [commandName, body] of pluginSlashCommands.commandMap) {
      this.pluginCommandMap.set(commandName, body);
    }
    this.setupAutocomplete();
  }

  // =========================================================================
  // Lifecycle
  // =========================================================================

  async start(): Promise<void> {
    // Signal handlers must be installed before raw mode to avoid EIO loops.
    this.registerSignalHandlers();
    // Outer try rolls back signal listeners on startup failure.
    try {

      const shouldReplayHistory = await this.initMainTui();
      this.startEventLoop();
      try {
        this.startBackgroundFdAutocomplete();
        await this.finishStartup(shouldReplayHistory);
      } catch (error) {
        this.disposeTerminalTracking();
        this.state.ui.stop();
        throw error;
      }
    } catch (error) {
      this.unregisterSignalHandlers();
      throw error;
    }
  }

  private async loadBanner(): Promise<void> {
    // Brand independence: the upstream Kimi tips-banner service
    // (CLOUD_CODE_TIPS_BANNER_URL) pushes third-party product promotions that
    // do not belong in CloudCode, so remote banner loading is disabled. The
    // provider/renderer code is kept for a future self-hosted banner channel.
    return;
  }

  private async loadBannerDisabled(): Promise<void> {
    const provider = new BannerProvider(this.state.appState.version);
    const displayState = await readBannerDisplayState();
    const now = new Date();
    const banner = await provider.load(fetch, {
      state: displayState,
      now,
    });
    this.state.appState.banner = banner;
    if (banner === null) return;

    this.renderBanner();
    this.state.ui.requestRender();

    if (banner.display === 'always') return;
    try {
      await writeBannerDisplayState({
        version: 1,
        shown: {
          ...displayState.shown,
          [banner.key]: { lastShownAt: now.toISOString() },
        },
      });
    } catch {
      // Best-effort: banner display state should never block startup.
    }
  }

  private renderBanner(): void {
    if (this.state.appState.banner === null || this.state.appState.banner === undefined) {
      return;
    }
    if (this.state.transcriptContainer.children.some((child) => child instanceof BannerComponent)) {
      return;
    }
    const welcomeIndex = this.state.transcriptContainer.children.findIndex(
      (child) => child instanceof WelcomeComponent,
    );
    const banner = new BannerComponent(this.state.appState.banner);
    if (welcomeIndex >= 0) {
      this.state.transcriptContainer.children.splice(welcomeIndex + 1, 0, banner);
    } else {
      this.state.transcriptContainer.children.unshift(banner);
    }
    this.state.transcriptContainer.invalidate();
  }

  private async initMainTui(): Promise<boolean> {
    const shouldReplayHistory = await this.init();

    // Mount only after init() succeeds; see mountFooter().
    this.mountFooter();
    this.renderWelcome();
    void this.loadBanner();
    this.setupAutocomplete();
    void this.loadPersistedInputHistory();
    this.state.editorContainer.clear();
    this.state.editorContainer.addChild(this.state.editor);
    this.state.ui.setFocus(this.state.editor);
    return shouldReplayHistory;
  }

  private startEventLoop(): void {
    // Dispose any previous focus/clipboard/theme tracking so re-entering the
    // event loop (e.g. a future TUI reconnect) can't stack duplicate listeners.
    this.disposeTerminalTracking();
    this.state.ui.start();
    this.startClipboardImageHintController();
    this.terminalFocusTrackingDispose = installTerminalFocusTracking(this.state);
    this.refreshTerminalThemeTracking();
  }

  private startClipboardImageHintController(): void {
    this.clipboardImageHintController = new ClipboardImageHintController({
      ui: this.state.ui,
      footer: this.state.footer,
      getModelSupportsImage: () => this.supportsCurrentModelCapability('image_in'),
      requestRender: () => {
        this.state.ui.requestRender();
      },
    });
    this.clipboardImageHintController.start();
  }

  private startBackgroundFdAutocomplete(): void {
    if (this.fdPath !== null || this.fdDownloadStarted) return;
    this.fdDownloadStarted = true;

    void ensureFdPath()
      .then((fdPath) => {
        if (fdPath === null) return;
        this.fdPath = fdPath;
        this.setupAutocomplete();
      })
      .catch(() => {
        // Best-effort background bootstrap: autocomplete keeps using the filesystem fallback.
      });
  }

  private async refreshProviderModelsInBackground(): Promise<void> {
    try {
      const result = await this.authFlow.refreshProviderModels();
      for (const c of result.changed) {
        if (c.added <= 0) continue;
        this.showStatus(
          t(c.added === 1 ? 'status.providerModelsAdded.one' : 'status.providerModelsAdded.other', {
            provider: c.providerName,
            count: c.added,
          }),
        );
      }
      for (const f of result.failed) {
        this.showStatus(
          t('status.providerRefreshSkipped', { provider: f.provider, reason: f.reason }),
          'warning',
        );
      }
    } catch {
      // Best-effort: startup must not crash on background refresh failures.
    }
  }

  private async finishStartup(shouldReplayHistory: boolean): Promise<void> {
    if (this.startupNotice !== undefined) {
      this.showStatus(this.startupNotice);
      this.startupNotice = undefined;
    }
    void this.showTmuxKeyboardWarningIfNeeded();
    if (this.state.startupState === 'picker') {
      void this.bootstrapFromPicker();
      return;
    }
    if (shouldReplayHistory) {
      await this.sessionReplay.hydrateFromReplay(this.requireSession());
      this.applyStartupPermissionAndPlanToAppState();
    }
    const resumeState = this.session?.getResumeState();
    if (resumeState?.warning !== undefined) {
      this.showStatus(t('session.warning', { message: resumeState.warning }), 'warning', {
        transcript: true,
      });
    }
    if (this.session !== undefined) {
      this.sessionEventHandler.startSubscription();
      void this.showSessionWarnings(this.session);
    }
    void this.fetchSessions();
    if (this.session !== undefined) {
      this.updateTerminalTitle();
    }
    void this.refreshSkillCommands(this.session);
    void this.refreshPluginCommands(this.session);
  }

  private async showSessionWarnings(session: Session): Promise<void> {
    try {
      const warnings = await session.getSessionWarnings();
      if (this.session !== session) return;
      for (const warning of warnings) {
        const severity = warning.severity === 'error' ? 'error' : 'warning';
        this.showStatus(t('session.warning', { message: warning.message }), severity, {
          transcript: true,
        });
      }
    } catch {
      // Best-effort: startup must not block on warning retrieval.
    }
  }

  private async showTmuxKeyboardWarningIfNeeded(): Promise<void> {
    const warning = await detectTmuxKeyboardWarning();
    if (warning === undefined || this.aborted) return;
    this.showStatus(warning, 'warning', { transcript: true });
  }

  private async init(): Promise<boolean> {
    setExperimentalFeatures(await this.harness.getExperimentalFeatures());
    await this.authFlow.refreshAvailableModels();
    this.backgroundRefreshPromise = this.refreshProviderModelsInBackground();

    const { startup } = this.options;
    const { workDir } = this.state.appState;
    let session: Session | undefined;
    let shouldReplayHistory = false;
    const isResumeStartup = startup.sessionFlag !== undefined || startup.continueLast;
    const createSessionOptions: MutableCreateSessionOptions = {
      workDir,
      model: startup.model,
      permission: startup.auto ? 'auto' : startup.yolo ? 'yolo' : undefined,
      planMode: startup.plan ? true : undefined,
      // --agent/--agent-file bind the startup session only; sessions created
      // later in this process fall back to the default profile.
      agentProfile: startup.agentProfile,
      agentFiles: startup.agentFiles?.length ? [...startup.agentFiles] : undefined,
    };
    if (this.state.appState.additionalDirs.length > 0) {
      createSessionOptions.additionalDirs = [...this.state.appState.additionalDirs];
    }

    try {
      if (isResumeStartup) {
        if (startup.sessionFlag === '') {
          this.state.startupState = 'picker';
          return false;
        }

        if (startup.sessionFlag !== undefined) {
          const sessions = await this.harness.listSessions({
            sessionId: startup.sessionFlag,
            workDir,
          });
          const target = sessions[0];
          if (target === undefined) {
            throw new Error(t('status.sessionNotFound', { id: startup.sessionFlag }));
          }
          if (resolve(target.workDir) !== resolve(workDir)) {
            this.state.ui.stop();
            const wrongDirMessage = t('status.sessionWrongDir', { id: startup.sessionFlag });
            process.stderr.write(
              `${currentTheme.fg(
                'warning',
                `${wrongDirMessage}\n` +
                  `  cd "${target.workDir}" && cloud-code -r ${startup.sessionFlag}`,
              )}\n\n`,
            );
            throw new Error(wrongDirMessage);
          }
          session = await this.harness.resumeSession({
            id: startup.sessionFlag,
            additionalDirs: createSessionOptions.additionalDirs,
            replayTurnLimit: REPLAY_TURN_LIMIT,
          });
          shouldReplayHistory = true;
        } else {
          const sessions = await this.harness.listSessions({ workDir });
          const target = sessions[0];
          if (target !== undefined) {
            session = await this.harness.resumeSession({
              id: target.id,
              additionalDirs: createSessionOptions.additionalDirs,
              replayTurnLimit: REPLAY_TURN_LIMIT,
            });
            shouldReplayHistory = true;
          } else {
            session = await this.harness.createSession(createSessionOptions);
            this.startupNotice = combineStartupNotice(
              this.startupNotice,
              t('status.noSessionsToContinue', { workDir }),
            );
          }
        }
      } else {
        session = await this.harness.createSession(createSessionOptions);
      }
      if (session !== undefined && shouldReplayHistory) {
        await this.applyStartupModesToResumedSession(session);
        if (startup.model !== undefined) {
          await session.setModel(startup.model);
        }
      }
    } catch (error) {
      if (!isOAuthLoginRequiredError(error)) throw error;
      this.authFlow.enterLoginRequiredStartupState();
      return false;
    }

    if (session === undefined) {
      throw new Error(t('status.startupSessionMissing'));
    }
    await this.setSession(session);
    await this.syncRuntimeState(session);
    this.applyStartupPermissionAndPlanToAppState();
    this.state.startupState = 'ready';
    return shouldReplayHistory;
  }

  async stop(exitCode?: number): Promise<void> {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;
    this.unregisterSignalHandlers();
    this.aborted = true;
    // Give the startup provider-model refresh a brief chance to finish before
    // the harness closes (and the process exits): its config writes are each
    // atomic, so draining can only ever leave a complete file behind. Bounded
    // so a slow network never delays the exit.
    if (this.backgroundRefreshPromise !== undefined) {
      await Promise.race([
        this.backgroundRefreshPromise,
        new Promise((resolve) => setTimeout(resolve, 1500)),
      ]);
    }
    this.streamingUI.discardPending();
    // Stop background polling, streaming intervals, and per-component timers
    // before tearing the UI down, so they can't keep firing requestRender after
    // stop() returns (or leak when stop() runs without process.exit).
    this.tasksBrowserController.close();
    this.workflowsBrowserController.close();
    this.teamsBrowserController.close();
    this.btwPanelController.clear();
    this.stopActivitySpinner();
    this.streamingUI.disposeActiveCompactionBlock();
    this.streamingUI.resetToolUi();
    this.disposeTranscriptChildren();
    this.editorKeyboard.dispose();
    this.state.footer.dispose();
    for (const dispose of this.reverseRpcDisposers) {
      dispose();
    }
    this.reverseRpcDisposers.length = 0;
    this.disposeTerminalTracking();
    // Restore the terminal BEFORE awaiting session close: a hung MCP/network
    // shutdown (or a second SIGTERM after the handlers were unregistered
    // above) must not strand the user in raw mode / alt-screen.
    try {
      await this.state.terminal.drainInput();
    } catch {
      // best effort — the terminal may already be dead (SIGHUP / EIO).
    }
    try {
      this.state.ui.stop();
    } catch {
      // best effort terminal restore.
    }
    try {
      await this.closeSession('shutting down');
      await this.harness.close();
    } finally {
      this.sessionEventHandler.stopAllMcpServerStatusSpinners();
      this.uninstallRainbowDance();
    }
    if (this.onExit) {
      await this.onExit(exitCode);
    }
  }

  // SIGHUP / dead-terminal EIO → emergencyTerminalExit (no cleanup, avoids
  // EIO write-loop that can pin a CPU core). SIGTERM → normal stop().
  private registerSignalHandlers(): void {
    this.unregisterSignalHandlers();

    const signals: NodeJS.Signals[] = ['SIGTERM'];
    if (process.platform !== 'win32') {
      signals.push('SIGHUP');
    }

    for (const signal of signals) {
      const handler = (): void => {
        if (signal === 'SIGHUP') {
          this.emergencyTerminalExit();
          return;
        }
        // Registering a SIGTERM listener disables Node's default exit(143),
        // so we must reinstate it after stop() or on failure.
        this.stop(143).then(
          () => {
            process.exit(143);
          },
          () => {
            this.emergencyTerminalExit(143);
          },
        );
      };
      process.prependListener(signal, handler);
      this.signalCleanupHandlers.push(() => {
        process.off(signal, handler);
      });
    }

    const terminalErrorHandler = (error: Error): void => {
      if (isDeadTerminalError(error)) {
        this.emergencyTerminalExit();
      }
    };
    process.stdout.on('error', terminalErrorHandler);
    process.stderr.on('error', terminalErrorHandler);
    this.signalCleanupHandlers.push(() => {
      process.stdout.off('error', terminalErrorHandler);
    });
    this.signalCleanupHandlers.push(() => {
      process.stderr.off('error', terminalErrorHandler);
    });
  }

  private unregisterSignalHandlers(): void {
    const handlers = this.signalCleanupHandlers;
    this.signalCleanupHandlers = [];
    for (const cleanup of handlers) cleanup();
  }

  // Exit codes follow POSIX 128+signum: 129 = SIGHUP, 143 = SIGTERM.
  private emergencyTerminalExit(exitCode = 129): never {
    this.isShuttingDown = true;
    this.unregisterSignalHandlers();
    // Best-effort terminal restore: stop() may not have run (SIGHUP) or may
    // have thrown (SIGTERM cleanup failure), so recover raw mode / cursor /
    // bracketed paste before exiting instead of leaving the user's shell broken.
    restoreTerminalModes();
    process.exit(exitCode);
  }

  private disposeTerminalTracking(): void {
    this.stopTerminalThemeTracking();
    this.clipboardImageHintController?.stop();
    this.clipboardImageHintController = undefined;
    this.terminalFocusTrackingDispose?.();
    this.terminalFocusTrackingDispose = undefined;
  }

  private buildLayout(): void {
    const { ui, rootContainer, slotContainer } = this.state;
    ui.clear();
    // The root holds exactly two regions: the scrollable transcript and the
    // fixed bottom slot (notice/activity/swarm/todo/queue/btw/editor +
    // footer). In fullscreen mode the TUI pins the slot and scrolls the
    // transcript viewport; in inline mode the sections stack in the same order.
    // Full-screen takeovers (tasks/workflows browsers, approval preview)
    // snapshot ui.children, so they keep working unchanged.
    ui.addChild(rootContainer);
    rootContainer.clear();
    rootContainer.addChild(this.state.transcriptContainer);
    rootContainer.addChild(slotContainer);
    slotContainer.clear();
    // Transient status heads the slot, right under the transcript viewport:
    // notices, the activity spinner and the swarm progress all read as part
    // of the conversation flow — never wedged between the content panels
    // (todo/queue/btw) and the editor below. The idle gap row sits above
    // them: the blank belongs between the transcript and the status chrome,
    // not between the chrome and the editor.
    slotContainer.addChild(this.state.slotGapContainer);
    slotContainer.addChild(this.state.noticeContainer);
    slotContainer.addChild(this.state.activityContainer);
    slotContainer.addChild(this.state.swarmContainer);
    slotContainer.addChild(this.state.todoPanelContainer);
    slotContainer.addChild(this.state.queueContainer);
    slotContainer.addChild(this.state.btwPanelContainer);
    slotContainer.addChild(this.state.editorContainer);
    // Overflow clipping policy (fullscreen, slot taller than the screen):
    // editor/footer and the transient status rows keep their lines; the
    // content panels yield their top lines first.
    slotContainer.setLayer(this.state.slotGapContainer, 'status');
    slotContainer.setLayer(this.state.noticeContainer, 'status');
    slotContainer.setLayer(this.state.activityContainer, 'status');
    slotContainer.setLayer(this.state.swarmContainer, 'status');
    slotContainer.setLayer(this.state.todoPanelContainer, 'panel');
    slotContainer.setLayer(this.state.queueContainer, 'panel');
    slotContainer.setLayer(this.state.btwPanelContainer, 'panel');
    slotContainer.setLayer(this.state.editorContainer, 'pinned');
    // Footer is mounted later (mountFooter), not here.
  }

  // Footer is the only chrome with content before a session is ready, so
  // mounting it at construction lets a stray pre-start render leak it to the
  // terminal — e.g. above the error when resuming a missing session. Mount it
  // only once init() succeeds. FooterComponent isn't a Container, so wrap it to
  // pick up the same outer gutter as the panels above.
  private mountFooter(): void {
    const footerWrap = new GutterContainer(CHROME_GUTTER, CHROME_GUTTER);
    footerWrap.addChild(this.state.footer);
    this.state.slotContainer.addChild(footerWrap);
    this.state.slotContainer.setLayer(footerWrap, 'pinned');
    // Clickable footer segments (mouse only; the keyboard flow is untouched).
    // Every action routes through the same dispatch as the typed command, so
    // a click is exactly equivalent to typing /model, /status, or using /copy.
    this.state.footer.setActions({
      openModelPicker: () => {
        slashCommands.dispatchInput(this, '/model');
      },
      openStatus: () => {
        slashCommands.dispatchInput(this, '/status');
      },
      copyWorkDir: () => {
        void this.copyWorkDirToClipboard();
      },
    });
    // Takeover notice mirror: while a full-screen takeover (tasks/workflows/
    // teams browser, approval preview) owns the screen, the slot's notice row
    // is swapped out with the rest of the layout, so a transient notice would
    // render invisibly. This non-capturing overlay re-renders the current
    // notice on top of the takeover; the noticeContainer stays the single
    // source of truth (auto-clear, post-close visibility unchanged).
    this.state.ui.showOverlay(new TakeoverNoticeMirror(this.state), {
      width: '100%',
      anchor: 'bottom-left',
      nonCapturing: true,
      visible: () =>
        this.isAnyTakeoverActive() && this.state.noticeContainer.children.length > 0,
    });
  }

  /** cwd footer-segment click: copy the full path, /copy-style feedback. */
  private async copyWorkDirToClipboard(): Promise<void> {
    const workDir = this.state.appState.workDir;
    try {
      const method = await copyTextToClipboard(workDir);
      this.showStatus(
        method === 'native'
          ? t('commands.copy.copied', { count: workDir.length })
          : t('commands.copy.copiedUnverified', { count: workDir.length }),
      );
    } catch (error) {
      this.showError(t('commands.copy.failed', { error: formatErrorMessage(error) }));
    }
  }

  // =========================================================================
  // Input Dispatch
  // =========================================================================

  handlePlanToggle(next: boolean): void {
    void slashCommands.handlePlanCommand(this, next ? 'on' : 'off');
  }

  handleInputModeChange(mode: 'prompt' | 'bash'): void {
    this.setAppState({ inputMode: mode });
    this.updateEditorBorderHighlight();
  }

  setVimMode(mode: 'INSERT' | 'NORMAL' | null): void {
    this.setAppState({ vimMode: mode });
  }

  handleUserInput(text: string): void {
    const wasBashMode = this.state.appState.inputMode === 'bash';
    if (wasBashMode) {
      // A submit always exits bash mode (the `!` is consumed by this command).
      this.state.editor.inputMode = 'prompt';
      this.handleInputModeChange('prompt');
    }
    if (text.trim().length === 0) return;
    if (this.state.appState.isReplaying) {
      this.showError(t('status.cannotSendWhileReplaying'));
      return;
    }
    // Submitting jumps the transcript viewport back to the bottom (fullscreen).
    // Only after the reject paths — an error notice must not yank the view.
    this.state.ui.scrollToBottom();
    // Shell commands are stored with a leading `!` so ↑ recall can tell them
    // apart from prompts and restore bash mode (see CustomEditor's mode-aware
    // history navigation). The `!` is stripped again when the entry is recalled.
    const historyText = wasBashMode ? `!${text}` : text;
    void this.persistInputHistory(historyText);
    if (wasBashMode) {
      // Only one foreground action at a time: queue the shell command while
      // another shell command is running or an agent turn is in progress.
      if (this.state.appState.streamingPhase !== 'idle') {
        this.enqueueMessage(text, undefined, 'bash');
        this.updateQueueDisplay();
        this.state.ui.requestRender();
        return;
      }
      this.runShellCommandFromInput(text);
      return;
    }
    slashCommands.dispatchInput(this, text);
  }

  private runShellCommandFromInput(command: string): void {
    const session = this.session;
    if (session === undefined) {
      this.showError(t('status.noActiveSessionForShell'));
      return;
    }
    // Echo the command locally (bash-input) with a `$` prompt. The agent also
    // records it for resume; this is the live view.
    this.appendTranscriptEntry({
      id: nextTranscriptId(),
      kind: 'user',
      turnId: undefined,
      renderMode: 'plain',
      content: currentTheme.fg('shellMode', `$ ${command}`),
      bullet: '',
    });
    // Create the live output entry up front. ShellRunComponent owns its own
    // rendering (running card → final view) and is mutated in place as output
    // streams in and on completion.
    const commandId = nextTranscriptId();
    const outputEntry: TranscriptEntry = {
      id: commandId,
      kind: 'status',
      turnId: undefined,
      renderMode: 'plain',
      content: '',
    };
    const outputComponent = new ShellRunComponent(() => this.state.ui.requestRender());
    // A `!` card mounted while the global ctrl+o expansion is on starts
    // expanded, matching how streaming-ui mounts tool cards.
    if (this.state.toolOutputExpanded) outputComponent.setExpanded(true);
    this.shellOutputStreams.set(commandId, { entry: outputEntry, component: outputComponent });
    this.state.transcriptEntries.push(outputEntry);
    markTranscriptComponent(outputComponent, outputEntry);
    this.state.transcriptContainer.addChild(outputComponent);
    // Treat command execution as a streaming phase so input queues, the activity
    // pane shows the moon spinner, and ctrl+b is enabled while it runs.
    this.setAppState({ streamingPhase: 'shell' });
    this.state.ui.requestRender();

    void session.runShellCommand(command, { commandId }).then(
      ({ stdout, stderr, isError, backgrounded }) => {
        this.finishShellOutput(commandId, stdout, stderr, isError, backgrounded);
      },
      (error: unknown) => {
        const message = formatErrorMessage(error);
        this.finishShellOutput(commandId, '', message, true);
        this.showError(t('status.shellCommandFailed', { message }));
      },
    );
  }

  handleShellOutput(event: { commandId: string; update: { kind: string; text?: string } }): void {
    const stream = this.shellOutputStreams.get(event.commandId);
    if (stream === undefined) return;
    const text = event.update.text ?? '';
    if (text.length === 0) return;
    stream.component.append(text);
  }

  handleShellStarted(event: { commandId: string; taskId: string }): void {
    const stream = this.shellOutputStreams.get(event.commandId);
    if (stream === undefined) return;
    stream.taskId = event.taskId;
  }

  cancelRunningShellCommand(): void {
    const session = this.session;
    if (session === undefined) return;
    for (const commandId of this.shellOutputStreams.keys()) {
      void session.cancelShellCommand(commandId).catch((error: unknown) => {
        this.showError(t('status.shellCancelFailed', { message: formatErrorMessage(error) }));
      });
    }
  }

  /**
   * EditorKeyboardHost — T2 "interrupt before output → recall for re-edit".
   * `!` shell commands run in the 'shell' streaming phase: cancelling one must
   * never recall input. Compaction cancellation takes a separate path and
   * never reaches here.
   */
  consumeInterruptRecall(): InterruptRecall | undefined {
    if (this.state.appState.streamingPhase === 'shell') return undefined;
    return this.sessionEventHandler.consumeInterruptRecall();
  }

  /**
   * EditorKeyboardHost — Esc while a rate-limit auto-retry countdown is
   * parked: cancel the core-side resume timer (session cancel is a
   * no-op for the idle turn itself) and retire the countdown line.
   */
  cancelRateLimitPause(): void {
    void this.session?.cancel();
    this.sessionEventHandler.clearRateLimitPause();
    this.showStatus(t('session.turn.rateLimitPauseCancelled'));
  }

  private finishShellOutput(
    commandId: string,
    stdout: string,
    stderr: string,
    isError?: boolean,
    backgrounded?: boolean,
  ): void {
    const stream = this.shellOutputStreams.get(commandId);
    if (stream === undefined) return;
    if (backgrounded === true) {
      // The command was moved to the background; detachRunningShellCommand owns
      // the UI and the model notification, so there is nothing to render here.
      return;
    }
    stream.component.finish(stdout, stderr, isError);
    // Keep the transcript entry's metadata in sync for anything that reads it
    // (export / copy). The component renders itself.
    stream.entry.content = formatBashOutputForDisplay(stdout, stderr, isError);
    this.shellOutputStreams.delete(commandId);
    // When the last shell command finishes, leave the shell streaming phase,
    // release one queued message (if any), and refresh the activity pane.
    if (this.shellOutputStreams.size === 0) {
      this.setAppState({ streamingPhase: 'idle' });
      this.drainOneQueuedMessage();
    }
  }

  private drainOneQueuedMessage(): void {
    const item = this.shiftQueuedMessage();
    if (item === undefined) return;
    const session = this.session;
    if (session === undefined) return;
    if (item.mode === 'bash') {
      this.runShellCommandFromInput(item.text);
    } else {
      this.sendQueuedMessage(session, item);
    }
    this.updateQueueDisplay();
  }

  sendNormalUserInput(text: string): void {
    if (this.btwPanelController.sendUserInput(text)) return;
    if (this.state.appState.model.trim().length === 0) {
      this.showError(resolveDescription(LLM_NOT_SET_MESSAGE));
      return;
    }
    let extraction: ReturnType<typeof extractMediaAttachments>;
    try {
      extraction = extractMediaAttachments(text, this.imageStore);
    } catch (error) {
      // Cache copy failed (e.g. the pasted video's source vanished). pi-tui
      // clears the editor buffer before firing onSubmit, so put the draft back
      // — the user loses neither the text nor the session.
      this.state.editor.setText(text);
      this.showError(t('status.mediaAttachmentFailed', { message: formatErrorMessage(error) }));
      return;
    }
    if (!this.validateMediaCapabilities(extraction)) return;
    const session = this.session;
    if (session === undefined) {
      this.showError(resolveDescription(LLM_NOT_SET_MESSAGE));
      return;
    }
    if (extraction.hasMedia) {
      this.sendMessage(session, text, {
        hasMedia: true,
        parts: extraction.parts,
        imageAttachmentIds: extraction.imageAttachmentIds,
      });
    } else {
      this.sendMessage(session, text);
    }
    this.updateQueueDisplay();
    this.state.ui.requestRender();
  }

  validateMediaCapabilities(extraction: {
    hasMedia: boolean;
    imageAttachmentIds: readonly number[];
    videoAttachmentIds: readonly number[];
  }): boolean {
    if (!extraction.hasMedia) return true;
    if (
      extraction.imageAttachmentIds.length > 0 &&
      !this.supportsCurrentModelCapability('image_in')
    ) {
      this.showError(t('status.modelNoImageInput'));
      return false;
    }
    if (
      extraction.videoAttachmentIds.length > 0 &&
      !this.supportsCurrentModelCapability('video_in')
    ) {
      this.showError(t('status.modelNoVideoInput'));
      return false;
    }
    return true;
  }

  private supportsCurrentModelCapability(capability: string): boolean {
    const capabilities =
      this.state.appState.availableModels[this.state.appState.model]?.capabilities;
    if (capabilities === undefined) return true;
    return capabilities.includes(capability);
  }

  private async loadPersistedInputHistory(): Promise<void> {
    try {
      const file = getInputHistoryFile(this.state.appState.workDir);
      const entries = await loadInputHistory(file);
      for (const entry of entries) {
        this.state.editor.addToHistory(entry.content);
      }
      this.lastHistoryContent = entries.at(-1)?.content;
    } catch {
      // best-effort
    }
  }

  private async persistInputHistory(text: string): Promise<void> {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    if (trimmed === this.lastHistoryContent) return;
    this.state.editor.addToHistory(trimmed);
    try {
      const file = getInputHistoryFile(this.state.appState.workDir);
      const written = await appendInputHistory(file, trimmed, this.lastHistoryContent);
      if (written) this.lastHistoryContent = trimmed;
    } catch {
      this.lastHistoryContent = trimmed;
    }
  }

  recallLastQueued(): QueuedMessage | undefined {
    if (this.state.queuedMessages.length === 0) return undefined;
    const last = this.state.queuedMessages.at(-1)!;
    this.state.queuedMessages = this.state.queuedMessages.slice(0, -1);
    return last;
  }

  // =========================================================================
  // Session Requests / Queues
  // =========================================================================

  private enqueueMessage(
    text: string,
    options?: SendMessageOptions,
    mode?: 'prompt' | 'bash',
  ): void {
    this.state.queuedMessages.push({
      text,
      agentId: this.harness.interactiveAgentId,
      parts: options?.parts,
      imageAttachmentIds:
        options?.imageAttachmentIds !== undefined && options.imageAttachmentIds.length > 0
          ? options.imageAttachmentIds
          : undefined,
      mode,
    });
  }

  beginSessionRequest(): void {
    this.streamingUI.setTurnId(undefined);
    this.streamingUI.resetLiveText();
    this.streamingUI.resetToolUi();
    this.streamingUI.resetToolCallState();

    this.patchLivePane({
      mode: 'waiting',
      pendingApproval: null,
      pendingQuestion: null,
    });
    this.setAppState({
      streamingPhase: 'waiting',
      streamingStartTime: Date.now(),
    });
  }

  failSessionRequest(message: string): void {
    // The turn never started — drop the T2 recall record along with it.
    this.sessionEventHandler.recallableTurnInput = undefined;
    this.sessionEventHandler.recallableTranscriptEntryIds = undefined;
    this.setAppState({ streamingPhase: 'idle' });
    this.resetLivePane();
    this.showError(message);
  }

  sendQueuedMessage(session: Session, item: QueuedMessage): void {
    if (item.mode === 'bash') {
      this.runShellCommandFromInput(item.text);
      return;
    }
    this.harness.withInteractiveAgent(item.agentId ?? MAIN_AGENT_ID, () => {
      this.sendMessageInternal(session, item.text, {
        parts: item.parts,
        imageAttachmentIds: item.imageAttachmentIds,
      });
    });
  }

  requestQueuedGoalPromotion(): void {
    this.sessionEventHandler.requestQueuedGoalPromotion();
  }

  private sendMessageInternal(session: Session, input: string, options?: SendMessageOptions): void {
    // T2: remember the submitted text so Esc / Ctrl+C before any visible
    // assistant output can recall it into the editor for re-editing.
    this.sessionEventHandler.recallableTurnInput = input;
    const imageAttachmentIds =
      options?.imageAttachmentIds !== undefined && options.imageAttachmentIds.length > 0
        ? options.imageAttachmentIds
        : undefined;
    const entry: TranscriptEntry = {
      id: nextTranscriptId(),
      kind: 'user',
      turnId: undefined,
      renderMode: 'plain',
      content: input,
      imageAttachmentIds,
    };
    this.appendTranscriptEntry(entry);
    // T2: the echo doubles as the recall anchor — removed from the transcript
    // again when the interrupt recall fires.
    this.sessionEventHandler.recallableTranscriptEntryIds = [entry.id];
    // T4: the local echo doubles as the optimistic transcript entry — it is
    // drawn synchronously at submit, confirmed by the session's
    // `prompt.submitted` event (confirmUserEcho), and removed again if the
    // prompt call itself fails so a rejected submit leaves no orphan bubble.
    this.pendingUserEchoId = entry.id;

    this.beginSessionRequest();

    const sdkInput = options?.parts ?? input;
    // While a goal is being pursued the engine holds its active turn across the
    // whole continuation loop, so a fresh prompt races the goal driver at every
    // continuation boundary and is rejected with `turn.agent_busy`, dropping
    // the message. Steer instead: the engine buffers it into the running goal
    // turn, or launches a turn of its own if the loop just ended.
    if (this.state.appState.goal?.status === 'active') {
      void session.steer(sdkInput).catch((error: unknown) => {
        const message = formatErrorMessage(error);
        // Same reset as the prompt path: beginSessionRequest already moved the
        // TUI to the waiting phase, and no turn events may follow a failed
        // steer (e.g. the session is gone), which would leave the UI stuck
        // queueing input behind a request that never completes.
        this.failSessionRequest(`Failed to steer: ${message}`);
      });
      return;
    }
    void session.prompt(sdkInput).catch((error: unknown) => {
      this.removePendingUserEcho();
      const message = formatErrorMessage(error);
      this.failSessionRequest(t('status.sendFailed', { message }));
    });
  }

  /**
   * T4: the session accepted the prompt (`prompt.submitted` arrived), so the
   * optimistic echo becomes the authoritative user-message bubble. The event
   * is never rendered as a separate component — this only clears the pending
   * marker, which is what keeps the echo from being drawn twice.
   */
  confirmUserEcho(): void {
    this.pendingUserEchoId = undefined;
  }

  /** Remove the optimistic user echo after the prompt call was rejected. */
  private removePendingUserEcho(): void {
    const id = this.pendingUserEchoId;
    this.pendingUserEchoId = undefined;
    if (id === undefined) return;
    let removed = false;
    const entryIndex = this.state.transcriptEntries.findIndex((entry) => entry.id === id);
    if (entryIndex >= 0) {
      this.state.transcriptEntries.splice(entryIndex, 1);
      removed = true;
    }
    const children = this.state.transcriptContainer.children;
    const childIndex = children.findIndex(
      (child) => getTranscriptComponentEntry(child)?.id === id,
    );
    if (childIndex >= 0) {
      const [child] = children.splice(childIndex, 1);
      if (child !== undefined && hasDispose(child)) child.dispose();
      this.state.transcriptContainer.invalidate();
      removed = true;
    }
    if (removed) this.state.ui.requestRender();
  }

  /**
   * EditorKeyboardHost — T2 interrupt recall: drop the recalled input's echo
   * entries (and their components) from the transcript, so the interrupted
   * message renders as recalled/removed instead of staying as a normal
   * message next to its edited replacement. Mirrors the server-side context
   * withdrawal the cancel carries.
   */
  removeRecalledTranscriptEntries(entryIds: readonly string[]): void {
    if (entryIds.length === 0) return;
    const ids = new Set(entryIds);
    let removed = false;
    const entries = this.state.transcriptEntries;
    for (let i = entries.length - 1; i >= 0; i--) {
      if (ids.has(entries[i]!.id)) {
        entries.splice(i, 1);
        removed = true;
      }
    }
    const children = this.state.transcriptContainer.children;
    for (let i = children.length - 1; i >= 0; i--) {
      const child = children[i];
      if (child === undefined || !ids.has(getTranscriptComponentEntry(child)?.id ?? '')) continue;
      children.splice(i, 1);
      if (hasDispose(child)) child.dispose();
      removed = true;
    }
    if (removed) {
      this.state.transcriptContainer.invalidate();
      this.state.ui.requestRender();
    }
  }

  sendSkillActivation(session: Session, skillName: string, skillArgs: string): void {
    // Args are a plain-text channel, so pasted media can't ride along as
    // inline parts. Skill args are XML-escaped on render (renderSkillAttributes
    // + expandSkillParameters), so rewrite placeholders into escape-proof
    // plain-text file references the model can open with ReadMediaFile.
    let rewrite: ReturnType<typeof rewriteMediaPlaceholders>;
    try {
      rewrite = rewriteMediaPlaceholders(skillArgs, this.imageStore, 'plain');
    } catch (error) {
      // Cache copy failed (unwritable cache dir, vanished video source…);
      // nothing has been dispatched yet, so just report and keep the input.
      this.showError(t('status.mediaAttachmentFailed', { message: formatErrorMessage(error) }));
      return;
    }
    if (!this.validateMediaCapabilities(rewrite)) return;
    this.beginSessionRequest();
    void session.activateSkill(skillName, rewrite.text).catch((error: unknown) => {
      const message = formatErrorMessage(error);
      this.failSessionRequest(t('status.skillFailed', { name: skillName, message }));
    });
  }

  activatePluginCommand(
    session: Session,
    pluginId: string,
    commandName: string,
    args: string,
  ): void {
    // Plugin command args are expanded verbatim (no XML escaping), so the
    // standard <image|video path> tag convention works — see
    // sendSkillActivation for the escaped-channel variant.
    let rewrite: ReturnType<typeof rewriteMediaPlaceholders>;
    try {
      rewrite = rewriteMediaPlaceholders(args, this.imageStore, 'tag');
    } catch (error) {
      this.showError(t('status.mediaAttachmentFailed', { message: formatErrorMessage(error) }));
      return;
    }
    if (!this.validateMediaCapabilities(rewrite)) return;
    this.beginSessionRequest();
    void session
      .activatePluginCommand(pluginId, commandName, rewrite.text)
      .catch((error: unknown) => {
        const message = formatErrorMessage(error);
        this.failSessionRequest(
          t('status.pluginCommandFailed', { id: `${pluginId}:${commandName}`, message }),
        );
      });
  }

  private sendMessage(session: Session, input: string, options?: SendMessageOptions): void {
    if (
      this.deferUserMessages ||
      this.state.appState.streamingPhase !== 'idle' ||
      this.state.appState.isCompacting
    ) {
      this.enqueueMessage(input, options);
      return;
    }
    this.sendMessageInternal(session, input, options);
  }

  steerMessage(session: Session, input: readonly SteerInputItem[]): void {
    if (this.deferUserMessages || this.state.appState.isCompacting) {
      for (const item of input) {
        this.enqueueMessage(item.text, item);
      }
      return;
    }
    if (this.state.appState.streamingPhase === 'idle') {
      for (const item of input) {
        this.sendMessageInternal(session, item.text, item);
      }
      return;
    }

    const steerEntryIds: string[] = [];
    for (const item of input) {
      const entry: TranscriptEntry = {
        id: nextTranscriptId(),
        kind: 'user',
        turnId: this.streamingUI.getTurnContext().turnId,
        renderMode: 'plain',
        content: item.text,
        imageAttachmentIds:
          item.imageAttachmentIds !== undefined && item.imageAttachmentIds.length > 0
            ? item.imageAttachmentIds
            : undefined,
      };
      this.appendTranscriptEntry(entry);
      steerEntryIds.push(entry.id);
    }

    // T2: a steer is the most recently submitted input; when the turn still
    // has no visible output, interrupting recalls the steer text for
    // re-editing (the original prompt stays in the input history).
    this.sessionEventHandler.recallableTurnInput = input.map((item) => item.text).join('\n');
    this.sessionEventHandler.recallableTranscriptEntryIds = steerEntryIds;
    void session.steer(combineSteerInput(input)).catch((error: unknown) => {
      const message = formatErrorMessage(error);
      this.showError(t('status.steerFailed', { message }));
    });
  }

  // =========================================================================
  // State & Accessors
  // =========================================================================

  setStartupReady(): void {
    this.state.startupState = 'ready';
  }

  clearQueuedMessages(): void {
    this.state.queuedMessages = [];
  }

  shiftQueuedMessage(): QueuedMessage | undefined {
    if (this.state.queuedMessages.length === 0) return undefined;
    const [first, ...rest] = this.state.queuedMessages;
    this.state.queuedMessages = rest;
    return first;
  }

  pushTranscriptEntry(entry: TranscriptEntry): void {
    this.state.transcriptEntries.push(entry);
  }

  setExternalEditorRunning(running: boolean): void {
    this.state.externalEditorRunning = running;
  }

  setTasksBrowser(value: TUIState['tasksBrowser']): void {
    this.state.tasksBrowser = value;
  }

  /**
   * True while a blocking panel (approval/question) owns the editor slot.
   * Takeover controllers consult this before mounting: a full-screen takeover
   * must never cover a blocking surface — its unanswered RPC would be left
   * with no visible UI. See docs/tui-modal-surfaces.md.
   */
  hasBlockingEditorSlotPanel(): boolean {
    return this.editorSlotOwner?.kind === 'blocking';
  }

  setWorkflowsBrowser(value: TUIState['workflowsBrowser']): void {
    this.state.workflowsBrowser = value;
  }

  setTeamsBrowser(value: TUIState['teamsBrowser']): void {
    this.state.teamsBrowser = value;
  }

  get workflowTracker(): WorkflowTracker {
    return this.sessionEventHandler.workflowTracker;
  }

  get teamTracker(): TeamTracker {
    return this.sessionEventHandler.teamTracker;
  }

  appendStartupNotice(extra: string): void {
    this.startupNotice = combineStartupNotice(this.startupNotice, extra);
  }

  get backgroundTasks(): ReadonlyMap<string, BackgroundTaskInfo> {
    return this.sessionEventHandler.backgroundTasks;
  }

  getCurrentSessionId(): string {
    return this.state.appState.sessionId;
  }

  hasSessionContent(): boolean {
    return this.state.transcriptEntries.length > 0;
  }

  setExitOpenUrl(url: string): void {
    this.exitOpenUrl = url;
  }

  setExitForegroundTask(task: (exitCode: number) => Promise<void>): void {
    this.exitForegroundTask = task;
  }

  setAppState(patch: Partial<AppState>): void {
    if (!hasPatchChanges(this.state.appState, patch)) return;
    const additionalDirsChanged =
      'additionalDirs' in patch &&
      !sameStringArrays(this.state.appState.additionalDirs, patch.additionalDirs ?? []);
    const busyChanged = 'streamingPhase' in patch || 'isCompacting' in patch;
    Object.assign(this.state.appState, patch);
    if ('planMode' in patch) this.updateEditorBorderHighlight();
    this.state.footer.setState(this.state.appState);
    this.updateActivityPane();
    if (busyChanged) {
      this.updateQueueDisplay();
      this.sessionEventHandler.retryQueuedGoalPromotion();
    }
    if (additionalDirsChanged) this.setupAutocomplete();
    this.state.ui.requestRender();
  }

  patchLivePane(patch: Partial<LivePaneState>): void {
    if (!hasPatchChanges(this.state.livePane, patch)) return;
    Object.assign(this.state.livePane, patch);
    this.updateActivityPane();
    this.state.ui.requestRender();
  }

  resetLivePane(): void {
    this.state.livePane = { ...INITIAL_LIVE_PANE };
    this.updateActivityPane();
    this.state.ui.requestRender();
  }

  private syncAdditionalDirs(session: Session): void {
    const additionalDirs = session.summary?.additionalDirs ?? [];
    if (sameStringArrays(this.state.appState.additionalDirs, additionalDirs)) return;
    this.setAppState({ additionalDirs: [...additionalDirs] });
  }

  // =========================================================================
  // Session Runtime
  // =========================================================================

  requireSession(): Session {
    if (this.session === undefined) {
      throw new Error(resolveDescription(NO_ACTIVE_SESSION_MESSAGE));
    }
    return this.session;
  }

  private async createSessionFromCurrentState(): Promise<Session> {
    const model = this.state.appState.model.trim();
    if (model.length === 0) {
      throw new Error(resolveDescription(LLM_NOT_SET_MESSAGE));
    }
    const options: MutableCreateSessionOptions = {
      workDir: this.state.appState.workDir,
      model,
      thinking: this.session === undefined ? undefined : this.state.appState.thinkingEffort,
      permission: this.state.appState.permissionMode,
      planMode: this.state.appState.planMode ? true : undefined,
    };
    if (this.state.appState.additionalDirs.length > 0) {
      options.additionalDirs = [...this.state.appState.additionalDirs];
    }
    return this.harness.createSession(options);
  }

  async setSession(session: Session): Promise<void> {
    const previous = this.unloadCurrentSession('switching session');
    await previous?.close();
    this.session = session;
    this.registerSessionHandlers(session);
    this.syncAdditionalDirs(session);
  }

  async syncRuntimeState(session: Session = this.requireSession()): Promise<void> {
    const [status, goalResult] = await Promise.all([session.getStatus(), session.getGoal()]);
    this.setAppState({
      sessionId: session.id,
      model: status.model ?? '',
      thinkingEffort: status.thinkingEffort,
      permissionMode: status.permission,
      planMode: status.planMode,
      swarmMode: status.swarmMode ?? false,
      coordinatorMode: status.coordinatorMode ?? false,
      serviceTier: status.serviceTier ?? null,
      contextTokens: status.contextTokens,
      maxContextTokens: status.maxContextTokens,
      contextUsage: status.contextUsage,
      sessionTitle: session.summary?.title ?? null,
      goal: goalResult.goal,
    });
    this.syncAdditionalDirs(session);
  }

  // Apply --auto/--yolo/--plan startup flags to a resumed session. The resumed
  // session may already be in plan mode from its persisted records, and
  // re-entering plan mode throws, so only enable it when it is not active yet.
  // setPermission is idempotent and needs no such guard.
  private async applyStartupModesToResumedSession(session: Session): Promise<void> {
    const { startup } = this.options;
    if (startup.auto) {
      await session.setPermission('auto');
    } else if (startup.yolo) {
      await session.setPermission('yolo');
    }
    if (startup.plan) {
      const status = await session.getStatus();
      if (!status.planMode) {
        await session.setPlanMode(true);
      }
    }
  }

  // Re-apply startup flags that the user explicitly passed on the command line.
  // syncRuntimeState and session-replay hydration can both read stale persisted
  // values, so this guarantees the footer reflects the CLI intent.
  private applyStartupPermissionAndPlanToAppState(): void {
    const { startup } = this.options;
    if (startup.auto) {
      this.setAppState({ permissionMode: 'auto' });
    } else if (startup.yolo) {
      this.setAppState({ permissionMode: 'yolo' });
    }
    if (startup.plan) {
      this.setAppState({ planMode: true });
    }
  }

  // Plan mode is set by createSession — do not re-enter it here.
  private async activateRuntime(): Promise<void> {
    const session = this.requireSession();
    await session.setPermission(this.state.appState.permissionMode);
    await this.syncRuntimeState(session);
  }

  async closeSession(reason: string): Promise<void> {
    const previous = this.unloadCurrentSession(reason);
    await previous?.close();
  }

  private unloadCurrentSession(reason: string): Session | undefined {
    const previous = this.session;
    this.sessionEventUnsubscribe?.();
    this.sessionEventUnsubscribe = undefined;
    this.clearReverseRpcPanels();
    previous?.setApprovalHandler(undefined);
    previous?.setQuestionHandler(undefined);
    this.approvalController.cancelAll(reason);
    this.questionController.cancelAll(reason);
    this.session = undefined;
    this.state.swarmModeEntry = undefined;
    this.setAppState({ goal: null });
    return previous;
  }

  private clearReverseRpcPanels(): void {
    for (const dispose of this.reverseRpcDisposers) {
      dispose();
    }
    this.reverseRpcDisposers.length = 0;
  }

  private registerSessionHandlers(session: Session): void {
    session.setApprovalHandler(
      createApprovalRequestHandler(this.approvalController, (request, response) => {
        this.appendApprovalTranscriptEntry(request, response);
        this.maybeAutoNameSessionFromPlan(request, response);
      }),
    );
    session.setQuestionHandler(createQuestionAskHandler(this.questionController));
  }

  /**
   * Auto-name the session from the plan content when a plan is approved —
   * the plan's goal line makes a far better picker title than the truncated
   * first prompt. Fire-and-forget through the regular rename channel; the
   * resulting session.meta.updated event refreshes appState.sessionTitle.
   */
  private maybeAutoNameSessionFromPlan(
    request: ApprovalRequest,
    response: ApprovalResponse,
  ): void {
    try {
      if (response.decision !== 'approved') return;
      if (request.display.kind !== 'plan_review') return;
      const title = planSessionTitleFromPlan(request.display.plan);
      if (title === undefined) return;
      const session = this.session;
      if (session === undefined) return;
      void this.harness.renameSession({ id: session.id, title }).catch(() => {});
    } catch {
      // Naming is best-effort chrome — it must never break the approval flow.
    }
  }

  async fetchSessions(scope: 'cwd' | 'all' = this.state.sessionsScope): Promise<void> {
    this.state.loadingSessions = true;
    this.state.sessionsScope = scope;
    try {
      const sessions =
        scope === 'all'
          ? await this.harness.listSessions({})
          : await this.harness.listSessions({ workDir: this.state.appState.workDir });
      this.state.sessions = sessionRowsForPicker(
        sessions,
        this.state.appState.sessionId,
        this.hasSessionContent(),
      );
    } catch (error) {
      // The picker must keep working (it renders the empty state), but a
      // swallowed failure surfaces as a misleading "No sessions found." —
      // keep a log trail so the real error stays discoverable.
      log.warn('failed to fetch sessions for picker', { error: String(error) });
    } finally {
      this.state.loadingSessions = false;
    }
  }

  updateTerminalTitle(): void {
    const trimmed = this.state.appState.sessionTitle?.trim() ?? '';
    const label = trimmed.length > 0 ? trimmed.slice(0, MAX_TERMINAL_TITLE_LENGTH) : PRODUCT_NAME;
    this.state.terminal.setTitle(label);
  }

  resetSessionRuntime(): void {
    this.aborted = false;
    this.streamingUI.discardPending();
    this.state.queuedMessages = [];
    this.state.swarmModeEntry = undefined;
    this.streamingUI.resetToolCallState();
    this.streamingUI.resetToolUi();
    this.sessionEventHandler.resetRuntimeState();
    this.tasksBrowserController.close();
    this.workflowsBrowserController.close();
    this.teamsBrowserController.close();
    this.btwPanelController.clear();
    this.state.footer.setBackgroundCounts({ bashTasks: 0, agentTasks: 0 });
    this.streamingUI.setTodoList([]);
    this.streamingUI.setTurnId(undefined);
    this.setAppState({ mcpServersSummary: null });
    this.streamingUI.setStep(0);
    this.streamingUI.resetLiveText();
    this.updateQueueDisplay();
  }

  private async showResumeOtherWorkDirHint(session: SessionRow): Promise<void> {
    this.hideSessionPicker();
    const command = `cd ${quoteShellArg(session.work_dir)} && kimi --resume ${quoteShellArg(session.id)}`;
    const message = t('status.resumeOtherWorkDir', { command });
    try {
      await copyTextToClipboard(command);
      // The hint carries an actionable command line — keep it in the
      // transcript so a later transient notice can't replace it.
      this.showStatus(`${message}\n  ${t('status.commandCopied')}`, 'warning', {
        transcript: true,
      });
    } catch {
      this.showStatus(`${message}\n  ${t('status.commandCopyFailed')}`, 'warning', {
        transcript: true,
      });
    }
  }

  private async resumeSession(targetSessionId: string): Promise<boolean> {
    if (targetSessionId === this.state.appState.sessionId) {
      this.showStatus(t('status.alreadyOnSession'));
      return true;
    }
    if (this.state.appState.streamingPhase !== 'idle') {
      this.showError(t('status.cannotSwitchWhileStreaming'));
      return false;
    }
    if (this.state.appState.isReplaying) {
      this.showError(t('status.cannotSwitchWhileReplaying'));
      return false;
    }

    let session: Session;
    try {
      session = await this.harness.resumeSession({
        id: targetSessionId,
        replayTurnLimit: REPLAY_TURN_LIMIT,
      });
    } catch (error) {
      const msg = formatErrorMessage(error);
      this.showError(t('status.resumeSessionFailed', { id: targetSessionId, message: msg }));
      return false;
    }

    await this.switchToSession(session, t('status.sessionResumed', { id: session.id }));
    return true;
  }

  async switchToSession(session: Session, statusMessage: string): Promise<void> {
    this.resetSessionRuntime();
    await this.setSession(session);
    await this.syncRuntimeState(session);
    this.updateTerminalTitle();
    try {
      await this.refreshSkillCommands(this.session);
      await this.refreshPluginCommands(this.session);
    } catch {
      /* keep the switched session usable even if dynamic skills fail */
    }
    this.clearTranscriptAndRedraw();
    try {
      await this.sessionReplay.hydrateFromReplay(session);
    } catch (error) {
      const msg = formatErrorMessage(error);
      this.showError(t('status.replayFailed', { message: msg }));
    } finally {
      this.sessionEventHandler.startSubscription();
    }
    const resumeState = session.getResumeState();
    if (resumeState?.warning !== undefined) {
      this.showStatus(t('session.warning', { message: resumeState.warning }), 'warning', {
        transcript: true,
      });
    }
    this.showStatus(statusMessage);
    void this.showSessionWarnings(session);
  }

  async reloadCurrentSessionView(session: Session, statusMessage: string): Promise<void> {
    this.sessionEventUnsubscribe?.();
    this.sessionEventUnsubscribe = undefined;
    this.clearReverseRpcPanels();
    session.setApprovalHandler(undefined);
    session.setQuestionHandler(undefined);
    this.approvalController.cancelAll('reloading session');
    this.questionController.cancelAll('reloading session');

    this.resetSessionRuntime();
    this.session = session;
    this.registerSessionHandlers(session);
    await this.syncRuntimeState(session);
    this.updateTerminalTitle();
    try {
      await this.refreshSkillCommands(session);
      await this.refreshPluginCommands(session);
    } catch {
      /* keep the reloaded session usable even if dynamic skills fail */
    }
    this.sessionEventHandler.startSubscription();
    const resumeState = session.getResumeState();
    if (resumeState?.warning !== undefined) {
      this.showStatus(t('session.warning', { message: resumeState.warning }), 'warning', {
        transcript: true,
      });
    }
    this.showStatus(statusMessage);
    void this.showSessionWarnings(session);
  }

  async createNewSession(): Promise<void> {
    if (this.state.appState.isReplaying) {
      this.showError(t('status.cannotNewWhileReplaying'));
      return;
    }

    let session: Session;
    try {
      session = await this.createSessionFromCurrentState();
    } catch (error) {
      const msg = formatErrorMessage(error);
      this.showError(t('status.newSessionFailed', { message: msg }));
      return;
    }

    this.resetSessionRuntime();
    await this.setSession(session);
    this.setAppState({ sessionId: session.id });
    try {
      await this.activateRuntime();
      await this.syncRuntimeState(session);
    } catch (error) {
      this.sessionEventHandler.startSubscription();
      const msg = formatErrorMessage(error);
      this.showError(t('status.postCreateSetupFailed', { message: msg }));
      return;
    }
    try {
      await this.refreshSkillCommands(this.session);
      await this.refreshPluginCommands(this.session);
    } catch {
      /* keep the new session usable even if dynamic skills fail */
    }
    this.sessionEventHandler.startSubscription();
    this.clearTranscriptAndRedraw();
    this.showStatus(t('status.newSessionStarted', { id: session.id }));
    void this.showSessionWarnings(session);
    void this.showConfigWarningsIfAny();
  }

  /** Surface config.toml load warnings (degraded or kept-previous config) in the status bar. */
  private async showConfigWarningsIfAny(): Promise<void> {
    try {
      const { warnings } = await this.harness.getConfigDiagnostics();
      for (const warning of warnings) {
        this.showStatus(warning, 'warning', { transcript: true });
      }
    } catch {
      /* diagnostics are best-effort */
    }
  }

  // =========================================================================
  // Transcript Rendering
  // =========================================================================

  private createTranscriptComponent(entry: TranscriptEntry): Component | null {
    if (entry.compactionData !== undefined) {
      const data = entry.compactionData;
      const block = new CompactionComponent(this.state.ui, data.instruction);
      if (data.result === 'cancelled') {
        block.markCanceled();
      } else {
        block.markDone(data.tokensBefore, data.tokensAfter, data.summary);
        if (this.state.toolOutputExpanded) {
          block.setExpanded(true);
        }
      }
      return block;
    }

    switch (entry.kind) {
      case 'user': {
        const images = entry.imageAttachmentIds
          ?.map((id) => this.imageStore.get(id))
          .filter((a): a is ImageAttachment => a?.kind === 'image');
        return new UserMessageComponent(entry.content, images, entry.bullet);
      }
      case 'skill_activation':
        return new SkillActivationComponent(
          entry.skillName ?? entry.content,
          entry.skillArgs,
          entry.skillTrigger,
        );
      case 'plugin_command': {
        const data = entry.pluginCommandData;
        if (data === undefined) return null;
        return new PluginCommandComponent(data.pluginId, data.commandName, data.args);
      }
      case 'cron':
        return new CronMessageComponent(entry.content, entry.cronData ?? {});
      case 'goal':
        if (entry.goalData?.kind === 'created') {
          return new GoalSetMessageComponent();
        }
        if (entry.goalData?.kind === 'lifecycle') {
          return buildGoalMarker(entry.goalData.change, this.state.toolOutputExpanded);
        }
        return null;
      case 'assistant': {
        if (entry.content.trimStart().startsWith('✓ Goal complete')) {
          return new GoalCompletionMessageComponent(entry.content);
        }
        const component = new AssistantMessageComponent();
        component.updateContent(entry.content);
        return component;
      }
      case 'thinking': {
        const thinking = new ThinkingComponent(entry.content, true, 'finalized', this.state.ui);
        if (this.state.toolOutputExpanded) thinking.setExpanded(true);
        return thinking;
      }
      case 'tool_call':
        if (entry.toolCallData) {
          const tc = new ToolCallComponent(
            entry.toolCallData,
            entry.toolCallData.result,
            this.state.ui,
            this.state.appState.workDir,
          );
          if (this.state.toolOutputExpanded) tc.setExpanded(true);
          return tc;
        }
        if (entry.backgroundAgentStatus !== undefined) {
          return new BackgroundAgentStatusComponent(entry.backgroundAgentStatus);
        }
        return entry.renderMode === 'notice'
          ? new NoticeMessageComponent(entry.content, entry.detail)
          : new StatusMessageComponent(entry.content, entry.color);
      case 'status':
        if (entry.backgroundAgentStatus !== undefined) {
          return new BackgroundAgentStatusComponent(entry.backgroundAgentStatus);
        }
        return entry.renderMode === 'notice'
          ? new NoticeMessageComponent(entry.content, entry.detail)
          : new StatusMessageComponent(entry.content, entry.color);
      case 'welcome':
        return null;
      default:
        return null;
    }
  }

  appendTranscriptEntry(entry: TranscriptEntry): void {
    this.state.transcriptEntries.push(entry);
    const component = this.createTranscriptComponent(entry);
    if (component) {
      markTranscriptComponent(component, entry);
      this.state.transcriptContainer.addChild(component);
    }
    const trimmed = this.trimTranscriptWindow();
    const merged = this.mergeCurrentTurnSteps();
    if (component || trimmed || merged) {
      this.state.ui.requestRender();
    }
  }

  private appendApprovalTranscriptEntry(
    request: ApprovalRequest,
    response: ApprovalResponse,
  ): void {
    if (
      request.toolName === 'ExitPlanMode' ||
      request.display.kind === 'plan_review' ||
      request.display.kind === 'goal_start'
    )
      return;
    const parts: string[] = [];
    switch (response.decision) {
      case 'approved':
        parts.push(
          response.scope === 'session'
            ? t('status.approval.approvedSession')
            : response.scope === 'always'
              ? t('status.approval.approvedAlways')
              : t('status.approval.approved'),
        );
        break;
      case 'rejected':
        parts.push(t('status.approval.rejected'));
        break;
      case 'cancelled':
        parts.push(t('status.approval.cancelled'));
        break;
    }
    parts.push(`: ${request.action}`);
    if (response.feedback !== undefined && response.feedback.length > 0) {
      parts.push(` — "${response.feedback}"`);
    }
    this.appendTranscriptEntry({
      id: nextTranscriptId(),
      kind: 'status',
      turnId: request.turnId === undefined ? undefined : String(request.turnId),
      renderMode: 'notice',
      content: parts.join(''),
    });
  }

  private renderWelcome(): void {
    if (
      this.state.transcriptContainer.children.some((child) => child instanceof WelcomeComponent)
    ) {
      return;
    }
    const welcome = new WelcomeComponent(this.state.appState);
    this.state.transcriptContainer.addChild(welcome);
  }

  private clearTerminalInlineImages(): void {
    if (getCapabilities().images !== 'kitty') return;
    this.state.terminal.write(deleteAllKittyImages());
  }

  private disposeTranscriptChildren(): void {
    // Dispose disposable children (e.g. ShellRunComponent's 1s timer,
    // ThinkingComponent's spinner) before dropping them, so a /clear, session
    // switch, or shutdown can't leak intervals that keep firing requestRender
    // on a removed component.
    for (const child of this.state.transcriptContainer.children) {
      if (hasDispose(child)) child.dispose();
    }
  }

  private clearTranscriptAndRedraw(): void {
    this.streamingUI.discardPending();
    this.pendingUserEchoId = undefined;
    this.state.transcriptEntries = [];
    this.streamingUI.disposeActiveCompactionBlock();
    this.streamingUI.resetLiveText();
    this.streamingUI.resetToolUi();
    this.sessionEventHandler.stopAllMcpServerStatusSpinners();
    this.disposeTranscriptChildren();
    this.state.transcriptContainer.clear();
    this.btwPanelController.clear();
    this.clearTerminalInlineImages();
    this.state.todoPanel.clear();
    this.state.todoPanelContainer.clear();
    // Drop any lingering transient notice: a session reset starts pristine.
    this.clearNoticeClearTimer();
    this.state.noticeContainer.clear();
    this.state.slotGapContainer.clear();
    this.sessionEventHandler.clearAgentSwarmProgress();
    this.imageStore.clear();
    this.renderWelcome();
    // No forced full render on session reset: let the differential renderer
    // converge on its own (a mass change above the viewport still makes the
    // engine repaint everything, but nothing is forced destructively here).
    this.state.ui.requestRender();
  }

  private isTurnBoundaryComponent(child: Component): boolean {
    if (
      !(child instanceof UserMessageComponent) &&
      !(child instanceof SkillActivationComponent) &&
      !(child instanceof PluginCommandComponent) &&
      !(child instanceof ReplayTurnBoundaryComponent)
    ) {
      return false;
    }
    const entry = getTranscriptComponentEntry(child);
    if (entry === undefined) return false;
    // Live user messages / slash activations have an undefined turnId; replayed
    // ones get a `replay:N` turnId. Both start a new turn. Steer messages carry
    // a defined non-replay turnId and are not boundaries.
    return entry.turnId === undefined || entry.turnId.startsWith('replay:');
  }

  private trimTranscriptWindow(): boolean {
    if (!TRANSCRIPT_WINDOW_ENABLED || TRANSCRIPT_MAX_TURNS <= 0) return false;
    // Session replay already caps history to its own turn limit; trimming during
    // replay would shrink it further and fight that limit.
    if (this.state.appState.isReplaying) return false;

    const children = this.state.transcriptContainer.children;

    // Trim whole turns by *position* in the child list rather than by entry
    // lookup — otherwise only the (registered) user message would be removed and
    // the rest of the turn would be left behind.
    const boundaries: number[] = [];
    for (let i = 0; i < children.length; i++) {
      if (this.isTurnBoundaryComponent(children[i]!)) boundaries.push(i);
    }

    const turns = groupTurns(this.state.transcriptEntries);

    const toRemove = turnsToTrim(turns, TRANSCRIPT_MAX_TURNS, TRANSCRIPT_HYSTERESIS);
    if (toRemove.size === 0) return false;

    // Reclaim image bytes referenced by trimmed user messages. The transcript
    // renders historical thumbnails via imageStore.get(id), so an attachment can
    // only be dropped once its owning user message leaves the transcript.
    for (const entry of toRemove) {
      if (entry.kind === 'user' && entry.imageAttachmentIds !== undefined) {
        this.imageStore.removeMany(entry.imageAttachmentIds);
      }
    }

    let boundariesToRemove = 0;
    for (const entry of toRemove) {
      if (
        (entry.kind === 'user' ||
          entry.kind === 'skill_activation' ||
          entry.kind === 'plugin_command') &&
        entry.turnId === undefined
      ) {
        boundariesToRemove++;
      }
    }
    if (boundariesToRemove === 0) {
      this.state.transcriptEntries = this.state.transcriptEntries.filter((e) => !toRemove.has(e));
      return true;
    }

    let boundariesSeen = 0;
    let cutoff = 0;
    for (let i = 0; i < children.length; i++) {
      if (this.isTurnBoundaryComponent(children[i]!)) {
        if (boundariesSeen === boundariesToRemove) {
          cutoff = i;
          break;
        }
        boundariesSeen++;
      }
    }

    const componentsToRemove: Component[] = [];
    for (let i = 0; i < cutoff; i++) {
      const child = children[i]!;
      if (child instanceof WelcomeComponent) continue;
      componentsToRemove.push(child);
    }
    for (const child of componentsToRemove) {
      // pi-tui Container.removeChild (not a DOM node); `child.remove()` does not exist.
      // oxlint-disable-next-line unicorn/prefer-dom-node-remove
      this.state.transcriptContainer.removeChild(child);
      if (hasDispose(child)) child.dispose();
    }

    this.state.transcriptEntries = this.state.transcriptEntries.filter((e) => !toRemove.has(e));
    return true;
  }

  mergeCurrentTurnSteps(): boolean {
    // Session replay folds every turn in a single mergeAllTurnSteps pass at
    // the end; folding per append here re-scans the whole current turn each
    // time, which is O(n²) over a long replayed turn.
    if (this.state.appState.isReplaying) return false;
    return this.foldCurrentTurnContent(
      TRANSCRIPT_KEEP_RECENT_STEPS,
      TRANSCRIPT_KEEP_RECENT_ASSISTANT,
    );
  }

  /**
   * Fold the just-finished turn's assistant messages down to the completed-turn
   * cap: while a turn is live it may keep TRANSCRIPT_KEEP_RECENT_ASSISTANT
   * messages mounted, but once it ends only the conclusion-bearing tail stays.
   * Called when a turn finishes; the finished turn is still the current one at
   * that point (no newer boundary exists yet).
   */
  mergeCompletedTurnAssistants(): boolean {
    return this.foldCurrentTurnContent(
      TRANSCRIPT_KEEP_RECENT_STEPS,
      TRANSCRIPT_KEEP_RECENT_ASSISTANT_COMPLETED,
    );
  }

  private foldCurrentTurnContent(keepSteps: number, keepAssistants: number): boolean {
    if (keepSteps <= 0 && keepAssistants <= 0) return false;
    const children = this.state.transcriptContainer.children;

    // Find the start of the current turn (last turn-starting user message).
    let turnStart = -1;
    for (let i = children.length - 1; i >= 0; i--) {
      if (this.isTurnBoundaryComponent(children[i]!)) {
        turnStart = i;
        break;
      }
    }
    if (turnStart < 0) return false;

    // Locate an existing summary, the assistant messages, and the mergeable steps.
    let summaryIndex = -1;
    const stepIndices: number[] = [];
    const assistantIndices: number[] = [];
    for (let i = turnStart + 1; i < children.length; i++) {
      const child = children[i]!;
      if (child instanceof StepSummaryComponent) {
        summaryIndex = i;
        continue;
      }
      if (child instanceof AssistantMessageComponent) {
        assistantIndices.push(i);
        continue;
      }
      stepIndices.push(i);
    }

    // Fold the oldest steps / assistant messages beyond their respective caps;
    // the most recent ones stay mounted. Children are chronological, so the
    // oldest of each kind sit at the front of their index lists.
    const stepMergeCount = keepSteps > 0 ? Math.max(0, stepIndices.length - keepSteps) : 0;
    const assistantMergeCount =
      keepAssistants > 0 ? Math.max(0, assistantIndices.length - keepAssistants) : 0;
    if (stepMergeCount === 0 && assistantMergeCount === 0) return false;
    const toMergeIndices = [
      ...stepIndices.slice(0, stepMergeCount),
      ...assistantIndices.slice(0, assistantMergeCount),
    ];

    let thinkingCount = 0;
    let toolCount = 0;
    for (const idx of toMergeIndices) {
      const child = children[idx]!;
      if (child instanceof ThinkingComponent) thinkingCount++;
      else if (child instanceof ToolCallComponent) toolCount++;
    }
    if (thinkingCount === 0 && toolCount === 0 && assistantMergeCount === 0) return false;

    let summary: StepSummaryComponent;
    if (summaryIndex >= 0) {
      summary = children[summaryIndex] as StepSummaryComponent;
      summary.addCounts(thinkingCount, toolCount, assistantMergeCount);
    } else {
      summary = new StepSummaryComponent();
      summary.addCounts(thinkingCount, toolCount, assistantMergeCount);
    }

    // Rebuild children: keep everything except the merged steps, with the summary
    // sitting right after the user message.
    const toMergeSet = new Set(toMergeIndices);
    const newChildren: Component[] = [];
    for (let i = 0; i <= turnStart; i++) newChildren.push(children[i]!);
    newChildren.push(summary);
    for (let i = turnStart + 1; i < children.length; i++) {
      if (i === summaryIndex) continue;
      if (toMergeSet.has(i)) continue;
      newChildren.push(children[i]!);
    }

    for (const idx of toMergeIndices) {
      const child = children[idx]!;
      if (hasDispose(child)) child.dispose();
    }

    children.splice(0, children.length, ...newChildren);
    return true;
  }

  mergeAllTurnSteps(): void {
    if (TRANSCRIPT_KEEP_RECENT_STEPS <= 0 && TRANSCRIPT_KEEP_RECENT_ASSISTANT_COMPLETED <= 0)
      return;
    const children = this.state.transcriptContainer.children;

    const boundaries: number[] = [];
    for (let i = 0; i < children.length; i++) {
      if (this.isTurnBoundaryComponent(children[i]!)) boundaries.push(i);
    }
    if (boundaries.length === 0) return;

    const newChildren: Component[] = [];
    const toDispose: Component[] = [];
    for (let i = 0; i < boundaries[0]!; i++) newChildren.push(children[i]!);

    for (let t = 0; t < boundaries.length; t++) {
      const turnStart = boundaries[t]!;
      const turnEnd = t + 1 < boundaries.length ? boundaries[t + 1]! : children.length;
      newChildren.push(children[turnStart]!);

      let summaryIndex = -1;
      const stepIndices: number[] = [];
      const assistantIndices: number[] = [];
      for (let i = turnStart + 1; i < turnEnd; i++) {
        const child = children[i]!;
        if (child instanceof StepSummaryComponent) summaryIndex = i;
        else if (child instanceof AssistantMessageComponent) assistantIndices.push(i);
        else stepIndices.push(i);
      }

      const stepMergeCount =
        TRANSCRIPT_KEEP_RECENT_STEPS > 0
          ? Math.max(0, stepIndices.length - TRANSCRIPT_KEEP_RECENT_STEPS)
          : 0;
      // Replayed turns are all completed turns, so the stricter completed-turn
      // assistant cap applies (matching what live turns fold to on turn end).
      const assistantMergeCount =
        TRANSCRIPT_KEEP_RECENT_ASSISTANT_COMPLETED > 0
          ? Math.max(0, assistantIndices.length - TRANSCRIPT_KEEP_RECENT_ASSISTANT_COMPLETED)
          : 0;
      const toMergeIndices = [
        ...stepIndices.slice(0, stepMergeCount),
        ...assistantIndices.slice(0, assistantMergeCount),
      ];
      let thinkingCount = 0;
      let toolCount = 0;
      if (toMergeIndices.length > 0) {
        for (const idx of toMergeIndices) {
          const child = children[idx]!;
          if (child instanceof ThinkingComponent) thinkingCount++;
          else if (child instanceof ToolCallComponent) toolCount++;
        }
      }

      // Same zero-count guard as mergeCurrentTurnSteps: when the merge window
      // holds only non-counted cards (approval records, background-task
      // finals, goal markers, compaction cards), merging would dispose them
      // for a summary that renders nothing (0 thinking + 0 tools + 0 folded
      // messages) — replayed history would silently lose rows the live view
      // showed. Overflow assistant messages are counted, so they still fold.
      if (thinkingCount > 0 || toolCount > 0 || assistantMergeCount > 0) {
        let summary: StepSummaryComponent;
        if (summaryIndex >= 0) {
          summary = children[summaryIndex] as StepSummaryComponent;
          summary.addCounts(thinkingCount, toolCount, assistantMergeCount);
        } else {
          summary = new StepSummaryComponent();
          summary.addCounts(thinkingCount, toolCount, assistantMergeCount);
        }
        newChildren.push(summary);
        for (const idx of toMergeIndices) toDispose.push(children[idx]!);
        const toMergeSet = new Set(toMergeIndices);
        for (let i = turnStart + 1; i < turnEnd; i++) {
          if (i === summaryIndex) continue;
          if (toMergeSet.has(i)) continue;
          newChildren.push(children[i]!);
        }
      } else {
        for (let i = turnStart + 1; i < turnEnd; i++) newChildren.push(children[i]!);
      }
    }

    for (const child of toDispose) {
      if (hasDispose(child)) child.dispose();
    }
    children.splice(0, children.length, ...newChildren);
  }

  /**
   * Transient vs. recorded routing (see StatusNoticeOptions for the full
   * classification standard). Transient notices land in the single-slot
   * noticeContainer at the top of the slot, right under the transcript — an
   * anchored area that can never be scrolled away — where the newest notice
   * replaces the previous one instead of stacking, keeping the chrome height
   * bounded. A transient notice also auto-clears after NOTICE_DISPLAY_MS (the
   * timer resets when a newer notice arrives): it is immediate feedback, not
   * a persistent status. Recorded ones keep scrolling with the message flow
   * in the transcript.
   *
   * Note: these lines were never part of transcriptEntries (the export/replay
   * model), so moving transient ones out of the transcript does not change
   * exports or replay.
   */
  private routeStatusNotice(component: Component, options?: StatusNoticeOptions): void {
    if (options?.transcript === true) {
      this.state.transcriptContainer.addChild(component);
    } else {
      const overlay = this.editorSlotOwner?.overlay;
      if (overlay !== undefined) {
        // A floating dialog covers the slot's notice row — show the notice
        // inside the dialog instead of letting it render invisibly.
        overlay.surface.setNotice(component);
      } else {
        this.state.noticeContainer.clear();
        this.state.noticeContainer.addChild(component);
      }
      this.armNoticeClearTimer(component);
    }
    this.state.ui.requestRender();
  }

  private armNoticeClearTimer(component: Component): void {
    this.clearNoticeClearTimer();
    const armedAt = Date.now();
    if (hasNoticeCountdown(component)) {
      component.setCountdown(1);
      // Wall-clock driven: only the gauge text changes between ticks, so a
      // paused render (background tab, heavy output) can never desync it.
      this.noticeCountdownInterval = setInterval(() => {
        if (hasNoticeCountdown(component)) {
          component.setCountdown(Math.max(0, 1 - (Date.now() - armedAt) / NOTICE_DISPLAY_MS));
          this.state.ui.requestRender();
        }
      }, NOTICE_COUNTDOWN_TICK_MS);
    }
    this.noticeClearTimer = setTimeout(() => {
      this.stopNoticeCountdown();
      this.noticeClearTimer = undefined;
      // Clear the armed component wherever it currently lives — its home may
      // have moved (slot notice row ↔ dialog surface) since the timer was
      // armed, and a newer notice may have replaced it in either spot.
      const overlay = this.editorSlotOwner?.overlay;
      if (overlay?.surface.currentNotice === component) {
        overlay.surface.takeNotice();
      }
      if (this.state.noticeContainer.children.includes(component)) {
        this.state.noticeContainer.clear();
      }
      this.state.ui.requestRender();
    }, NOTICE_DISPLAY_MS);
  }

  private stopNoticeCountdown(): void {
    if (this.noticeCountdownInterval === undefined) return;
    clearInterval(this.noticeCountdownInterval);
    this.noticeCountdownInterval = undefined;
  }

  private clearNoticeClearTimer(): void {
    this.stopNoticeCountdown();
    if (this.noticeClearTimer === undefined) return;
    clearTimeout(this.noticeClearTimer);
    this.noticeClearTimer = undefined;
  }

  showStatus(message: string, color?: ColorToken, options?: StatusNoticeOptions): void {
    this.routeStatusNotice(new StatusMessageComponent(message, color), options);
  }

  showNotice(title: string, detail?: string, options?: StatusNoticeOptions): void {
    this.routeStatusNotice(new NoticeMessageComponent(title, detail), options);
  }

  showError(message: string, options?: StatusNoticeOptions): void {
    this.showStatus(t('status.errorPrefix', { message }), 'error', options);
  }

  showLoginProgressSpinner(label: string): LoginProgressSpinnerHandle {
    return this.showProgressSpinner(label);
  }

  showProgressSpinner(label: string): LoginProgressSpinnerHandle {
    const tint = (s: string): string => currentTheme.fg('primary', s);
    const spinner = new MoonLoader(this.state.ui, 'braille', tint, label);
    this.state.transcriptContainer.addChild(new Spacer(1));
    this.state.transcriptContainer.addChild(spinner);
    this.state.ui.requestRender();
    return {
      stop: ({ ok, label: finalLabel }) => {
        spinner.stop();
        const tone = ok ? 'success' : 'error';
        const symbol = ok ? '✓' : '✗';
        spinner.setText(currentTheme.fg(tone, `${symbol} ${finalLabel}`));
        this.state.ui.requestRender();
      },
      setLabel: (nextLabel) => {
        spinner.setLabel(nextLabel);
      },
    };
  }

  showLoginAuthorizationPrompt(auth: DeviceAuthorization): LoginProgressSpinnerHandle {
    openUrl(auth.verificationUriComplete);
    this.state.transcriptContainer.addChild(
      new DeviceCodeBoxComponent({
        title: t('status.login.title'),
        url: auth.verificationUriComplete,
        code: auth.userCode,
        hint: t('status.login.hint'),
      }),
    );
    this.state.ui.requestRender();
    return this.showLoginProgressSpinner(t('status.login.waiting'));
  }

  // =========================================================================
  // Panes / Presentation State
  // =========================================================================

  updateActivityPane(): void {
    const effectiveMode = this.resolveActivityPaneMode();
    const tipKind = loadingTipKind(effectiveMode);
    // Pick a fresh loading tip when the loading kind changes. The same kind
    // covers waiting/tool (both moon spinners) and any intermediate thinking
    // phase, so a continuous burst of tool calls does not flip tips. Clear the
    // cache only when there is no loading UI at all.
    if (effectiveMode === 'idle' || effectiveMode === 'session' || effectiveMode === 'hidden') {
      this.currentLoadingTip = undefined;
    } else if (
      tipKind !== undefined &&
      (this.currentLoadingTip === undefined || this.currentLoadingTip.kind !== tipKind)
    ) {
      const previousTip = this.currentLoadingTip?.tip;
      this.currentLoadingTip = {
        kind: tipKind,
        tip: pickRandomWorkingTip(previousTip)?.text,
      };
    }
    this.syncTerminalProgress(this.shouldShowTerminalProgress(effectiveMode));
    const placeSpinnerInAgentSwarm = this.shouldPlaceActivitySpinnerInAgentSwarm(effectiveMode);
    const activityModeKey = `${effectiveMode}:${placeSpinnerInAgentSwarm ? 'swarm' : 'pane'}`;

    if (
      activityModeKey === this.lastActivityMode &&
      (effectiveMode === 'waiting' || effectiveMode === 'thinking' || effectiveMode === 'tool')
    ) {
      if (placeSpinnerInAgentSwarm) {
        this.syncAgentSwarmActivitySpinner(this.state.activitySpinner?.instance);
      }
      return;
    }

    this.lastActivityMode = activityModeKey;
    this.state.activityContainer.clear();
    this.state.slotGapContainer.clear();

    switch (effectiveMode) {
      case 'hidden':
        this.stopActivitySpinner();
        this.syncAgentSwarmActivitySpinner(undefined);
        this.state.ui.requestRender();
        return;
      case 'waiting': {
        const spinner = this.ensureActivitySpinner('moon');
        this.syncAgentSwarmActivitySpinner(placeSpinnerInAgentSwarm ? spinner : undefined);
        if (placeSpinnerInAgentSwarm) break;
        this.state.activityContainer.addChild(
          new ActivityPaneComponent({
            mode: 'waiting',
            spinner,
            tip: resolveTipText(this.currentLoadingTip?.tip),
          }),
        );
        break;
      }
      case 'thinking': {
        this.stopActivitySpinner();
        this.syncAgentSwarmActivitySpinner(undefined);
        break;
      }
      case 'composing': {
        const spinner = this.ensureActivitySpinner('braille', t('status.working'), (s) =>
          currentTheme.fg('primary', s),
        );
        this.syncAgentSwarmActivitySpinner(undefined);
        this.state.activityContainer.addChild(
          new ActivityPaneComponent({
            mode: 'composing',
            spinner,
            tip: resolveTipText(this.currentLoadingTip?.tip),
          }),
        );
        break;
      }
      case 'tool': {
        const spinner = this.ensureActivitySpinner('moon');
        this.syncAgentSwarmActivitySpinner(placeSpinnerInAgentSwarm ? spinner : undefined);
        if (placeSpinnerInAgentSwarm) break;
        this.state.activityContainer.addChild(
          new ActivityPaneComponent({
            mode: 'tool',
            spinner,
            tip: resolveTipText(this.currentLoadingTip?.tip),
          }),
        );
        break;
      }
      case 'idle':
      case 'session': {
        this.stopActivitySpinner();
        this.syncAgentSwarmActivitySpinner(undefined);
        // Keep a placeholder row so the slot does not shrink when the spinner
        // is removed at the end of streaming; combined with pi-tui's clamp,
        // this avoids a destructive full redraw (viewport jump). The row heads
        // the slot: the blank separates transcript from status chrome instead
        // of sitting between the notice row and the editor.
        this.state.slotGapContainer.addChild(new Spacer(1));
        break;
      }
    }
    this.state.ui.requestRender();
  }

  private resolveActivityPaneMode(): EffectiveActivityPaneMode {
    if (this.state.activeDialog === 'session-picker') return 'hidden';
    if (this.state.livePane.pendingApproval !== null) return 'hidden';
    if (this.state.appState.isCompacting) return 'hidden';
    if (this.state.livePane.pendingQuestion !== null) return 'hidden';

    const streamingPhase = this.state.appState.streamingPhase;

    // A running `!` shell command shows the moon spinner (same as `waiting`)
    // until it finishes, signalling that input is busy / queued.
    if (streamingPhase === 'shell') return 'waiting';

    if (this.state.livePane.mode === 'idle') {
      if (streamingPhase === 'thinking' || streamingPhase === 'composing') {
        return streamingPhase;
      }
    }

    return this.state.livePane.mode;
  }

  updateQueueDisplay(): void {
    this.state.queueContainer.clear();
    const queued = this.state.queuedMessages;
    if (queued.length === 0) return;

    this.state.queueContainer.addChild(
      new QueuePaneComponent({
        messages: queued,
        isCompacting: this.state.appState.isCompacting,
        isStreaming: this.state.appState.streamingPhase !== 'idle',
        canSteerImmediately: !this.deferUserMessages,
      }),
    );
  }

  toggleToolOutputExpansion(): void {
    this.state.toolOutputExpanded = !this.state.toolOutputExpanded;
    const children = this.state.transcriptContainer.children;

    // A component is expandable only if it sits at or after the start of the
    // (totalTurns - expandTurns)-th turn — i.e. it belongs to one of the most
    // recent `expandTurns` turns. Position-based so it also covers streaming
    // components that have no entry in the metadata map.
    const boundaries: number[] = [];
    for (let i = 0; i < children.length; i++) {
      if (this.isTurnBoundaryComponent(children[i]!)) boundaries.push(i);
    }
    const expandCutoff =
      TRANSCRIPT_EXPAND_TURNS <= 0
        ? children.length
        : boundaries.length > TRANSCRIPT_EXPAND_TURNS
          ? boundaries[boundaries.length - TRANSCRIPT_EXPAND_TURNS]!
          : 0;

    for (let i = 0; i < children.length; i++) {
      const child = children[i]!;
      if (isExpandable(child)) {
        child.setExpanded(this.state.toolOutputExpanded && i >= expandCutoff);
      }
      // The collapse pass is a collapse-ALL: individually click-expanded
      // cards (tool groups never take keyboard expansion, so the loop above
      // skips them) fold along with everything else.
      if (!this.state.toolOutputExpanded && isClickExpandable(child)) {
        child.setClickExpanded(false);
      }
    }
    // Expanding/collapsing shifts content above the viewport; in inline mode
    // the clamped differential render would paint a second copy below the stale
    // one in scrollback, so keep the destructive full render there. Fullscreen
    // frames are recomposed from scratch anyway — the force flag is harmless.
    this.state.ui.requestRender(true);

  }

  toggleTodoPanelExpansion(): void {
    this.state.todoPanel.toggleExpanded();
    this.state.ui.requestRender();
  }

  private async detachRunningShellCommand(): Promise<void> {
    // Only one `!` command runs at a time (input is queued while busy).
    const next = this.shellOutputStreams.entries().next();
    if (next.done) {
      this.showDetachHint(t('status.detach.noShellCommand'));
      return;
    }
    const [commandId, stream] = next.value;
    if (stream.taskId === undefined) {
      this.showDetachHint(t('status.detach.commandStarting'));
      return;
    }
    const session = this.session;
    if (session === undefined) return;
    try {
      const info = await session.detachBackgroundTask(stream.taskId);
      if (info === undefined) {
        this.showDetachHint(t('status.detach.commandFinished'));
        return;
      }
    } catch (error) {
      this.showError(t('status.detach.failed', { message: formatErrorMessage(error) }));
      return;
    }
    // Finalize the card as backgrounded and drop the stream so the eventual
    // runShellCommand resolution (which carries background metadata) is a no-op
    // instead of overwriting this view.
    stream.component.finishBackgrounded();
    stream.entry.content = t('status.detach.moved');
    this.shellOutputStreams.delete(commandId);
    // The backgrounded command's notification turn (started by agent-core via
    // appendSystemReminderAndNotify) owns the streaming phase and drains the
    // queue when it completes, so we intentionally leave both untouched here.
    this.showDetachHint(t('status.detach.movedHint'));
  }

  async detachCurrentForegroundTask(): Promise<void> {
    // A running `!` shell command takes priority over agent foreground tasks.
    if (this.shellOutputStreams.size > 0) {
      await this.detachRunningShellCommand();
      return;
    }

    const session = this.session;
    if (session === undefined) {
      this.showError(resolveDescription(NO_ACTIVE_SESSION_MESSAGE));
      return;
    }

    let tasks: readonly BackgroundTaskInfo[];
    try {
      // activeOnly defaults to true; foreground running tasks are non-terminal
      // and therefore included. We filter to `detached === false` ourselves.
      tasks = await session.listBackgroundTasks();
    } catch (error) {
      this.showError(t('status.detach.listTasksFailed', { message: formatErrorMessage(error) }));
      return;
    }

    const targets = pickForegroundTasks(tasks);
    if (targets.length === 0) {
      this.showDetachHint(t('status.detach.noForegroundTask'));
      return;
    }

    let detached = 0;
    let alreadyFinished = 0;
    for (const target of targets) {
      try {
        const info = await session.detachBackgroundTask(target.taskId);
        if (info === undefined) alreadyFinished++;
        else detached++;
      } catch (error) {
        this.showError(
          t('status.detach.taskFailed', { id: target.taskId, message: formatErrorMessage(error) }),
        );
      }
    }

    let hint: string;
    if (detached === 0 && alreadyFinished > 0) {
      hint = t(
        alreadyFinished === 1
          ? 'status.detach.tasksFinished.one'
          : 'status.detach.tasksFinished.other',
      );
    } else if (detached === targets.length) {
      hint = t(detached === 1 ? 'status.detach.movedTasks.one' : 'status.detach.movedTasks.other', {
        count: detached,
      });
    } else {
      hint = t('status.detach.movedTasksPartial', { detached, total: targets.length });
    }
    if (detached > 0) hint = `${hint} ${t('status.detach.viewTasks')}`;
    this.showDetachHint(hint);
  }

  /** Show a one-shot footer hint that auto-clears after DETACH_HINT_DISPLAY_MS. */
  private showDetachHint(hint: string): void {
    if (this.detachHintClearTimer !== undefined) {
      clearTimeout(this.detachHintClearTimer);
      this.detachHintClearTimer = undefined;
    }
    this.state.footer.setTransientHint(hint);
    this.detachHintClearTimer = setTimeout(() => {
      this.detachHintClearTimer = undefined;
      // Don't clobber a newer transient hint (e.g. the exit-confirmation
      // prompt) that took over while this timer was pending.
      if (this.state.footer.getTransientHint() !== hint) return;
      this.state.footer.setTransientHint(null);
      this.state.ui.requestRender();
    }, DETACH_HINT_DISPLAY_MS);
    this.state.ui.requestRender();
  }

  updateEditorBorderHighlight(text?: string): void {
    const trimmed = (text ?? this.state.editor.getText()).trimStart();
    const isBash = this.state.appState.inputMode === 'bash';
    const highlighted = this.state.appState.planMode || isBash || trimmed.startsWith('/');
    this.state.editor.borderHighlighted = highlighted;
    // Shell mode gets its own hue; plan-mode and slash context stay primary.
    const borderToken = isBash ? 'shellMode' : highlighted ? 'primary' : 'border';
    this.state.editor.borderColor = (s: string) => currentTheme.fg(borderToken, s);
    this.state.ui.requestRender();
  }

  async applyTheme(themeName: ThemeName, resolved?: ResolvedTheme): Promise<void> {
    const palette = await getColorPalette(themeName === 'auto' ? (resolved ?? 'dark') : themeName);
    currentTheme.setPalette(palette);
    this.setAppState({ theme: themeName });
    this.updateEditorBorderHighlight();
    // Force everything to re-render: Markdown/Text caches (which hold old
    // ANSI colour codes) live all over the tree, including the slot chrome
    // (notice/activity/footer), not just the transcript.
    this.state.ui.invalidate();
    this.state.ui.requestRender(true);
  }

  /**
   * Hot-switch the UI language (mirrors {@link applyTheme}): update the i18n
   * singleton, hand the model-facing language name to the agent core (one
   * system-prompt refresh per switch), then repaint. Chrome components
   * (welcome/footer/help/selectors) compute strings in render(), so they
   * pick the new locale up on the next frame; historical transcript entries
   * intentionally keep the language they were created in.
   */
  async applyLanguage(pref: LocalePreference): Promise<void> {
    setLocalePreference(pref);
    setUserLanguage(userLanguageNameForModel(pref));
    this.setAppState({ language: pref });
    // Registry descriptions are materialized into autocomplete items at
    // setup time; rebuild them in the new language (the /reload path).
    this.refreshSlashCommandAutocomplete();
    this.state.ui.invalidate();
    this.state.ui.requestRender(true);
  }

  refreshTerminalThemeTracking(): void {
    this.stopTerminalThemeTracking();
    if (!isBuiltInTheme(this.state.appState.theme) || this.state.appState.theme !== 'auto') return;

    this.terminalThemeTrackingDispose = installTerminalThemeTracking(this.state, (resolved) => {
      void this.applyResolvedAutoTheme(resolved);
    });
  }

  private stopTerminalThemeTracking(): void {
    this.terminalThemeTrackingDispose?.();
    this.terminalThemeTrackingDispose = undefined;
  }

  private async applyResolvedAutoTheme(resolved: ResolvedTheme): Promise<void> {
    if (this.state.appState.theme !== 'auto') return;
    const palette = getBuiltInPalette(resolved);
    if (currentTheme.palette === palette) return;
    currentTheme.setPalette(palette);
    this.updateEditorBorderHighlight();
    // Repaint already-rendered transcript entries (status/markdown caches hold
    // old ANSI codes), matching applyTheme()'s behaviour.
    this.state.ui.invalidate();
    this.state.ui.requestRender(true);
  }

  private shouldShowTerminalProgress(effectiveMode: EffectiveActivityPaneMode): boolean {
    if (this.state.appState.isCompacting) return true;
    return (
      effectiveMode === 'waiting' ||
      effectiveMode === 'thinking' ||
      effectiveMode === 'composing' ||
      effectiveMode === 'tool'
    );
  }

  private shouldPlaceActivitySpinnerInAgentSwarm(
    effectiveMode: EffectiveActivityPaneMode,
  ): boolean {
    return (
      this.sessionEventHandler.hasActiveAgentSwarmToolCall() &&
      (effectiveMode === 'waiting' || effectiveMode === 'tool')
    );
  }

  private syncAgentSwarmActivitySpinner(spinner: MoonLoader | undefined): void {
    this.sessionEventHandler.syncAgentSwarmActivitySpinner(spinner);
  }

  private syncTerminalProgress(active: boolean): void {
    if (!this.state.terminalState.supportsProgress) return;
    if (this.state.terminalState.progressActive === active) return;
    this.state.terminal.setProgress(active);
    this.state.terminalState.progressActive = active;
  }

  private ensureActivitySpinner(
    style: SpinnerStyle,
    label = '',
    colorFn?: (s: string) => string,
  ): MoonLoader {
    if (this.state.activitySpinner?.style !== style) {
      this.stopActivitySpinner();
    }

    if (this.state.activitySpinner === null) {
      const instance = new MoonLoader(this.state.ui, style, colorFn, label);
      this.state.activitySpinner = { instance, style };
      return instance;
    }

    this.state.activitySpinner.instance.setLabel(label);
    if (colorFn !== undefined) {
      this.state.activitySpinner.instance.setColorFn(colorFn);
    }
    return this.state.activitySpinner.instance;
  }

  private stopActivitySpinner(): void {
    if (this.state.activitySpinner !== null) {
      this.state.activitySpinner.instance.stop();
      this.state.activitySpinner = null;
    }
  }

  // =========================================================================
  // Dialogs / Selectors
  // =========================================================================

  // Editor slot ownership: a replacement panel holds the slot until its own
  // handle comes back through restoreEditor. Async dialogs used to close with
  // an unconditional editorContainer.clear(), which wiped any panel mounted
  // meanwhile (e.g. an approval arriving mid-resume) and hung the agent on an
  // unanswered RPC. See editor-slot.ts for the kind/preempt/queue semantics.
  //
  // Presentation: in fullscreen mode dialog-kind panels don't replace the
  // editor — they float as a bottom-anchored overlay (FloatingDialogSurface,
  // Claude's modal-slot analogue) while the editor stays mounted, so the slot
  // never grows and the transcript doesn't jump. The owner record keeps the
  // overlay handle so preempt/close can take the overlay down. Blocking panels
  // (approval/question) and inline mode keep the slot replacement.
  private editorSlotNextId = 1;
  private editorSlotOwner: {
    readonly handle: EditorSlotHandle;
    readonly kind: EditorSlotKind;
    readonly onPreempt?: () => void;
    overlay?: {
      readonly handle: OverlayHandle;
      readonly surface: FloatingDialogSurface;
    };
  } | null = null;
  private editorSlotQueue: Array<{
    readonly handle: EditorSlotHandle;
    readonly panel: Component & Focusable;
    readonly options: EditorSlotMountOptions;
  }> = [];

  mountEditorReplacement(
    panel: Component & Focusable,
    options: EditorSlotMountOptions = {},
  ): EditorSlotHandle {
    const handle: EditorSlotHandle = { id: this.editorSlotNextId++ };
    const kind = options.kind ?? 'dialog';
    const owner = this.editorSlotOwner;
    if (owner !== null) {
      const preempts = owner.kind === 'dialog';
      if (!preempts) {
        // blocking-over-blocking, or a dialog arriving while a blocking panel
        // owns the slot: queue until the slot frees instead of clobbering an
        // unanswered approval/question (its RPC would hang with no visible UI).
        this.editorSlotQueue.push({ handle, panel, options });
        return handle;
      }
      // Take ownership first so the preempted panel's own restoreEditor call
      // (inside onPreempt) mismatches and no-ops instead of restoring mid-swap.
      this.editorSlotOwner = { handle, kind, onPreempt: options.onPreempt };
      // A live notice rides along to the replacement surface (or back to the
      // slot's notice row when the next panel mounts in the slot).
      const carriedNotice = owner.overlay?.surface.takeNotice();
      owner.overlay?.handle.hide();
      owner.onPreempt?.();
      if (carriedNotice !== undefined) {
        this.pendingCarriedNotice = carriedNotice;
      }
    } else {
      this.editorSlotOwner = { handle, kind, onPreempt: options.onPreempt };
    }
    this.mountIntoEditorSlot(panel, kind);
    return handle;
  }

  private pendingCarriedNotice: Component | undefined;

  private mountIntoEditorSlot(panel: Component & Focusable, kind: EditorSlotKind): void {
    // A takeover (tasks/workflows browser, approval preview) swapped the real
    // layout out of ui.children. Mounting a panel into that hidden tree would
    // leave it invisible while it owns the keyboard — the user would answer
    // approvals blindly or think the UI froze. Close any takeover first.
    if (this.approvalPreview !== undefined) this.closeApprovalPreview();
    this.tasksBrowserController.close();
    this.workflowsBrowserController.close();
    this.teamsBrowserController.close();
    if (kind === 'dialog' && this.state.ui.getFullscreen()) {
      // Floating dialog: same chrome as the slot presentation (gutter + `▔`
      // separator) on a bottom-anchored overlay that covers the lower
      // transcript rows and the input area. The editor stays mounted, so the
      // slot keeps its height and the transcript doesn't jump. The overlay
      // hides itself while a takeover owns the screen; pi-tui's focus-restore
      // state machine hands the keyboard back when the takeover closes.
      const surface = new FloatingDialogSurface(CHROME_GUTTER, CHROME_GUTTER, panel);
      const overlayHandle = this.state.ui.showOverlay(surface, {
        width: '100%',
        anchor: 'bottom-left',
        visible: () => !this.isAnyTakeoverActive(),
      });
      if (this.editorSlotOwner !== null) {
        this.editorSlotOwner.overlay = { handle: overlayHandle, surface };
      }
      const carried = this.pendingCarriedNotice;
      this.pendingCarriedNotice = undefined;
      if (carried !== undefined) surface.setNotice(carried);
      return;
    }
    this.state.editorContainer.clear();
    // Panel-style dialogs get a `▔` top divider separating them from the
    // transcript above (kept out of the child list: children[0] === panel).
    this.state.editorContainer.topSeparator = true;
    this.state.editorContainer.addChild(panel);
    const carried = this.pendingCarriedNotice;
    this.pendingCarriedNotice = undefined;
    if (carried !== undefined) {
      this.state.noticeContainer.clear();
      this.state.noticeContainer.addChild(carried);
    }
    this.state.ui.setFocus(panel);
    this.state.ui.requestRender();
  }

  /**
   * True while any children-snapshot takeover (approval preview, tasks /
   * workflows / teams browser) has the real layout swapped out of ui.children
   * and holds the keyboard.
   */
  private isAnyTakeoverActive(): boolean {
    return (
      this.approvalPreview !== undefined ||
      this.state.tasksBrowser !== undefined ||
      this.state.workflowsBrowser !== undefined ||
      this.state.teamsBrowser !== undefined
    );
  }

  /** Put the real editor back into the editor slot after a slot-mounted panel. */
  private restoreEditorToSlot(): void {
    this.state.editorContainer.clear();
    this.state.editorContainer.topSeparator = false;
    this.state.editorContainer.addChild(this.state.editor);
  }

  restoreEditor(handle?: EditorSlotHandle): void {
    if (handle !== undefined) {
      const queuedIndex = this.editorSlotQueue.findIndex((entry) => entry.handle === handle);
      if (queuedIndex >= 0) {
        // Resolved while still queued (e.g. guardian auto-approval): never mount.
        this.editorSlotQueue.splice(queuedIndex, 1);
        return;
      }
      if (this.editorSlotOwner?.handle !== handle) {
        // Stale close from a preempted panel — the new owner stays.
        return;
      }
    }
    const previousOwner = this.editorSlotOwner;
    this.editorSlotOwner = null;
    previousOwner?.overlay?.handle.hide();
    const next = this.editorSlotQueue.shift();
    if (next !== undefined) {
      this.editorSlotOwner = {
        handle: next.handle,
        kind: next.options.kind ?? 'dialog',
        onPreempt: next.options.onPreempt,
      };
      if (previousOwner !== null && previousOwner.overlay === undefined) {
        // The outgoing panel was slot-mounted: put the editor back before a
        // queued dialog floats above the slot (a slot-mounted next panel just
        // clears the container again — harmless).
        this.restoreEditorToSlot();
      }
      this.mountIntoEditorSlot(next.panel, next.options.kind ?? 'dialog');
      return;
    }
    if (previousOwner?.overlay !== undefined) {
      // A floating dialog closed: re-home a live notice to the slot's notice
      // row so it stays visible for the rest of its display window.
      const liveNotice = previousOwner.overlay.surface.takeNotice();
      if (liveNotice !== undefined) {
        this.state.noticeContainer.clear();
        this.state.noticeContainer.addChild(liveNotice);
      }
      // The editor never left the slot, so there is
      // no layout to restore and nothing to repaint — just hand the keyboard
      // back (while a takeover holds it, leave focus where it is).
      if (!this.isAnyTakeoverActive()) {
        this.state.ui.setFocus(this.state.editor);
      }
      this.state.ui.requestRender();
      return;
    }
    this.restoreEditorToSlot();
    // While a full-screen takeover holds the keyboard, leave focus where it
    // is: the takeover's own close path restores focus to the slot content.
    // Moving focus here would hand the keyboard to the hidden editor (e.g. a
    // guardian auto-approval resolving a panel under an open browser).
    if (!this.isAnyTakeoverActive()) {
      this.state.ui.setFocus(this.state.editor);
    }
    if (this.state.ui.getFullscreen()) {
      // Fullscreen frames are recomposed every render: a taller panel simply
      // shrinks the slot again, no destructive clear/home is ever needed.
      this.state.ui.requestRender();
      return;
    }
    // Measure overflow against the restored tree (editor mounted), not the tall
    // panel just removed — otherwise a short session with a tall panel looks like
    // it overflows and we take a viewport repaint that yanks the editor to the top.
    // Treat an exact one-screen fill as overflowing too: a repaint is safe
    // there (no blank tail) and clears a stale viewport offset after a shrink.
    // Measure content WITHOUT the bottom-anchor filler: the root pads short
    // sessions to exactly one screen, so the padded render length would always
    // be >= rows and every dialog close in a short session would force the
    // viewport repaint below.
    const { columns, rows } = this.state.terminal;
    this.state.ui.render(columns);
    const overflowsViewport = this.state.rootContainer.contentLines >= rows;
    // Repaint the viewport after replacing a tall panel with the shorter
    // editor: differential rendering leaves the editor shifted up when the
    // bottom-anchored region shrinks in place. The collapse repaint rewrites
    // the visible region in place and erases the leftover rows below, so the
    // native scrollback survives (a destructive full clear would wipe it).
    // Skip under tmux (its own reflow handles the shrink) and when content
    // fits on one screen (a full repaint would pull the editor up).
    if (!this.state.terminalState.insideTmux && overflowsViewport) {
      this.state.ui.requestCollapseRender();
    } else {
      this.state.ui.requestRender();
    }

  }

  restoreInputText(text: string): void {
    this.restoreEditor();
    this.state.editor.setText(text);
    this.updateEditorBorderHighlight(text);
    this.state.ui.requestRender();
  }

  private helpPanelHandle: EditorSlotHandle | undefined;


  showHelpPanel(): void {
    this.state.activeDialog = 'help';
    this.helpPanelHandle = this.mountEditorReplacement(
      new HelpPanelComponent({
        // Builtin descriptions are i18n keys resolved at assembly time;
        // plugin/skill descriptions pass through unchanged.
        commands: this.getSlashCommands().map((cmd) => ({
          ...cmd,
          description: resolveDescription(cmd.description),
        })),
        // NORMAL-mode keys are only documented when vim editing is live
        // (tui.toml editor.vim_mode or a session /vim toggle).
        vimShortcuts: this.state.editor.isVimEnabled() ? VIM_NORMAL_SHORTCUTS : undefined,
        onClose: () => {
          this.hideHelpPanel();
        },
        // Clicking a command row closes the panel and seeds the composer
        // with the command, ready for arguments — the row's only useful
        // "open" action (rows carry name/aliases/description, no detail
        // page to expand into). setText keeps the draft undoable (Ctrl+-).
        onCommandClick: (command) => {
          this.hideHelpPanel();
          this.restoreInputText(`/${command.name} `);
        },
        // Live getter (not a snapshot): a resize while /help is open
        // re-caps the list so the title/borders stay inside the viewport.
        terminalRows: () => this.state.terminal.rows,
      }),
      {
        onPreempt: () => {
          this.hideHelpPanel();
        },
      },
    );
  }

  private hideHelpPanel(): void {
    this.state.activeDialog = null;
    const handle = this.helpPanelHandle;
    this.helpPanelHandle = undefined;
    // A preempted dialog already ran this once via onPreempt: the second call
    // finds no handle and must not force-restore over the preempting panel.
    if (handle !== undefined) this.restoreEditor(handle);
  }

  private sessionPickerOptions: {
    readonly applyStartupModes: boolean;
    readonly closeOnCancel: boolean;
    readonly forwardEditorExit: boolean;
  } = {
    applyStartupModes: false,
    closeOnCancel: false,
    forwardEditorExit: false,
  };
  private sessionPickerScopeRequestToken = 0;
  // Busy latch for picker Enter — see mountSessionPicker's onSelect.
  private sessionPickerSelectInFlight = false;
  private sessionPickerHandle: EditorSlotHandle | undefined;

  async showSessionPicker(): Promise<void> {
    await this.openSessionPicker({
      applyStartupModes: false,
      closeOnCancel: false,
      forwardEditorExit: false,
    });
  }

  private async bootstrapFromPicker(): Promise<void> {
    await this.openSessionPicker({
      applyStartupModes: true,
      closeOnCancel: true,
      forwardEditorExit: true,
    });
  }

  private async openSessionPicker(options: {
    readonly applyStartupModes: boolean;
    readonly closeOnCancel: boolean;
    readonly forwardEditorExit: boolean;
  }): Promise<void> {
    this.sessionPickerOptions = options;
    await this.fetchSessions('cwd');
    this.mountSessionPicker({
      applyStartupModes: options.applyStartupModes,
      onCancel: () => {
        this.hideSessionPicker();
        if (options.closeOnCancel) void this.stop();
      },
      onCtrlC: options.forwardEditorExit
        ? () => {
            this.state.editor.onCtrlC?.();
          }
        : undefined,
      onCtrlD: options.forwardEditorExit
        ? () => {
            this.state.editor.onCtrlD?.();
          }
        : undefined,
    });
  }

  private async toggleSessionPickerScope(selectedSessionId: string): Promise<void> {
    const requestToken = ++this.sessionPickerScopeRequestToken;
    const nextScope = this.state.sessionsScope === 'cwd' ? 'all' : 'cwd';
    await this.fetchSessions(nextScope);
    if (requestToken !== this.sessionPickerScopeRequestToken) return;
    if (this.state.activeDialog !== 'session-picker') return;
    this.mountSessionPicker({
      initialSelectedSessionId: selectedSessionId,
      applyStartupModes: this.sessionPickerOptions.applyStartupModes,
      onCancel: () => {
        this.hideSessionPicker();
        if (this.sessionPickerOptions.closeOnCancel) void this.stop();
      },
      onCtrlC: this.sessionPickerOptions.forwardEditorExit
        ? () => {
            this.state.editor.onCtrlC?.();
          }
        : undefined,
      onCtrlD: this.sessionPickerOptions.forwardEditorExit
        ? () => {
            this.state.editor.onCtrlD?.();
          }
        : undefined,
    });
  }

  hideSessionPicker(): void {
    this.sessionPickerScopeRequestToken += 1;
    this.editorKeyboard.clearPendingExit();
    this.state.activeDialog = null;
    const handle = this.sessionPickerHandle;
    this.sessionPickerHandle = undefined;
    if (handle !== undefined) this.restoreEditor(handle);
  }

  openUndoSelector(): void {
    void slashCommands.handleUndoCommand(this, '');
  }

  private mountSessionPicker(options: {
    readonly onCancel: () => void;
    readonly onCtrlC?: () => void;
    readonly onCtrlD?: () => void;
    readonly initialSelectedSessionId?: string;
    // CLI mode flags (--auto/--yolo/--plan) target the session picked at
    // startup (bare --session); later /sessions switches keep the picked
    // session's own persisted modes.
    readonly applyStartupModes?: boolean;
  }): void {
    // Note: preempt semantics run hideSessionPicker only — never the caller's
    // onCancel (a startup bootstrap picker must not stop the app because an
    // approval arrived). activeDialog is set after the mount because a
    // scope-toggle remount preempts the previous picker and its onPreempt
    // clears the flag first.
    this.sessionPickerHandle = this.mountEditorReplacement(
      new SessionPickerComponent({
        sessions: this.state.sessions,
        loading: this.state.loadingSessions,
        currentSessionId: this.state.appState.sessionId,
        scope: this.state.sessionsScope,
        initialSelectedSessionId: options.initialSelectedSessionId,
        pageSize: 50,
        onSelect: (session: SessionRow) => {
          // Serialize the switch: handleSessionPickerSelect runs a multi-step
          // async resume (reset → setSession → clear → hydrate → subscribe)
          // while the picker stays mounted, so a double Enter (or an Enter
          // after a scope-toggle remount) would interleave two switches and
          // split the session state from the rendered transcript. The latch
          // releases on failure so the still-open picker stays usable.
          if (this.sessionPickerSelectInFlight) return;
          this.sessionPickerSelectInFlight = true;
          void this.handleSessionPickerSelect(session, options.applyStartupModes === true)
            .catch((error) => {
              this.showError(
                t('status.applyStartupFlagsFailed', { message: formatErrorMessage(error) }),
              );
            })
            .finally(() => {
              this.sessionPickerSelectInFlight = false;
            });
        },
        onCancel: options.onCancel,
        onCtrlC: options.onCtrlC,
        onCtrlD: options.onCtrlD,
        onToggleScope: (selectedSessionId: string) => {
          void this.toggleSessionPickerScope(selectedSessionId);
        },
      }),
      {
        onPreempt: () => {
          this.hideSessionPicker();
        },
      },
    );
    this.state.activeDialog = 'session-picker';
  }

  private async handleSessionPickerSelect(
    session: SessionRow,
    applyStartupModes: boolean,
  ): Promise<void> {
    if (resolve(session.work_dir) !== resolve(this.state.appState.workDir)) {
      await this.showResumeOtherWorkDirHint(session);
      if (applyStartupModes) await this.stop(0);
      return;
    }

    const switched = await this.resumeSession(session.id);
    if (!switched) return;
    if (applyStartupModes) {
      await this.applyStartupModesToResumedSession(this.requireSession());
      this.applyStartupPermissionAndPlanToAppState();
    }
    this.hideSessionPicker();
  }

  private showApprovalPanel(payload: ApprovalPanelData): void {
    this.patchLivePane({ pendingApproval: { data: payload } });
    notifyTerminalOnce(this.state, `approval:${payload.id}`, {
      title: t('status.notify.approvalRequired'),
      body: payload.tool_name,
    });
    const panel = new ApprovalPanelComponent(
      { data: payload },
      (response: ApprovalPanelResponse) => {
        this.approvalController.respond(adaptPanelResponse(response));
      },
      () => {
        this.toggleToolOutputExpansion();
      },
      (block) => {
        this.openApprovalPreview(panel, block);
      },
      () => {
        this.approvalController.noteUserInteraction();
      },
    );
    this.activeApprovalPanel = panel;
    this.activeApprovalHandle = this.mountEditorReplacement(panel, { kind: 'blocking' });
  }

  private activeApprovalHandle: EditorSlotHandle | undefined;

  private hideApprovalPanel(): void {
    // If the full-screen preview is open, fold it back first so the saved-
    // children stack stays consistent with what mountEditorReplacement set up.
    if (this.approvalPreview !== undefined) this.closeApprovalPreview();
    this.activeApprovalPanel = undefined;
    const handle = this.activeApprovalHandle;
    this.activeApprovalHandle = undefined;
    this.patchLivePane({ pendingApproval: null });
    if (handle !== undefined) this.restoreEditor(handle);
  }

  // Mounts the full-screen approval preview viewer on top of the current
  // approval panel. Uses the same nested-takeover pattern as
  // openTaskOutputViewer: we snapshot the root container's children, swap
  // in the viewer, and restore on close. The approval panel instance is
  // kept around in `activeApprovalPanel` so its selection state survives.
  private openApprovalPreview(panel: ApprovalPanelComponent, block: ApprovalPreviewBlock): void {
    if (this.approvalPreview !== undefined) return;
    const savedChildren = [...this.state.ui.children];
    const viewer = new ApprovalPreviewViewer(
      {
        block,
        onClose: () => {
          this.closeApprovalPreview();
        },
      },
      this.state.terminal,
    );
    this.state.ui.clear();
    this.state.ui.addChild(viewer);
    this.state.ui.setFocus(viewer);
    this.state.ui.requestRender(true);
    this.approvalPreview = { component: viewer, savedChildren, panel };
  }

  private closeApprovalPreview(): void {
    const preview = this.approvalPreview;
    if (preview === undefined) return;
    this.approvalPreview = undefined;
    this.state.ui.clear();
    for (const child of preview.savedChildren) {
      this.state.ui.addChild(child);
    }
    this.state.ui.setFocus(preview.panel);
    // Scrollback-preserving repaint: the session history above must survive
    // closing the full-screen preview (see restoreEditor).
    this.state.ui.requestCollapseRender();
  }

  private showQuestionDialog(payload: QuestionPanelData): void {
    this.patchLivePane({ pendingQuestion: { data: payload } });
    notifyTerminalOnce(this.state, `question:${payload.id}`, {
      title: t('status.notify.question'),
      body: payload.questions[0]?.question,
    });
    const dialog = new QuestionDialogComponent(
      { data: payload },
      (response) => {
        this.questionController.respond(response);
      },
      6,
      () => {
        this.toggleToolOutputExpansion();
      },
    );
    this.questionDialogHandle = this.mountEditorReplacement(dialog, { kind: 'blocking' });
  }

  private questionDialogHandle: EditorSlotHandle | undefined;

  private hideQuestionDialog(): void {
    const handle = this.questionDialogHandle;
    this.questionDialogHandle = undefined;
    this.patchLivePane({ pendingQuestion: null });
    if (handle !== undefined) this.restoreEditor(handle);
  }
}
