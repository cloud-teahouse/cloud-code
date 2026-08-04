import type {
  ExportSessionManifest,
  ResumeSessionResult,
  ServiceTier,
  ShellEnvironment,
} from '@cloud-code/agent-core';
import type { Kaos } from '@cloud-code/kaos';
import type { CloudCodeHostIdentity, OAuthRefreshOutcome } from '@cloud-code/oauth';
import type { ContentPart, RateLimitSnapshot } from '@cloud-code/kosong';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { readonly [key: string]: JsonValue };
export type JsonObject = { readonly [key: string]: JsonValue };

export type Unsubscribe = () => void;

export type {
  AgentReplayRecord,
  AgentBackgroundTaskInfo,
  BackgroundConfig,
  BackgroundTaskInfo,
  BackgroundTaskStatus,
  ConfigDiagnostics,
  ContextMessage,
  CronTaskSnapshot,
  ExperimentalFeatureState,
  ExperimentalFlagMap,
  ExperimentalFlagSource,
  ExportSessionManifest,
  GoalBudgetLimits,
  GoalBudgetReport,
  GoalChange,
  GoalChangeStats,
  GetCronTasksResult,
  GoalSnapshot,
  GoalStatus,
  GoalToolResult,
  CloudCodeConfig,
  CloudCodeConfigPatch,
  LoopControl,
  McpServerInfo,
  ModelAlias,
  MoonshotServiceConfig,
  OAuthRef,
  OutputStyleSummary,
  PluginCommandDef,
  PluginGithubMetadata,
  PluginGithubRef,
  PluginInfo,
  PluginMcpServerInfo,
  PluginSource,
  PluginSummary,
  ProcessBackgroundTaskInfo,
  PromptOrigin,
  ProviderConfig,
  ProviderType,
  QuestionBackgroundTaskInfo,
  ReloadSummary,
  ResumedAgentState,
  RewindFilesResult,
  SandboxMode,
  SandboxStatusData,
  ServiceTier,
  ServicesConfig,
  ShellEnvironment,
  SkillSummary,
  ThinkingConfig,
  ToolInfo,
  GlobalMcpServerConfig as McpServerConfig,
  GlobalMcpServerTestResult as McpTestResult,
} from '@cloud-code/agent-core';

export type { CloudCodeHostIdentity, OAuthRefreshOutcome };
export type { ContentPart, Role, ThinkingEffort, ToolCall } from '@cloud-code/kosong';

export type PermissionMode = 'yolo' | 'manual' | 'auto';

/**
 * stdio transport: spawn a `cloud-code serve`-style child process and speak
 * JSON-RPC 2.0 (JSONL framing) over its stdin/stdout.
 *
 * `command`/`args` default to the installed CLI (`cloud-code serve
 * --transport stdio`); tests pass an explicit node+tsx invocation instead.
 * `env` is merged over `process.env` for the child.
 */
export interface StdioServerTransport {
  readonly type: 'stdio';
  readonly command?: string | undefined;
  readonly args?: readonly string[] | undefined;
  readonly env?: Readonly<Record<string, string>> | undefined;
}

/**
 * WebSocket transport (Phase 4 v2): connect to a running `cloud-code serve
 * --transport ws` daemon. `url` is its ws URL (`ws://127.0.0.1:<port>`) and
 * `token` the bearer token printed at server startup (design §2.3).
 */
export interface WsServerTransport {
  readonly type: 'ws';
  readonly url: string;
  readonly token: string;
}

/**
 * Harness transport: `'local'` (default) runs the core in-process via the
 * in-memory RPC seam; a transport object switches to the JSON-RPC protocol
 * client (stdio spawn or ws attach).
 */
export type HarnessTransport = 'local' | StdioServerTransport | WsServerTransport;

/**
 * Trust state of a workspace directory. The v1 engine has no workspace-trust
 * concept and reports `{ trusted: true, gatedMcpServers: [] }`.
 */
export interface WorkspaceTrustInfo {
  readonly trusted: boolean;
  /** Names of project-level MCP servers that trusting the workspace would enable. */
  readonly gatedMcpServers: readonly string[];
}

export interface CreateGoalInput {
  readonly objective: string;
  readonly replace?: boolean;
}

export type TextPromptPart = Extract<ContentPart, { type: 'text' }>;
export type PromptPart = Extract<ContentPart, { type: 'text' | 'image_url' | 'video_url' }>;

export type PromptInput = readonly PromptPart[];

export interface CloudCodeHarnessOptions {
  readonly identity?: CloudCodeHostIdentity | undefined;
  readonly homeDir?: string | undefined;
  readonly configPath?: string | undefined;
  readonly autoLoadConfig?: boolean | undefined;
  readonly uiMode?: string;
  readonly skillDirs?: readonly string[];
  readonly onOAuthRefresh?: ((outcome: OAuthRefreshOutcome) => void) | undefined;
  /**
   * Transport selection (Phase 4). Omitted or `'local'`: in-process core
   * (current behavior). `{type:'stdio', ...}` spawns a `cloud-code serve`
   * child; `{type:'ws', url, token}` attaches to a running daemon — either
   * way the harness/Session API is identical.
   */
  readonly transport?: HarnessTransport | undefined;
}

export interface CreateSessionOptions {
  readonly id?: string | undefined;
  readonly workDir: string;
  readonly model?: string | undefined;
  readonly thinking?: string | undefined;
  readonly permission?: PermissionMode | undefined;
  /**
   * Explicit fast-tier override (`'priority'`). When omitted, the session
   * seeds from the persisted config.toml `service_tier` preference.
   */
  readonly serviceTier?: ServiceTier | undefined;
  readonly planMode?: boolean;
  readonly metadata?: JsonObject | undefined;
  readonly kaos?: Kaos | undefined;
  readonly persistenceKaos?: Kaos | undefined;
  readonly additionalDirs?: readonly string[];
  /**
   * Main-agent profile name (`--agent`): a builtin profile or one defined by
   * an agentfile discovered from the user/project agent directories.
   */
  readonly agentProfile?: string;
  /**
   * Explicit agentfiles (`--agent-file`) loaded for this session with the
   * highest precedence; an invalid file fails session creation.
   */
  readonly agentFiles?: readonly string[];
  /**
   * Print-mode (`cloud-code -p`) only: when the main agent ends a turn while
   * background subagents (`kind === 'agent'`) are still running, hold the turn
   * open and idle-wait until they all finish, flushing their completions into
   * the turn so the model can react before the run exits. Ignored by
   * interactive / SDK sessions.
   */
  readonly drainAgentTasksOnStop?: boolean;
}

export interface RenameSessionInput {
  readonly id: string;
  readonly title: string;
}

export interface ResumeSessionInput {
  readonly id: string;
  readonly kaos?: Kaos | undefined;
  readonly persistenceKaos?: Kaos | undefined;
  readonly additionalDirs?: readonly string[];
  /** Re-select the session's already-bound main profile; a different name fails. */
  readonly agentProfile?: string;
  /** Include persisted subagent states in the returned replay snapshot. */
  readonly includeSubagents?: boolean;
  /**
   * Limit each returned agent replay to the most recent N user turns. Omit to
   * return the full replay. Lets UI callers that only render the tail avoid
   * transferring the entire history over the RPC boundary.
   */
  readonly replayTurnLimit?: number;
}

export interface ReloadSessionInput extends ResumeSessionInput {
  readonly forcePluginSessionStartReminder?: boolean;
}

export interface AddAdditionalDirInput {
  readonly id: string;
  readonly path: string;
  readonly persist: boolean;
}

export interface AddAdditionalDirOptions {
  /** When true, share the directory through workspace local config. When false,
   * keep it scoped to this session while still restoring it on session resume. */
  readonly persist: boolean;
}

export interface ForkSessionInput {
  readonly id: string;
  readonly forkId?: string;
  readonly title?: string;
  readonly metadata?: JsonObject;
  /**
   * Zero-based index of the user-visible turn to retain through. Omit it to
   * preserve the existing full-session fork behavior.
   */
  readonly turnIndex?: number;
}

export interface ExportSessionInput {
  readonly id: string;
  readonly outputPath?: string | undefined;
  readonly includeGlobalLog?: boolean | undefined;
  /** Host version to record in the export manifest. */
  readonly version: string;
  /** How the CLI was installed (e.g. 'npm-global', 'native'). */
  readonly installSource?: string | undefined;
  readonly shellEnv?: ShellEnvironment | undefined;
}

export interface ExportSessionResult {
  readonly zipPath: string;
  readonly entries: readonly string[];
  readonly sessionDir: string;
  readonly manifest: ExportSessionManifest;
}

export interface ListSessionsOptions {
  readonly workDir?: string;
  readonly sessionId?: string;
}

export interface GetConfigOptions {
  readonly reload?: boolean | undefined;
}

export interface AuthenticateMcpServerOptions {
  readonly onAuthorizationUrl: (
    url: string,
  ) => void | boolean | PromiseLike<void | boolean>;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface TestMcpServerOptions {
  readonly cwd?: string;
}

export interface CompactOptions {
  readonly instruction?: string | undefined;
}

export interface ReloadSessionOptions {
  readonly forcePluginSessionStartReminder?: boolean;
}

export interface PlanInfo {
  readonly id: string;
  readonly content: string;
  readonly path: string;
}

export type SessionPlan = PlanInfo | null;

export interface TokenUsage {
  readonly inputOther: number;
  readonly output: number;
  readonly inputCacheRead: number;
  readonly inputCacheCreation: number;
}

export interface SessionUsage {
  readonly byModel?: Record<string, TokenUsage> | undefined;
  readonly currentTurn?: TokenUsage | undefined;
  readonly total?: TokenUsage | undefined;
  /**
   * Latest account rate-limit snapshot captured from provider response
   * headers (ChatGPT Codex `x-codex-*` family); undefined until the session
   * makes a request against a backend that reports quota headers.
   */
  readonly rateLimit?: RateLimitSnapshot | undefined;
}

export type { RateLimitSnapshot } from '@cloud-code/kosong';

export interface SessionStatus {
  readonly model?: string;
  readonly thinkingEffort: string;
  readonly permission: PermissionMode;
  readonly planMode: boolean;
  readonly swarmMode?: boolean | undefined;
  readonly coordinatorMode?: boolean | undefined;
  /** Fast tier (`'priority'`) currently active on the session; absent when off. */
  readonly serviceTier?: ServiceTier | undefined;
  readonly contextTokens: number;
  readonly maxContextTokens: number;
  readonly contextUsage: number;
  readonly usage?: SessionUsage;
}

export interface SessionSummary {
  readonly id: string;
  readonly title?: string | undefined;
  readonly lastPrompt?: string;
  readonly workDir: string;
  readonly sessionDir: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly archived?: boolean | undefined;
  readonly metadata?: JsonObject | undefined;
  readonly additionalDirs?: readonly string[];
}

export interface AddAdditionalDirResult {
  readonly additionalDirs: readonly string[];
  readonly projectRoot: string;
  readonly configPath: string;
  readonly persisted: boolean;
}

export type ResumedSessionState = Pick<ResumeSessionResult, 'sessionMetadata' | 'agents' | 'warning'>;

export interface ResumedSessionSummary extends SessionSummary, ResumedSessionState { }
