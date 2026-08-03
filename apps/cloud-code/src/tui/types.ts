import type {
  GoalChange,
  GoalSnapshot,
  ModelAlias,
  PermissionMode,
  ProviderConfig,
  PromptPart,
  ServiceTier,
  ThinkingEffort,
  TokenUsage,
  ToolInputDisplay,
  ToolResultDisplayRef,
  ToolResultStructured,
} from '@cloud-code/sdk';

import type { NotificationsConfig, StatusLineConfig, UpgradePreferences } from './config';
import type { LocalePreference } from './i18n';
import type { PendingApproval, PendingQuestion } from './reverse-rpc/types';
import type { ColorToken, ThemeName } from './theme';

export type BannerDisplay = 'always' | 'once' | 'cooldown';

export interface BannerState {
  key: string;
  tag: string | null;
  mainText: string;
  subText: string | null;
  display: BannerDisplay;
  ttlHours?: number;
}

export interface AppState {
  model: string;
  workDir: string;
  additionalDirs: readonly string[];
  sessionId: string;
  permissionMode: PermissionMode;
  planMode: boolean;
  /** 'bash' when the editor is in `!` shell-command mode. */
  inputMode: 'prompt' | 'bash';
  swarmMode: boolean;
  /** Coordinator Mode: main thread orchestrates background workers. */
  coordinatorMode: boolean;
  /** Live thinking effort of the active session (e.g. 'off', 'on', 'high');
   * mirrors the runtime. The single source of truth for the thinking state in
   * the TUI. */
  thinkingEffort: ThinkingEffort;
  /** Live fast-tier state of the active session (`/fast`): 'priority' when on,
   * null/undefined when off. Drives the footer's magenta `fast` marker. */
  serviceTier?: ServiceTier | null;
  contextUsage: number;
  contextTokens: number;
  maxContextTokens: number;
  /**
   * Token usage accumulated across the current (or last completed) turn's
   * steps, summed from `turn.step.completed` events. Drives the footer's
   * in/cache/out breakdown; null/undefined until the first step reports usage.
   */
  turnUsage?: TokenUsage | null;
  /**
   * First-token latencies (ms) of the most recent turns — turn start to the
   * first assistant/thinking delta — capped at 10. Drives the footer's
   * first-token latency display; cleared on session switch.
   */
  recentFirstTokenLatencies?: number[];
  isCompacting: boolean;
  isReplaying: boolean;
  streamingPhase: 'idle' | 'waiting' | 'thinking' | 'composing' | 'shell';
  streamingStartTime: number;
  /**
   * Pending rate-limit auto-resume: set while the session is parked
   * on a rate-limit pause countdown; null/absent otherwise. Drives the Esc
   * override (cancel the auto-retry instead of arming undo).
   */
  rateLimitPause?: { resumeAtMs: number; attempt: number } | null;
  theme: ThemeName;
  /** UI language preference from tui.toml; mirrors `setLocalePreference`. */
  language: LocalePreference;
  version: string;
  editorCommand: string | null;
  /** Mirrors the TUI config toggle; defaults to false when absent from older fixtures. */
  disablePasteBurst?: boolean;
  /**
   * Alternate-screen fullscreen rendering (pinned bottom slot + in-app scroll);
   * defaults to true (tui.toml `fullscreen`). False = classic inline scrollback.
   */
  fullscreen?: boolean;
  /**
   * Current vim editing mode for the footer badge; null/undefined when vim
   * mode is off (tui.toml `editor.vim_mode`, defaults to false).
   */
  vimMode?: 'INSERT' | 'NORMAL' | null;
  notifications: NotificationsConfig;
  upgrade: UpgradePreferences;
  /** Footer status line customization from tui.toml; absent means the default layout. */
  statusLine?: StatusLineConfig;
  availableModels: Record<string, ModelAlias>;
  availableProviders: Record<string, ProviderConfig>;
  sessionTitle: string | null;
  /** Current goal snapshot for the footer badge; null/undefined when no active goal. */
  goal?: GoalSnapshot | null;
  mcpServersSummary: string | null;
  /** Optional banner shown below the welcome panel; null means no banner to render. */
  banner?: BannerState | null;
}

export interface ToolCallBlockData {
  id: string;
  name: string;
  args: Record<string, unknown>;
  description?: string;
  display?: ToolInputDisplay;
  streamingArguments?: string;
  streamingStartedAtMs?: number;
  result?: ToolResultBlockData;
  subagent?: SubagentReplayBlockData;
  step?: number;
  turnId?: string;
  /** Set when the step ended (e.g. max_tokens) before the tool call's
   *  arguments finished streaming. Renderer flips the header verb to
   *  "Truncated" and stops showing the in-progress argument preview. */
  truncated?: boolean;
}

export interface ToolResultBlockData {
  tool_call_id: string;
  output: string;
  is_error?: boolean;
  synthetic?: boolean;
  /**
   * Localization pointer carried by the tool result (`ToolResultDisplayRef`).
   * Renderers that know the key show the localized form; everything else
   * falls back to `output` (always English).
   */
  display?: ToolResultDisplayRef;
  /**
   * Structured outcome facts carried by the tool result
   * (`ToolResultStructured`). Consumers read these instead of parsing
   * `output` when present, and fall back to parsing the raw output for
   * results recorded before the tool emitted them.
   */
  structured?: ToolResultStructured;
}

export interface SubagentReplayToolCallData {
  id: string;
  name: string;
  args: Record<string, unknown>;
  description?: string;
  result?: ToolResultBlockData;
}

export interface SubagentReplayBlockData {
  id: string;
  name?: string;
  text?: string;
  toolCalls?: readonly SubagentReplayToolCallData[];
}

export interface BackgroundAgentMetadata {
  readonly agentId: string;
  readonly parentToolCallId: string;
  readonly agentName?: string;
  readonly description?: string;
}

export type BackgroundAgentStatusPhase = 'started' | 'completed' | 'failed';

export interface BackgroundAgentStatusData {
  readonly phase: BackgroundAgentStatusPhase;
  readonly headline: string;
  readonly detail?: string;
}

export interface CompactionTranscriptData {
  readonly result?: 'cancelled';
  readonly summary?: string;
  readonly tokensBefore?: number;
  readonly tokensAfter?: number;
  readonly instruction?: string;
}

export interface CronTranscriptData {
  readonly jobId?: string;
  readonly cron?: string;
  readonly recurring?: boolean;
  readonly coalescedCount?: number;
  readonly stale?: boolean;
  readonly missedCount?: number;
}

export type GoalTranscriptData =
  | { readonly kind: 'created' }
  | { readonly kind: 'lifecycle'; readonly change: GoalChange };

export type TranscriptEntryKind =
  | 'welcome'
  | 'user'
  | 'assistant'
  | 'tool_call'
  | 'thinking'
  | 'status'
  | 'skill_activation'
  | 'plugin_command'
  | 'cron'
  | 'goal';

export type SkillActivationTrigger = 'user-slash' | 'model-tool' | 'nested-skill';

export interface PluginCommandTranscriptData {
  readonly activationId: string;
  readonly pluginId: string;
  readonly commandName: string;
  readonly args?: string;
  readonly trigger: 'user-slash';
}

export interface TranscriptEntry {
  id: string;
  kind: TranscriptEntryKind;
  turnId?: string;
  renderMode: 'markdown' | 'plain' | 'notice';
  content: string;
  /**
   * True only for entries holding real model-authored text (created by the
   * assistant stream). Derived cards — hook results, goal completions, goal
   * reminders — share kind 'assistant' but are not replies, so /copy must
   * skip them.
   */
  modelText?: boolean;
  color?: ColorToken;
  detail?: string;
  /** Optional override for the leading bullet of a 'user' message entry. An empty string suppresses the bullet entirely (used by shell-command echoes so `$` replaces the sparkles marker). */
  bullet?: string;
  toolCallData?: ToolCallBlockData;
  backgroundAgentStatus?: BackgroundAgentStatusData;
  compactionData?: CompactionTranscriptData;
  cronData?: CronTranscriptData;
  goalData?: GoalTranscriptData;
  imageAttachmentIds?: readonly number[];
  skillActivationId?: string;
  skillName?: string;
  skillArgs?: string;
  skillTrigger?: SkillActivationTrigger;
  pluginCommandData?: PluginCommandTranscriptData;
}

export type LivePaneMode =
  | 'idle'
  | 'waiting'
  | 'thinking'
  | 'tool'
  | 'session';

export interface LivePaneState {
  mode: LivePaneMode;
  pendingApproval: PendingApproval | null;
  pendingQuestion: PendingQuestion | null;
}

export interface QueuedMessage {
  readonly text: string;
  readonly agentId?: string;
  readonly parts?: readonly PromptPart[];
  readonly imageAttachmentIds?: readonly number[];
  /** `bash` for a `!` shell command queued while another command is running;
   *  undefined (=`prompt`) for a normal message. */
  readonly mode?: 'prompt' | 'bash';
}

/**
 * One unit of Ctrl-S steer input: a queued message or the editor draft,
 * with the media parts extracted at submit/paste time so images and video
 * tags survive the steer path (which accepts full prompt parts, not just
 * text).
 */
export interface SteerInputItem {
  readonly text: string;
  readonly parts?: readonly PromptPart[];
  readonly imageAttachmentIds?: readonly number[];
}

export const INITIAL_LIVE_PANE: LivePaneState = {
  mode: 'idle',
  pendingApproval: null,
  pendingQuestion: null,
};

// ---------------------------------------------------------------------------
// TUI startup / options types (extracted from cloud-code-tui.ts)
// ---------------------------------------------------------------------------

export interface TUIStartupOptions {
  readonly sessionFlag?: string;
  readonly continueLast: boolean;
  readonly yolo: boolean;
  readonly auto: boolean;
  readonly plan: boolean;
  readonly model?: string;
  /** Resolved profile name from --agent/--agent-file; bound to the startup session only. */
  readonly agentProfile?: string;
  /** Raw --agent-file paths, passed to session creation alongside `agentProfile`. */
  readonly agentFiles?: readonly string[];
  readonly startupNotice?: string;
}

export type TUIStartupState = 'pending' | 'ready' | 'picker';

export interface CloudCodeTUIOptions {
  initialAppState: AppState;
  startup: TUIStartupOptions;
}

export interface PendingExit {
  readonly kind: 'ctrl-c' | 'ctrl-d';
  readonly timer: ReturnType<typeof setTimeout>;
}

export interface LoginProgressSpinnerHandle {
  stop(opts: { ok: boolean; label: string }): void;
  setLabel(label: string): void;
}

/**
 * Routing option for showStatus/showNotice/showError.
 *
 * Transient (default) → the single-slot notice container at the top of the
 * slot, right under the transcript, where each new notice replaces the
 * previous one. For immediate feedback with no look-back value: command confirmations (theme/language/permission/
 * login), action outcomes, startup/progress hints, the turn-completion line.
 *
 * Recorded (`transcript: true`) → the transcript, scrolling with the message
 * flow. For abnormal endings and diagnostic warnings worth reviewing later:
 * turn failed/filtered/blocked/interrupted, max_tokens truncation notices,
 * session errors and the error-report hint, session-level warnings (resume
 * warnings, WarningEvent, degraded config, tmux keyboard), MCP server status
 * rows (append-only and dedup'd — a single-slot notice would break that),
 * and outcomes carrying an actionable link or command (export paths, login
 * URLs, cd hints).
 */
export interface StatusNoticeOptions {
  readonly transcript?: boolean;
}

export type ProgressSpinnerHandle = LoginProgressSpinnerHandle;
