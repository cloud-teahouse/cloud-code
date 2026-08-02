import { HOOK_EVENT_TYPES } from '../session/hooks/types';
import { parsePattern } from '#/agent/permission/matches-rule';
import { ErrorCodes, CloudCodeError } from '#/errors';
import { z } from 'zod';

export const ProviderTypeSchema = z.enum([
  'anthropic',
  'openai',
  'kimi',
  'google-genai',
  'openai_responses',
  'vertexai',
]);

export type ProviderType = z.infer<typeof ProviderTypeSchema>;

export const OAuthRefSchema = z.object({
  storage: z.enum(['file', 'keyring']),
  key: z.string().min(1),
  oauthHost: z.string().min(1).optional(),
});

export type OAuthRef = z.infer<typeof OAuthRefSchema>;

const StringRecordSchema = z.record(z.string(), z.string());

export const ProviderConfigSchema = z.object({
  type: ProviderTypeSchema,
  apiKey: z.string().optional(),
  baseUrl: z.string().optional(),
  defaultModel: z.string().optional(),
  oauth: OAuthRefSchema.optional(),
  env: StringRecordSchema.optional(),
  customHeaders: StringRecordSchema.optional(),
  /** Omit `max_output_tokens` from requests (Responses backends that reject it, e.g. ChatGPT Codex). */
  omitMaxOutputTokens: z.boolean().optional(),
  // Explicit opt-in: this endpoint speaks service_tier (e.g. a third-party
  // OpenAI Responses provider that honors 'priority'). Acts as the default
  // declaration for all model aliases under this provider (an alias's own
  // serviceTiers override it). The /fast gate never sends service_tier
  // without a declaration at some level.
  serviceTiers: z.array(z.string()).optional(),
  source: z.record(z.string(), z.unknown()).optional(),
});

export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

const ModelAliasBaseSchema = z.object({
  provider: z.string(),
  model: z.string(),
  maxContextSize: z.number().int().min(1),
  // Declared prompt/input cap when below the total window (e.g. gpt-5: 400k
  // window, 272k input). Compaction and other prompt-budget checks prefer it
  // over max_context_size; completion budgeting keeps the total window.
  maxInputSize: z.number().int().min(1).optional(),
  maxOutputSize: z.number().int().min(1).optional(),
  capabilities: z.array(z.string()).optional(),
  displayName: z.string().optional(),
  reasoningKey: z.string().optional(),
  // Reasoning round-trip policy for OpenAI-compatible endpoints that do not
  // consume reasoning (kosong ReasoningRoundTrip): 'always' (default),
  // 'tool-calls-only' (reasoning key only on assistant tool-call turns, DeepSeek
  // rule), or 'never' (drop entirely). Kimi/Anthropic contracts are unaffected.
  reasoningRoundTrip: z.enum(['always', 'tool-calls-only', 'never']).optional(),
  protocol: z.literal('anthropic').optional(),
  // Explicitly declare adaptive-thinking support, overriding the kosong
  // model-name version inference. Needed for custom-named Anthropic endpoints
  // whose model name does not encode a parseable Claude version.
  adaptiveThinking: z.boolean().optional(),
  // Efforts (e.g. ["low", "high", "max"]) the model supports for
  // extended thinking, plus the catalog default. Generic to any provider:
  // managed models fill these from the catalog, others can be set by hand in
  // config.toml. The user's chosen effort is stored globally in thinking.effort.
  supportEfforts: z.array(z.string()).optional(),
  defaultEffort: z.string().optional(),
  // Service tier ids the model's catalog declares (ChatGPT Codex `/models`
  // `service_tiers[].id`; 'priority' is the fast tier). Drives the /fast
  // gate: only models declaring 'priority' may toggle it. Absent means "no
  // declaration" — the gate fails closed until a provider refresh fills it.
  serviceTiers: z.array(z.string()).optional(),
  // The effort value that encodes "thinking off" on the wire for this model
  // (models.dev declares it as the "none" entry, e.g. xai grok). When set,
  // turning thinking off sends this value instead of omitting the effort
  // field — required by models whose default is to reason.
  offEffort: z.string().optional(),
  // Route the Anthropic transport through the beta Messages API
  // (`POST /v1/messages?beta=true`) instead of the standard endpoint. Used by
  // managed Cloud Code models that declare `protocol: 'anthropic'`.
  betaApi: z.boolean().optional(),
  // Per-model endpoint override, paired with `protocol`. Catalog imports set
  // it when a gateway provider serves this model over a different endpoint
  // than the provider default.
  baseUrl: z.string().optional(),
});

export const ModelAliasOverrideSchema = ModelAliasBaseSchema.omit({
  provider: true,
  model: true,
  protocol: true,
  betaApi: true,
  baseUrl: true,
}).partial();

export type ModelAliasOverrides = z.infer<typeof ModelAliasOverrideSchema>;

export const ModelAliasSchema = ModelAliasBaseSchema.extend({
  // User overrides for a model alias. These win over the top-level fields at
  // runtime and are preserved by provider-model refreshes.
  overrides: ModelAliasOverrideSchema.optional(),
});

export type ModelAlias = z.infer<typeof ModelAliasSchema>;

/**
 * The secondary-model recipe (`[secondary_model]` on disk): `model` points at
 * a `[models]` entry and every remaining field is a subagent-only patch,
 * materialized into a synthesized derived model entry at runtime (see
 * `config/secondary-model.ts`). `default_effort` doubles as the subagent
 * thinking effort.
 */
export const SecondaryModelConfigSchema = ModelAliasOverrideSchema.extend({
  model: z.string().min(1).optional(),
});

export type SecondaryModelConfig = z.infer<typeof SecondaryModelConfigSchema>;

export const ThinkingConfigSchema = z.object({
  enabled: z.boolean().optional(),
  effort: z.string().optional(),
  // Moonshot Preserved Thinking passthrough (`thinking.keep`). The value is
  // forwarded verbatim to the wire; "all" enables it, an off-value
  // (false/0/no/off/none/null) disables it. Defaults to "all" when unset.
  keep: z.string().optional(),
});

export type ThinkingConfig = z.infer<typeof ThinkingConfigSchema>;

/**
 * Persisted service-tier preference (codex `service_tier` semantics). "fast"
 * maps to the wire value `priority` on OpenAI Responses providers (ChatGPT
 * Codex); "default" — and an absent key — leave requests untouched.
 */
export const ServiceTierConfigSchema = z.enum(['fast', 'default']);

export type ServiceTierConfig = z.infer<typeof ServiceTierConfigSchema>;

export const PermissionModeSchema = z.enum(['yolo', 'manual', 'auto']);

export const PermissionRuleDecisionSchema = z.enum(['allow', 'deny', 'ask']);
export const PermissionRuleScopeSchema = z.enum([
  'turn-override',
  'session-runtime',
  'project',
  'user',
]);

export const PermissionRuleSchema = z.object({
  decision: PermissionRuleDecisionSchema,
  scope: PermissionRuleScopeSchema.default('user'),
  pattern: z.string().min(1).refine(isValidPermissionPattern, {
    message: 'Invalid permission rule pattern',
  }),
  reason: z.string().optional(),
});

export const PermissionConfigSchema = z.object({
  rules: z.array(PermissionRuleSchema).optional(),
  /**
   * Wrapper stripping for Bash permission rules (design doc §3.2.A, C3
   * P2): peel leading env assignments and safe wrapper commands
   * (sudo/timeout/nice/env/…) before generating and matching `Bash(...)`
   * approval rules, so `sudo git push` grants `Bash(git push *)` instead
   * of the over-broad `Bash(sudo *)`. Default true.
   */
  wrapperStripping: z.boolean().optional(),
  /**
   * Git mutation gate (design doc §3.2.B, C3 P3): how Bash/ExecSession
   * calls whose segments classify as git mutations (push, history
   * rewrites, local mutations, inline-config injection, unknown
   * subcommands) are permissioned. `ask` (default) — the gate prompts
   * with a graded line (headless: deny, fail-closed); `allow` — gate
   * off, back to the existing chain; `deny` — hard block with no
   * approval prompt (configured allow rules still exempt).
   */
  gitMutation: z.enum(['ask', 'allow', 'deny']).optional(),
});

export type PermissionConfig = z.infer<typeof PermissionConfigSchema>;

export const LoopControlSchema = z.object({
  maxStepsPerTurn: z.number().int().min(0).optional(),
  maxRetriesPerStep: z.number().int().min(0).optional(),
  maxRalphIterations: z.number().int().min(-1).optional(),
  reservedContextSize: z.number().int().min(0).optional(),
  compactionTriggerRatio: z.number().min(0.5).max(0.99).optional(),
  /**
   * Execution-time tool result overflow budget (F10): a single tool result
   * exceeding either limit is persisted to `<sessionDir>/tool-results/` and
   * the model sees a preview plus the file path.
   */
  toolResultMaxBytes: z.number().int().min(1).optional(),
  toolResultMaxLines: z.number().int().min(1).optional(),
  /**
   * Streaming tool execution (F6): while the model is still streaming, a tool
   * call whose arguments have fully arrived is validated and prepared
   * immediately, and starts executing early when its declared resource
   * accesses are read-only. Result visibility stays in provider order.
   * Defaults to true; set false to restore pure batch execution.
   */
  streamingToolExecution: z.boolean().optional(),
  /**
   * Foreground retry split (C1 P2): caps on how long a step's retry loop may
   * sleep inside the turn before the wait is moved out of the session as a
   * rate-limit pause with automatic resume. `retryForegroundMaxDelayMs`
   * bounds a single wait (server `Retry-After` included; default 60000),
   * `retryForegroundMaxTotalWaitMs` bounds the accumulated backoff of one
   * step (default 150000).
   */
  retryForegroundMaxDelayMs: z.number().int().min(1).optional(),
  retryForegroundMaxTotalWaitMs: z.number().int().min(1).optional(),
  /**
   * Default true: a breached foreground gate ends the turn as a rate-limit
   * pause and a session-level timer retries it. Set false to restore the
   * near-previous behavior — an over-long server `Retry-After` is clipped to
   * `retryForegroundMaxDelayMs` and the loop retries within the local budget.
   */
  retryAutoResume: z.boolean().optional(),
  /** Consecutive rate-limit pauses after which auto-resume gives up (default 3). */
  retryAutoResumeMaxAttempts: z.number().int().min(1).optional(),
});

export type LoopControl = z.infer<typeof LoopControlSchema>;

/**
 * Long-conversation behavioral-rule re-injection (Anthropic
 * `<long_conversation_reminder>` pattern; see agent/injection/behavior-reminders.ts).
 * Re-states key behavioral rules (destructive-action discipline,
 * verify-before-done, language matching, minimal changes) as a
 * `<system-reminder>` at the history tail — always after a compaction, and at
 * turn boundaries once `intervalTurns` assistant messages passed since the
 * last reminder. Append-only: the system prompt and its hash are never
 * touched. Defaults to ON at a low frequency; `enabled = false` is a strict
 * zero-behavior-change escape hatch.
 */
export const BehaviorRemindersConfigSchema = z.object({
  /** Default true. Set false to disable every re-injection path. */
  enabled: z.boolean().optional(),
  /**
   * Assistant messages (model steps) between boundary re-injections; default
   * 25. The post-compaction re-injection is independent of this interval.
   */
  intervalTurns: z.number().int().min(1).optional(),
});

export type BehaviorRemindersConfig = z.infer<typeof BehaviorRemindersConfigSchema>;

/**
 * Default budget caps for one goal size tier (C2 tiered budgets). Applied at
 * goal creation only — empty slots are filled, explicit budgets set later
 * always win. Wall-clock deliberately has no tiered default.
 */
export const GoalTierBudgetSchema = z.object({
  /** Turn budget filled in for a created goal of this tier. */
  turns: z.number().int().min(1).optional(),
  /** Token budget filled in for a created goal of this tier. */
  tokens: z.number().int().min(1).optional(),
});

export type GoalTierBudget = z.infer<typeof GoalTierBudgetSchema>;

export const GoalTiersConfigSchema = z.object({
  /** Defaults: 10 turns / 300000 tokens. */
  small: GoalTierBudgetSchema.optional(),
  /** Defaults: 40 turns / 1500000 tokens. */
  medium: GoalTierBudgetSchema.optional(),
  /** Defaults: 120 turns / 6000000 tokens. */
  large: GoalTierBudgetSchema.optional(),
});

export type GoalTiersConfig = z.infer<typeof GoalTiersConfigSchema>;

export const GoalConfigSchema = z.object({
  /**
   * Completion gate (C2): `UpdateGoal(complete)` must cite goal-evidence
   * receipts — verification tool results captured after the latest mutation
   * and inside the evidence lease. Defaults to true when unset.
   */
  completionGate: z.boolean().optional(),
  /**
   * Turn clock of the evidence lease: a receipt captured more than this many
   * goal turns ago can no longer sign off completion. Defaults to 5.
   */
  evidenceLeaseTurns: z.number().int().min(0).optional(),
  /**
   * Wall-clock of the evidence lease in milliseconds; keeps aging while the
   * goal is paused (the workspace may change underneath). Defaults to
   * 1800000 (30 minutes).
   */
  evidenceLeaseMs: z.number().int().min(0).optional(),
  /**
   * Tiered budgets (C2): a created goal gets the default turn/token caps of
   * its size tier (from `sizeHint`, else an objective-length heuristic).
   * Only empty slots are filled — an explicit budget always overrides.
   * Defaults to true when unset.
   */
  tieredBudgets: z.boolean().optional(),
  /** Per-tier default caps; each tier falls back to the built-in defaults. */
  tiers: GoalTiersConfigSchema.optional(),
});

export type GoalConfig = z.infer<typeof GoalConfigSchema>;

export const BackgroundConfigSchema = z.object({
  maxRunningTasks: z.number().int().min(1).optional(),
  keepAliveOnExit: z.boolean().optional(),
  /**
   * When a foreground Bash command times out, move it to the background
   * instead of killing it. Defaults to true when unset.
   */
  bashAutoBackgroundOnTimeout: z.boolean().optional(),
  /**
   * Default timeout (seconds) for background Bash tasks when the call omits
   * `timeout`, also used to re-arm foreground commands moved to the
   * background. `0` means no timeout. Explicit per-call `timeout` values are
   * unaffected. Defaults to the Bash tool's built-in 600s when unset.
   */
  bashTaskTimeoutS: z.number().int().min(0).optional(),
  killGracePeriodMs: z.number().int().min(0).optional(),
  printWaitCeilingS: z.number().int().min(1).optional(),
  printBackgroundMode: z.enum(['exit', 'drain', 'steer']).optional(),
  printMaxTurns: z.number().int().min(1).optional(),
});

export type BackgroundConfig = z.infer<typeof BackgroundConfigSchema>;

export const SubagentConfigSchema = z.object({
  /**
   * Per-subagent (`Agent` / `AgentSwarm`, foreground and background) timeout
   * in milliseconds. `0` means no timeout. Defaults to 2 hours when unset.
   */
  timeoutMs: z.number().int().min(0).optional(),
});

export type SubagentConfig = z.infer<typeof SubagentConfigSchema>;

export const MAX_MCP_TIMEOUT_MS = 2_147_483_647;
const McpTimeoutMsSchema = z.number().int().min(1).max(MAX_MCP_TIMEOUT_MS);

export const McpConfigSchema = z.object({
  /**
   * Global default MCP server startup (connect + tool discovery) timeout in
   * milliseconds. A per-server `startupTimeoutMs` in `mcp.json` and the
   * CLOUD_CODE_MCP_STARTUP_TIMEOUT_MS env var both win over this value. Defaults
   * to 30s when unset.
   */
  startupTimeoutMs: McpTimeoutMsSchema.optional(),
  /**
   * Global default single MCP tool-call timeout in milliseconds. A
   * per-server `toolTimeoutMs` in `mcp.json` and the
   * CLOUD_CODE_MCP_TOOL_TIMEOUT_MS env var both win over this value. Falls back to
   * the client built-in default when unset.
   */
  toolTimeoutMs: McpTimeoutMsSchema.optional(),
});

export type McpConfig = z.infer<typeof McpConfigSchema>;

export const ImageConfigSchema = z.object({
  /**
   * Longest-edge ceiling (px) applied when compressing images for the model.
   * Overrides the built-in default; the KIMI_IMAGE_MAX_EDGE_PX env var wins
   * over this value.
   */
  maxEdgePx: z.number().int().min(1).optional(),
  /**
   * Raw-byte budget for images the model reads for itself (ReadMediaFile's
   * default path). Overrides the built-in default; the
   * KIMI_IMAGE_READ_BYTE_BUDGET env var wins over this value. Explicit
   * region / full_resolution reads use the provider-scale per-image limit
   * instead.
   */
  readByteBudget: z.number().int().min(1).optional(),
});

export type ImageConfig = z.infer<typeof ImageConfigSchema>;

export const SnapshotConfigSchema = z.object({
  /**
   * Shadow-git file snapshots (F4): track the workspace at turn/step
   * boundaries so `/rewind` can roll files back. Defaults to true; requires a
   * local kaos backend and a `git` binary, and silently disables otherwise.
   */
  enabled: z.boolean().optional(),
  /**
   * Untracked files larger than this are excluded from snapshots (recorded in
   * the shadow repo's `info/exclude`). Defaults to 2 MiB.
   */
  maxFileSizeBytes: z.number().int().min(1).optional(),
});

export type SnapshotConfig = z.infer<typeof SnapshotConfigSchema>;

export const SandboxConfigSchema = z.object({
  /**
   * OS-level command sandbox for the Bash tool (F1, bubblewrap on Linux).
   * `off` never sandboxes; `auto` (default) sandboxes when a backend is
   * available and otherwise runs unsandboxed with a once-per-session
   * warning; `enforce` fails closed — the Bash call returns an error when
   * no sandbox backend is available.
   */
  mode: z.enum(['off', 'auto', 'enforce']).optional(),
  /**
   * Network access inside the sandbox. `allow` (default) keeps network;
   * `deny` adds `--unshare-net` (coarse: unix sockets still work — no
   * seccomp filter in the Phase-2 backend).
   */
  network: z.enum(['allow', 'deny']).optional(),
  /**
   * Extra writable roots (absolute paths; `~` expands). The workspace and
   * `/tmp` are always writable inside the sandbox.
   */
  writableRoots: z.array(z.string()).optional(),
  /** Extra paths masked unreadable, merged over the built-in credential list. */
  denyRead: z.array(z.string()).optional(),
  /**
   * What may happen after the sandbox denies a command: `ask` (default)
   * requests one-time human approval to retry without the sandbox, `never`
   * treats the denial as final (strict fail-closed), `always` retries
   * unsandboxed without asking (headless/yolo; not recommended — heuristic
   * false positives then silently drop the sandbox).
   */
  escalation: z.enum(['ask', 'never', 'always']).optional(),
});

export type SandboxConfig = z.infer<typeof SandboxConfigSchema>;

export const ShellSessionConfigSchema = z.object({
  /**
   * Max concurrent persistent PTY sessions (ExecSession) per agent. Oldest
   * sessions past the cap are evicted (LRU, newest 8 protected). Defaults
   * to 16 when unset.
   */
  maxSessions: z.number().int().min(1).optional(),
  /**
   * Idle reclamation delay in seconds: a session with no WriteStdin
   * interaction for this long is stopped (SIGTERM → grace → SIGKILL).
   * `0` disables the idle reaper. Defaults to 1800 (30 minutes) when unset.
   */
  idleTimeoutS: z.number().int().min(0).optional(),
});

export type ShellSessionConfig = z.infer<typeof ShellSessionConfigSchema>;

export const GuardianConfigSchema = z.object({
  /**
   * Guardian AI approval reviewer (F3). In `auto` permission mode, actions
   * that would otherwise be silently approved are sent to a dedicated review
   * model first. Default off; `manual` and `yolo` modes never route to it.
   */
  enabled: z.boolean().optional(),
  /** Review model alias; defaults to the main model. */
  model: z.string().optional(),
  /** Single-review timeout in ms (default 30000). `0` disables the timeout (not recommended). */
  timeoutMs: z.number().int().min(0).optional(),
  /** Circuit breaker: consecutive reviewer denials per turn before tripping (default 3). */
  maxConsecutiveDenials: z.number().int().min(1).optional(),
  /** Circuit breaker: reviewer denials inside the sliding window before tripping (default 10). */
  maxWindowDenials: z.number().int().min(1).optional(),
  /** Circuit breaker: sliding window size in reviewed actions (default 50). */
  windowSize: z.number().int().min(1).optional(),
});

export type GuardianConfig = z.infer<typeof GuardianConfigSchema>;

export const DebugConfigSchema = z.object({
  /**
   * Prefix-drift cache diagnostics (F7): when on, a drift between adjacent
   * requests (`llm prefix drift` warn, correlated with the settled request's
   * cache counters) and a periodic "prefix stable" summary are emitted.
   * Default off; the `CLOUD_CODE_DEBUG_CACHE=1` env var overrides this value.
   */
  cacheDiagnostics: z.boolean().optional(),
});

export type DebugConfig = z.infer<typeof DebugConfigSchema>;

export const ModelCatalogConfigSchema = z.object({
  /** Interval (ms) between automatic provider-model refreshes. `0` disables. */
  refreshIntervalMs: z.number().int().min(0).optional(),
  /** Refresh once shortly after the daemon starts. */
  refreshOnStart: z.boolean().optional(),
});

export type ModelCatalogConfig = z.infer<typeof ModelCatalogConfigSchema>;

export const ExperimentalConfigSchema = z.record(z.string(), z.boolean());

export type ExperimentalConfig = z.infer<typeof ExperimentalConfigSchema>;

export const HookDefSchema = z
  .object({
    event: z.enum(HOOK_EVENT_TYPES),
    matcher: z.string().optional(),
    /**
     * Optional permission-rule-syntax condition (e.g. `Bash(git *)`) evaluated
     * against the tool input before spawning the hook process.
     */
    if: z.string().optional(),
    command: z.string().min(1),
    timeout: z.number().int().min(1).max(600).optional(),
  })
  .strict();

export type HookDefConfig = z.infer<typeof HookDefSchema>;

export const MoonshotServiceConfigSchema = z.object({
  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
  oauth: OAuthRefSchema.optional(),
  customHeaders: StringRecordSchema.optional(),
});

export type MoonshotServiceConfig = z.infer<typeof MoonshotServiceConfigSchema>;

export const ServicesConfigSchema = z.object({
  moonshotSearch: MoonshotServiceConfigSchema.optional(),
  moonshotFetch: MoonshotServiceConfigSchema.optional(),
});

export type ServicesConfig = z.infer<typeof ServicesConfigSchema>;

const McpServerCommonFields = {
  enabled: z.boolean().optional(),
  startupTimeoutMs: McpTimeoutMsSchema.optional(),
  toolTimeoutMs: McpTimeoutMsSchema.optional(),
  enabledTools: z.array(z.string()).optional(),
  disabledTools: z.array(z.string()).optional(),
} as const;

export const McpServerStdioConfigSchema = z.object({
  transport: z.literal('stdio'),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: StringRecordSchema.optional(),
  cwd: z.string().optional(),
  // Reserved for future kaos-backed stdio launchers. `undefined` and `'local'`
  // both mean direct child_process spawn for now.
  executor: z.enum(['local', 'kaos']).optional(),
  ...McpServerCommonFields,
});

export type McpServerStdioConfig = z.infer<typeof McpServerStdioConfigSchema>;

export const McpServerHttpConfigSchema = z.object({
  transport: z.literal('http'),
  url: z.string().url(),
  headers: StringRecordSchema.optional(),
  // Backward-compatible UI marker. OAuth is still discovered from a remote
  // server's 401 response; this flag only records that the user explicitly
  // chose OAuth and lets hosts expose login/reset controls before connecting.
  auth: z.literal('oauth').optional(),
  // Indirect secret reference: the bearer token is looked up from
  // `process.env[bearerTokenEnvVar]` at connection time, never committed.
  bearerTokenEnvVar: z.string().min(1).optional(),
  ...McpServerCommonFields,
});

export type McpServerHttpConfig = z.infer<typeof McpServerHttpConfigSchema>;

export const McpServerSseConfigSchema = z.object({
  transport: z.literal('sse'),
  url: z.string().url(),
  headers: StringRecordSchema.optional(),
  auth: z.literal('oauth').optional(),
  // Indirect secret reference: the bearer token is looked up from
  // `process.env[bearerTokenEnvVar]` at connection time, never committed.
  bearerTokenEnvVar: z.string().min(1).optional(),
  ...McpServerCommonFields,
});

export type McpServerSseConfig = z.infer<typeof McpServerSseConfigSchema>;

export type McpRemoteServerConfig = McpServerHttpConfig | McpServerSseConfig;

const McpServerConfigDiscriminatedSchema = z.discriminatedUnion('transport', [
  McpServerStdioConfigSchema,
  McpServerHttpConfigSchema,
  McpServerSseConfigSchema,
]);

export const McpServerConfigSchema = z.preprocess((raw) => {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return raw;
  const obj = raw as Record<string, unknown>;
  if ('transport' in obj) return obj;
  if (typeof obj['command'] === 'string') return { ...obj, transport: 'stdio' };
  if (typeof obj['url'] === 'string') return { ...obj, transport: 'http' };
  return obj;
}, McpServerConfigDiscriminatedSchema);

export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;

export const CloudCodeConfigSchema = z.object({
  providers: z.record(z.string(), ProviderConfigSchema).default({}),
  defaultProvider: z.string().optional(),
  defaultModel: z.string().optional(),
  models: z.record(z.string(), ModelAliasSchema).optional(),
  thinking: ThinkingConfigSchema.optional(),
  serviceTier: ServiceTierConfigSchema.optional(),
  planMode: z.boolean().optional(),
  yolo: z.boolean().optional(),
  defaultPermissionMode: PermissionModeSchema.optional(),
  defaultPlanMode: z.boolean().optional(),
  permission: PermissionConfigSchema.optional(),
  hooks: z.array(HookDefSchema).optional(),
  services: ServicesConfigSchema.optional(),
  mergeAllAvailableSkills: z.boolean().optional(),
  extraSkillDirs: z.array(z.string()).optional(),
  /**
   * Active output style (`profile/output-style.ts`): the name of a style that
   * replaces the system prompt's style surface at assembly time. Absent or
   * `"default"` means the stock prompt.
   */
  outputStyle: z.string().optional(),
  extraAgentDirs: z.array(z.string()).optional(),
  loopControl: LoopControlSchema.optional(),
  behaviorReminders: BehaviorRemindersConfigSchema.optional(),
  goal: GoalConfigSchema.optional(),
  background: BackgroundConfigSchema.optional(),
  subagent: SubagentConfigSchema.optional(),
  secondaryModel: SecondaryModelConfigSchema.optional(),
  mcp: McpConfigSchema.optional(),
  image: ImageConfigSchema.optional(),
  snapshot: SnapshotConfigSchema.optional(),
  sandbox: SandboxConfigSchema.optional(),
  shellSession: ShellSessionConfigSchema.optional(),
  guardian: GuardianConfigSchema.optional(),
  debug: DebugConfigSchema.optional(),
  modelCatalog: ModelCatalogConfigSchema.optional(),
  experimental: ExperimentalConfigSchema.optional(),
  raw: z.record(z.string(), z.unknown()).optional(),
});

export type CloudCodeConfig = z.infer<typeof CloudCodeConfigSchema>;

const ProviderConfigPatchSchema = ProviderConfigSchema.partial();
const ModelAliasPatchSchema = ModelAliasSchema.partial();
const ThinkingConfigPatchSchema = ThinkingConfigSchema.partial();
const PermissionConfigPatchSchema = PermissionConfigSchema.partial();
const LoopControlPatchSchema = LoopControlSchema.partial();
const BehaviorRemindersConfigPatchSchema = BehaviorRemindersConfigSchema.partial();
const GoalConfigPatchSchema = GoalConfigSchema.partial();
const BackgroundConfigPatchSchema = BackgroundConfigSchema.partial();
const SubagentConfigPatchSchema = SubagentConfigSchema.partial();
const SecondaryModelConfigPatchSchema = SecondaryModelConfigSchema.partial();
const McpConfigPatchSchema = McpConfigSchema.partial();
const ImageConfigPatchSchema = ImageConfigSchema.partial();
const SnapshotConfigPatchSchema = SnapshotConfigSchema.partial();
const SandboxConfigPatchSchema = SandboxConfigSchema.partial();
const ShellSessionConfigPatchSchema = ShellSessionConfigSchema.partial();
const GuardianConfigPatchSchema = GuardianConfigSchema.partial();
const DebugConfigPatchSchema = DebugConfigSchema.partial();
const ModelCatalogConfigPatchSchema = ModelCatalogConfigSchema.partial();
const ExperimentalConfigPatchSchema = ExperimentalConfigSchema;
const MoonshotServiceConfigPatchSchema = MoonshotServiceConfigSchema.partial();
const ServicesConfigPatchSchema = z.object({
  moonshotSearch: MoonshotServiceConfigPatchSchema.optional(),
  moonshotFetch: MoonshotServiceConfigPatchSchema.optional(),
});

export const CloudCodeConfigPatchSchema = z
  .object({
    providers: z.record(z.string(), ProviderConfigPatchSchema).optional(),
    defaultProvider: z.string().optional(),
    defaultModel: z.string().optional(),
    models: z.record(z.string(), ModelAliasPatchSchema).optional(),
    thinking: ThinkingConfigPatchSchema.optional(),
    serviceTier: ServiceTierConfigSchema.optional(),
    planMode: z.boolean().optional(),
    yolo: z.boolean().optional(),
    defaultPermissionMode: PermissionModeSchema.optional(),
    defaultPlanMode: z.boolean().optional(),
    permission: PermissionConfigPatchSchema.optional(),
    hooks: z.array(HookDefSchema).optional(),
    services: ServicesConfigPatchSchema.optional(),
    mergeAllAvailableSkills: z.boolean().optional(),
    extraSkillDirs: z.array(z.string()).optional(),
    outputStyle: z.string().optional(),
    extraAgentDirs: z.array(z.string()).optional(),
    loopControl: LoopControlPatchSchema.optional(),
    behaviorReminders: BehaviorRemindersConfigPatchSchema.optional(),
    goal: GoalConfigPatchSchema.optional(),
    background: BackgroundConfigPatchSchema.optional(),
    subagent: SubagentConfigPatchSchema.optional(),
    secondaryModel: SecondaryModelConfigPatchSchema.optional(),
    mcp: McpConfigPatchSchema.optional(),
    image: ImageConfigPatchSchema.optional(),
    snapshot: SnapshotConfigPatchSchema.optional(),
    sandbox: SandboxConfigPatchSchema.optional(),
    shellSession: ShellSessionConfigPatchSchema.optional(),
    guardian: GuardianConfigPatchSchema.optional(),
    debug: DebugConfigPatchSchema.optional(),
    modelCatalog: ModelCatalogConfigPatchSchema.optional(),
    experimental: ExperimentalConfigPatchSchema.optional(),
  })
  .strict();

export type CloudCodeConfigPatch = z.infer<typeof CloudCodeConfigPatchSchema>;

export function getDefaultConfig(): CloudCodeConfig {
  return {
    providers: {},
  };
}

export function validateConfig(config: unknown): CloudCodeConfig {
  try {
    return CloudCodeConfigSchema.parse(config);
  } catch (error) {
    throw new CloudCodeError(ErrorCodes.CONFIG_INVALID, `Invalid configuration: ${formatConfigValidationError(error)}`, {
      cause: error,
    });
  }
}

export function formatConfigValidationError(error: unknown): string {
  const missingModelContextSize = missingModelContextSizeMessage(error);
  if (missingModelContextSize !== undefined) return missingModelContextSize;
  return error instanceof Error ? error.message : String(error);
}

function missingModelContextSizeMessage(error: unknown): string | undefined {
  if (!(error instanceof z.ZodError)) return undefined;
  for (const issue of error.issues) {
    const [section, modelName, field] = issue.path;
    if (section === 'models' && typeof modelName === 'string' && field === 'maxContextSize') {
      return `Model "${modelName}" must define a positive max_context_size in config.toml.`;
    }
  }
  return undefined;
}

function isValidPermissionPattern(pattern: string): boolean {
  try {
    parsePattern(pattern);
    return true;
  } catch {
    return false;
  }
}
