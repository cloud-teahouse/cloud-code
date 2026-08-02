import { join } from 'pathe';

import { normalizeAdditionalDirs } from '../config';
import { ErrorCodes, makeErrorPayload } from '#/errors';
import { log } from '#/logging/logger';
import type { Logger } from '#/logging/types';
import type { AgentAPI, AgentEvent, CloudCodeConfig, SDKAgentRPC, UsageStatus } from '#/rpc';
import { generate } from '@cloud-code/kosong';

import type { EnabledPluginSessionStart, EnabledPluginSystemPrompt, PluginCommandDef } from '#/plugin';

import type { McpConnectionManager } from '../mcp';
import { FlagResolver, type ExperimentalFlagResolver } from '../flags';
import { ImageLimits } from '../tools/support/image-limits';
import {
  BUILTIN_OUTPUT_STYLES,
  formatMcpServerInstructions,
  getUserLanguage,
  normalizeOutputStyleName,
  prepareSystemPromptContext,
  resolveOutputStyle,
  SystemPromptAssembly,
  type OutputStyleDefinition,
  type PreparedSystemPromptContext,
  type ResolvedAgentProfile,
} from '../profile';
import { composePluginSections, PLUGIN_SECTIONS_MAX_BYTES } from '../profile/plugin-sections';
import type { ModelProvider } from '../session/provider-manager';
import type { SessionSubagentHost } from '../session/subagent-host';
import type { PromisableMethods } from '../utils/types';
import { BackgroundManager, BackgroundTaskPersistence } from './background';
import { ShellSessionManager } from './shell-session';
import { FullCompaction, GraduatedCompaction } from './compaction';
import { CronManager } from './cron';
import { ConfigState } from './config';
import { ContextMemory, type ResumeAuditFinding, type ResumeRepairEntry } from './context';
import { GoalMode } from './goal';
import { HookEngine } from '../session/hooks';
import { InjectionManager } from './injection/manager';
import {
  RESUME_CONTINUATION_REMINDER,
  RESUME_CONTINUATION_VARIANT,
} from './injection/resume-continuation';
import { PermissionManager } from './permission';
import { PlanMode } from './plan';
import {
  AgentRecords,
  BlobStore,
  FileSystemAgentRecordPersistence,
  type AgentRecord,
  type AgentRecordsReplayOptions,
} from './records';
import { ReplayBuilder } from './replay';
import { SkillManager } from './skill';
import { SnapshotManager } from './snapshot';
import { SwarmMode } from './swarm';
import type { TeammateIdentity } from './swarm/teammate-context';
import type { MailboxService } from './swarm/mailbox-service';
import type { TeamStore } from './swarm/team-store';
import { CoordinatorMode } from './coordinator';
import { ToolManager } from './tool/index';
import { TurnFlow } from './turn';
import { WorktreeMode } from './worktree';
import { KosongLLM } from './turn/kosong-llm';
import { UsageRecorder } from './usage';
import { LlmRequestLogger } from './llm-request-logger';
import { cacheDiagnosticsEnabled, LlmRequestRecorder } from './llm-request-recorder';
import { resolveCompletionBudget } from '../utils/completion-budget';
import type { Kaos } from '@cloud-code/kaos';
import { SandboxManager } from '@cloud-code/kaos';
import type { ToolServices } from '../tools/support/services';
import type { AgentOptions, AgentType } from './options';
import { GeneratePipeline } from './generate';
import { buildRpcMethods } from './rpc-methods';

export class Agent {
  readonly type: AgentType;
  private _kaos: Kaos;

  get kaos(): Kaos {
    return this._kaos;
  }

  /**
   * The session config snapshot this agent reads (loop control, subagent
   * binding descriptions, ...). Mutable via {@link updateKimiConfig} so the
   * session can push live config updates (e.g. a `/secondary_model` switch)
   * to already-instantiated agents.
   */
  kimiConfig?: CloudCodeConfig;
  readonly homedir?: string;
  readonly brandHomeDir?: string;
  readonly mediaOriginalsDir?: string;
  readonly rpc?: Partial<SDKAgentRPC>;
  readonly toolServices?: ToolServices;
  readonly pluginSessionStarts: readonly EnabledPluginSessionStart[];
  readonly pluginCommands: readonly PluginCommandDef[];
  private pluginSystemPrompts: readonly EnabledPluginSystemPrompt[];
  private readonly emittedPluginBudgetWarnings = new Set<string>();
  readonly rawGenerate: typeof generate;
  readonly modelProvider?: ModelProvider;
  readonly subagentHost?: SessionSubagentHost;
  readonly mcp?: McpConnectionManager;
  readonly hooks?: HookEngine;
  readonly log: Logger;
  readonly experimentalFlags: ExperimentalFlagResolver;
  readonly imageLimits: ImageLimits;

  readonly llmRequestLogger: LlmRequestLogger;
  readonly llmRequestRecorder: LlmRequestRecorder;
  /**
   * Request-dispatch boundary behind {@link generate}: owns the wire-boundary
   * normalize-repair reporting and the Anthropic thinking-effort capability
   * warnings layered onto every outbound request.
   */
  private readonly generatePipeline: GeneratePipeline;
  /**
   * Sectioned system prompt owner: assembles the rendered profile
   * prompt into named/cache-classed sections, owns the append bus, and feeds
   * section-level drift attribution to {@link llmRequestRecorder}.
   */
  readonly systemPromptSections: SystemPromptAssembly;
  readonly blobStore: BlobStore | undefined;
  readonly records: AgentRecords;
  readonly fullCompaction: FullCompaction;
  readonly graduatedCompaction: GraduatedCompaction;
  readonly context: ContextMemory;
  readonly config: ConfigState;
  readonly turn: TurnFlow;
  readonly injection: InjectionManager;
  readonly permission: PermissionManager;
  readonly planMode: PlanMode;
  readonly swarmMode: SwarmMode;
  readonly worktree: WorktreeMode;
  readonly coordinatorMode: CoordinatorMode;
  readonly usage: UsageRecorder;
  readonly snapshot: SnapshotManager;
  readonly sandbox: SandboxManager;
  readonly skills: SkillManager | null;
  readonly tools: ToolManager;
  readonly background: BackgroundManager;
  readonly shellSessions: ShellSessionManager;
  readonly cron: CronManager | null;
  /**
   * Session-shared team store: team files + shared task lists. Null for
   * standalone agents; the TeamTask* tools register only when present.
   */
  readonly teamStore: TeamStore | null;
  /**
   * Session-shared mailbox service: inboxes + delivery + shutdown
   * protocol. Null for standalone agents; SendMessage registers only when
   * present.
   */
  readonly mailbox: MailboxService | null;
  readonly goal: GoalMode;
  readonly replayBuilder: ReplayBuilder;

  /**
   * Print-mode (`cloud-code -p`) only: when true and the agent ends a turn while
   * background subagents (`kind === 'agent'`) are still running, the turn loop
   * holds the turn open and idle-waits until they finish, flushing their
   * completions into the turn so the model can react before the run exits. Set
   * by the session for print runs; defaults to false everywhere else.
   */
  printDrainAgentTasksOnStop = false;

  /**
   * Topology latch: set by the subagent host when this agent runs as
   * a worker of a coordinator-mode parent. While latched,
   * `CoordinatorWorkerSpawnDenyPermissionPolicy` denies Agent/AgentSwarm so
   * the agent graph stays two levels deep — workers never spawn workers.
   */
  private coordinatorWorker = false;

  /** Latch (or clear) the coordinator-worker topology marker for this run. */
  setCoordinatorWorker(value: boolean): void {
    this.coordinatorWorker = value;
  }

  get isCoordinatorWorker(): boolean {
    return this.coordinatorWorker;
  }

  /**
   * Teammate identity latch: set by the subagent host when this
   * agent runs as an in-process teammate. While latched,
   * `TeammateSpawnDenyPermissionPolicy` denies nested teammate spawns and
   * background-agent launches (the topology constraints documented there). The latch lives on
   * the agent instance — rather than only in the AsyncLocalStorage teammate
   * context — so turns launched outside the storage scope (e.g. a
   * background-notification steer) stay covered.
   */
  private teammateIdentity: TeammateIdentity | undefined;

  /** Latch (or clear) the teammate identity for this run. */
  setTeammateIdentity(identity: TeammateIdentity | undefined): void {
    this.teammateIdentity = identity;
  }

  get isTeammate(): boolean {
    return this.teammateIdentity !== undefined;
  }

  get teammate(): TeammateIdentity | undefined {
    return this.teammateIdentity;
  }

  private additionalDirs: readonly string[];
  private activeProfile?: ResolvedAgentProfile;
  /**
   * True when this agent is a transient replay preview (`AgentOptions.replay`
   * set — `buildReplay` and range-limited/frozen replays). Preview agents must
   * never append records, so resume-time record-writing behavior (the
   * interrupted-turn continuation reminder) is gated off for them.
   */
  private readonly isReplayPreview: boolean;
  private brandHome?: string;
  /**
   * The `CLOUD_CODE_NOW` template value, captured once at this agent's first system
   * prompt render and reused for every later render. Matches the template's
   * own wording ("captured when the session started") and keeps repeat renders
   * (post-compaction refresh, MCP instructions refresh) byte-identical so the
   * prompt-cache prefix survives. Restored from the persisted system prompt on
   * resume via {@link latchSessionNowFromPrompt}.
   */
  private sessionNow: string | undefined;
  /**
   * Explicit UI language rendered into the system prompt's `# Language`
   * section. Latched like {@link sessionNow}: captured once from the
   * process-wide preference at construction and held fixed for every later
   * render, so re-renders stay byte-identical. A mid-session `/language`
   * switch updates it via {@link setUserLanguage} with a one-time
   * `refreshSystemPrompt()` (deliberate, rare cache bust).
   */
  private userLanguage: string | undefined;
  /**
   * Active output style name, latched like {@link userLanguage}: seeded from
   * the persisted config at construction and held fixed for every render, so
   * re-renders stay byte-identical. A mid-session `/output-style` switch
   * updates it via {@link setOutputStyle} with a one-time re-render.
   */
  private outputStyleName: string | undefined;
  private readonly outputStylesProvider: (() => readonly OutputStyleDefinition[]) | undefined;
  private readonly systemPromptContextProvider?: (() => Promise<PreparedSystemPromptContext>) | undefined;

  constructor(options: AgentOptions) {
    this.type = options.type ?? 'main';
    this._kaos = options.kaos;
    this.kimiConfig = options.config;
    this.homedir = options.homedir;
    this.brandHomeDir = options.brandHomeDir;
    this.mediaOriginalsDir = options.mediaOriginalsDir;
    this.rpc = options.rpc;
    this.toolServices = options.toolServices;
    this.pluginSessionStarts = options.pluginSessionStarts ?? [];
    this.pluginCommands = options.pluginCommands ?? [];
    this.pluginSystemPrompts = options.pluginSystemPrompts ?? [];
    this.rawGenerate = options.generate ?? generate;
    this.modelProvider = options.modelProvider;
    this.subagentHost = options.subagentHost;
    this.mcp = options.mcp;
    this.hooks = options.hookEngine;
    this.log = options.log ?? log;
    this.experimentalFlags = options.experimentalFlags ?? new FlagResolver();
    this.imageLimits = options.imageLimits ?? new ImageLimits();
    this.additionalDirs = normalizeAdditionalDirs(options.additionalDirs ?? []);
    this.isReplayPreview = options.replay !== undefined;
    this.systemPromptContextProvider = options.systemPromptContextProvider;
    this.userLanguage = getUserLanguage();
    this.outputStyleName = normalizeOutputStyleName(options.config?.outputStyle);
    this.outputStylesProvider = options.outputStylesProvider;

    this.llmRequestLogger = new LlmRequestLogger(this.log);
    this.llmRequestRecorder = new LlmRequestRecorder(this);
    this.generatePipeline = new GeneratePipeline(this);
    this.systemPromptSections = new SystemPromptAssembly({
      log: this.log,
      isDiagnosticsEnabled: () => cacheDiagnosticsEnabled(this.kimiConfig),
    });
    this.blobStore = options.homedir
      ? new BlobStore({ blobsDir: join(options.homedir, 'blobs') })
      : undefined;
    this.records = new AgentRecords(
      this,
      options.persistence ??
        (options.homedir
          ? new FileSystemAgentRecordPersistence(join(options.homedir, 'wire.jsonl'), {
              onError: (error) => {
                this.emitRecordsWriteError(error);
              },
              blobStore: this.blobStore,
            })
          : undefined),
    );
    this.fullCompaction = new FullCompaction(this, options.compactionStrategy);
    this.graduatedCompaction = new GraduatedCompaction(this, options.graduatedCompaction);
    this.context = new ContextMemory(this);
    this.config = new ConfigState(this);
    this.turn = new TurnFlow(this);
    this.injection = new InjectionManager(this);
    this.permission = new PermissionManager(this, options.permission);
    this.planMode = new PlanMode(this);
    this.swarmMode = new SwarmMode(this);
    this.worktree = new WorktreeMode(this);
    this.coordinatorMode = new CoordinatorMode(this);
    this.usage = new UsageRecorder(this);
    this.snapshot = new SnapshotManager(this);
    this.sandbox = new SandboxManager({
      onWarning: (message) => this.log.warn(message),
    });
    this.skills = options.skills ? new SkillManager(this, options.skills) : null;
    this.tools = new ToolManager(this);
    this.background = new BackgroundManager(
      this,
      this.homedir === undefined ? undefined : new BackgroundTaskPersistence(this.homedir),
    );
    // Persistent PTY sessions (ExecSession/WriteStdin): per-agent registry
    // riding on the background task machinery. Config is resolved lazily so
    // a config reload applies to new sessions and idle re-arms. Lifecycle
    // transitions are mirrored into the wire log as observability records
    // (RFC unified-exec-pty §3.5 v2); records.logRecord gates replay writes.
    this.shellSessions = new ShellSessionManager(
      this.background,
      () => this.kimiConfig?.shellSession ?? {},
      (record) => {
        this.records.logRecord(record);
      },
    );
    this.cron = this.type === 'sub' ? null : new CronManager(this);
    this.teamStore = options.teamStore ?? null;
    this.mailbox = options.mailbox ?? null;
    this.goal = new GoalMode(this);
    this.replayBuilder = new ReplayBuilder(this, options.replay);
  }

  setKaos(kaos: Kaos) {
    this._kaos = kaos;
  }

  /**
   * The fixed `CLOUD_CODE_NOW` value for this agent: the first render's timestamp,
   * or the value latched from the restored system prompt after resume.
   */
  get systemPromptNow(): string {
    this.sessionNow ??= new Date().toISOString();
    return this.sessionNow;
  }

  /**
   * Latch `sessionNow` from a rendered system prompt landing in config state
   * (live render or records restore). No-op once set: the value captured at
   * the session's first render wins for the agent's lifetime. Extraction keys
   * off the template's own "Date and Time" sentence, so a prompt persisted by
   * any version that shares the template line restores byte-identically.
   */
  latchSessionNowFromPrompt(systemPrompt: string): void {
    if (this.sessionNow !== undefined) return;
    const match = SESSION_NOW_PROMPT_PATTERN.exec(systemPrompt);
    const captured = match?.[1];
    if (captured !== undefined && captured.length > 0) {
      this.sessionNow = captured;
    }
  }

  /**
   * Update the latched UI-language preference and re-render the system
   * prompt once so the `# Language` section reflects it. This is a
   * deliberate one-time prompt-cache bust for a rare user action; after
   * the re-render the new value is latched again and later turns hit the
   * cache as before. No-op when unchanged.
   */
  async setUserLanguage(language: string | undefined): Promise<void> {
    if (this.userLanguage === language) return;
    this.userLanguage = language;
    await this.refreshSystemPrompt();
  }

  /**
   * Switch the active output style and re-render the system prompt once so
   * the style-surface sections reflect it. Same deliberate one-time
   * prompt-cache bust as {@link setUserLanguage}; afterwards the new style is
   * latched and later turns hit the cache as before. No-op when unchanged.
   * An unknown name resolves to the stock prompt at render time.
   */
  async setOutputStyle(name: string | undefined): Promise<void> {
    const normalized = normalizeOutputStyleName(name);
    if (this.outputStyleName === normalized) return;
    this.outputStyleName = normalized;
    await this.refreshSystemPrompt();
  }

  /** The resolved active output style, or undefined for the stock prompt. */
  private activeOutputStyle(): OutputStyleDefinition | undefined {
    return resolveOutputStyle(
      this.outputStylesProvider?.() ?? BUILTIN_OUTPUT_STYLES,
      this.outputStyleName,
    );
  }

  getAdditionalDirs(): readonly string[] {
    return this.additionalDirs;
  }

  /**
   * Absolute path of this agent's wire transcript (`<homedir>/wire.jsonl`),
   * which keeps every record — including the history compaction folds away.
   * Undefined for ephemeral agents without a homedir.
   */
  get transcriptPath(): string | undefined {
    return this.homedir === undefined ? undefined : join(this.homedir, 'wire.jsonl');
  }

  setAdditionalDirs(additionalDirs: readonly string[]): void {
    this.additionalDirs = normalizeAdditionalDirs(additionalDirs);
    if (this.config.hasProvider) {
      this.tools.initializeBuiltinTools();
    }
  }

  /**
   * Single decision point for select_tools progressive disclosure. All three
   * gates must be open: the model has the `dynamically_loaded_tools`
   * capability (message-level tool declarations), the model declares
   * `tool_use` (a model without tool use loading tools dynamically is a
   * contradiction), and the `tool-select` experimental flag is on. Every
   * consumer — top-level tools[] convergence, select_tools registration,
   * manifest announcements, projection shaping — reads this instead of
   * re-deriving the conditions, so degradation is lossless: any closed gate
   * reproduces the inline behavior byte-for-byte.
   */
  get toolSelectEnabled(): boolean {
    const capability = this.config.modelCapabilities;
    return (
      capability.dynamically_loaded_tools === true &&
      capability.tool_use &&
      this.experimentalFlags.enabled('tool-select')
    );
  }

  get generate(): typeof generate {
    return this.generatePipeline.createGenerate();
  }

  warnAboutCurrentAnthropicThinkingEffort(): void {
    this.generatePipeline.warnAboutCurrentAnthropicThinkingEffort();
  }

  get llm(): KosongLLM {
    // All provider-level request config (thinking, sampling params, thinking.keep)
    // is applied in ConfigState.provider so compaction shares it. See get provider().
    const provider = this.config.provider;
    const loopControl = this.kimiConfig?.loopControl;
    const completionBudgetConfig = resolveCompletionBudget({
      maxOutputSize: this.config.maxOutputSize,
      reservedContextSize: loopControl?.reservedContextSize,
    });
    return new KosongLLM({
      provider,
      systemPrompt: this.config.systemPrompt,
      capability: this.config.modelCapabilities,
      generate: this.generate,
      completionBudgetConfig,
      usedContextTokens: () => this.context.tokenCount,
    });
  }

  useProfile(
    profile: ResolvedAgentProfile,
    context?: PreparedSystemPromptContext,
    brandHome?: string,
    subagentNames?: readonly string[],
  ): void {
    this.setActiveProfile(profile, brandHome);
    this.updateSystemPromptFromProfile(profile, context, subagentNames);
    this.tools.setActiveTools(profile.tools, profile.disallowedTools);
  }

  /** Push a refreshed session config snapshot and rebuild config-dependent builtin tools. */
  updateKimiConfig(config: CloudCodeConfig | undefined): void {
    this.kimiConfig = config;
    if (this.config.hasProvider) {
      this.tools.refreshBuiltinTools();
    }
  }

  /**
   * Replace the enabled plugins' system-prompt contributions. Does not
   * re-render on its own — pair with `refreshSystemPrompt()` so callers decide
   * when the prompt-cache prefix is invalidated.
   */
  setPluginSystemPrompts(sections: readonly EnabledPluginSystemPrompt[]): void {
    this.pluginSystemPrompts = sections;
  }

  /**
   * Warn once per plugin when its system-prompt contribution is skipped
   * because the aggregate budget is exhausted; a skipped contribution keeps
   * being skipped on every re-render, so the warning is deduped by plugin id.
   */
  private warnAboutSkippedPluginSections(skipped: readonly string[]): void {
    const newlySkipped = skipped.filter((id) => !this.emittedPluginBudgetWarnings.has(id));
    if (newlySkipped.length === 0) return;
    for (const id of newlySkipped) this.emittedPluginBudgetWarnings.add(id);
    const message =
      `Plugin system-prompt contributions from ${newlySkipped.map((id) => `"${id}"`).join(', ')} ` +
      `were skipped: the aggregate ${PLUGIN_SECTIONS_MAX_BYTES / 1024} KB budget is exhausted.`;
    this.log.warn(message);
    this.emitEvent({
      type: 'warning',
      code: 'plugin-sections-oversized',
      message,
    });
  }

  setActiveProfile(profile: ResolvedAgentProfile, brandHome?: string): void {
    this.activeProfile = profile;
    this.brandHome = brandHome;
  }

  /**
   * Re-render the system prompt with freshly gathered runtime context (cwd
   * listing, AGENTS.md, additional-dirs info, skill list). Called after
   * compaction so the post-compaction turns see the workspace as it is now.
   * The `CLOUD_CODE_NOW` timestamp stays fixed at the first-render value, so when
   * none of the refreshed sections actually changed the re-render is
   * byte-identical and the prompt-cache prefix survives.
   */
  async refreshSystemPrompt(): Promise<void> {
    if (this.activeProfile === undefined) return;
    const context = this.systemPromptContextProvider === undefined
      ? await prepareSystemPromptContext(this.kaos, this.brandHome, {
          additionalDirs: this.additionalDirs,
          includeGitStatus: this.type === 'main',
        })
      : await this.systemPromptContextProvider();
    this.updateSystemPromptFromProfile(this.activeProfile, context);
  }

  private updateSystemPromptFromProfile(
    profile: ResolvedAgentProfile,
    context?: PreparedSystemPromptContext,
    subagentNames?: readonly string[],
  ): void {
    const pluginSections = composePluginSections(this.pluginSystemPrompts);
    this.warnAboutSkippedPluginSections(pluginSections.skipped);
    const renderedPrompt = profile.systemPrompt({
      osEnv: this.kaos.osEnv,
      cwd: this.config.cwd,
      skills: this.skills?.registry,
      pluginSections: pluginSections.content,
      // Fixed at the first render (or restored on resume): re-renders must
      // not move the timestamp or every refresh would bust the prompt-cache
      // prefix — see the field note on `sessionNow`.
      now: this.systemPromptNow,
      // Latched like `now` (see the field note on `userLanguage`): only a
      // `/language` switch moves it, via setUserLanguage()'s one-time bust.
      userLanguage: this.userLanguage,
      cwdListing: context?.cwdListing,
      agentsMd: context?.agentsMd,
      memory: context?.memory,
      additionalDirsInfo: context?.additionalDirsInfo,
      gitStatus: context?.gitStatus,
      mcpInstructions: currentMcpInstructions(this.mcp),
    });
    // Sectioned assembly: with an empty append bus the joined prompt is
    // the rendered bytes exactly, so `systemPromptNow` latching and
    // resume/fork byte-stability are preserved; the assembly only adds ids,
    // cache classes, per-section hashes, and the addendum tail on top. The
    // active output style (when one is selected) replaces the style-surface
    // sections here — replacement, never append (profile/output-style.ts).
    const assembled = this.systemPromptSections.assemble(
      profile.name,
      renderedPrompt,
      this.activeOutputStyle(),
    );
    this.config.update({ profileName: profile.name, systemPrompt: assembled.prompt, subagentNames });
  }

  /**
   * Append bus: attach an extra instruction block that always lands at
   * the system prompt tail, after every profile section (`origin: 'append'`).
   * Same `id` replaces in place. Session-owned: like the active profile, the
   * caller re-applies addenda after resume — the joined prompt persists in
   * `config.update`, bus membership does not.
   *
   * Override contract (Claude's override branch semantics — the override
   * returns WITHOUT append): a `config.update({systemPrompt})` direct set
   * replaces the assembled prompt wholesale. While an override is live, bus
   * operations only register membership; they re-apply on the next profile
   * render (`useProfile`/`refreshSystemPrompt`). The bus never composes with
   * or clobbers an override.
   */
  setSystemPromptAddendum(id: string, content: string): void {
    this.systemPromptSections.setAddendum({ id, content });
    this.pushAssembledPromptIfLive();
  }

  /**
   * Remove an append-bus addendum by id. Unknown id is a true no-op — in
   * particular it never re-assembles, so a live override prompt survives.
   */
  clearSystemPromptAddendum(id: string): void {
    if (!this.systemPromptSections.clearAddendum(id)) return;
    this.pushAssembledPromptIfLive();
  }

  /**
   * Re-assemble with the bus as registered and push the result to config —
   * but only while the assembled prompt is the live one (heuristic: the
   * current assembly's prompt equals `config.systemPrompt`). With an override
   * live (or no profile render yet), the registration stays pending for the
   * next profile render instead.
   */
  private pushAssembledPromptIfLive(): void {
    const snapshot = this.systemPromptSections.snapshot();
    if (snapshot === undefined || snapshot.prompt !== this.config.systemPrompt) return;
    const assembled = this.systemPromptSections.reassemble();
    if (assembled !== undefined && assembled.prompt !== this.config.systemPrompt) {
      this.config.update({ systemPrompt: assembled.prompt });
    }
  }

  async resume(options?: AgentRecordsReplayOptions): Promise<{ warning?: string }> {
    const result = await this.records.replay(options);
    this.generatePipeline.flushPendingAnthropicThinkingEffortWarnings();
    try {
      this.replayBuilder.postRestoring = true;
      this.goal.normalizeAfterReplay();
      await this.background.loadFromDisk();
      await this.background.reconcile();
      await this.cron?.loadFromDisk();
      const finish = this.context.finishResume();
      const trailingTurnCancelled = this.turn.finishResume();
      this.maybeInjectResumeContinuation(
        finish.closedToolCallIds.length > 0,
        trailingTurnCancelled,
      );
      this.reportResumeAudit(this.context.auditAfterResume(), this.context.resumeRepairs);
    } finally {
      this.replayBuilder.postRestoring = false;
    }
    return result;
  }

  /**
   * Interrupted-turn continuation ("Continue from where you left off"):
   * when the wire log shows the trailing turn never finished — the
   * process died mid tool exchange (the resume-time close just fired) or
   * before the assistant answered the last prompt — append a one-shot
   * standard-tier reminder so the next turn picks the work up instead of
   * treating the truncated transcript as final.
   *
   * Guardrails (each mirrors a Claude misfire class):
   * - replay previews never inject: they are transient and must not append
   *   records;
   * - a trailing `turn.cancel` means the user stopped the turn deliberately —
   *   not an interruption;
   * - the dedup settles inside `hasUnansweredTailPrompt`: a persisted
   *   reminder from an earlier resume keeps a second copy from stacking.
   */
  private maybeInjectResumeContinuation(
    interruptedMidTool: boolean,
    trailingTurnCancelled: boolean,
  ): void {
    if (this.isReplayPreview) return;
    if (trailingTurnCancelled) return;
    if (!interruptedMidTool && !this.context.hasUnansweredTailPrompt()) return;
    this.context.appendSystemReminder(RESUME_CONTINUATION_REMINDER, {
      kind: 'injection',
      variant: RESUME_CONTINUATION_VARIANT,
    });
  }

  /**
   * Resume consistency audit reporting (04i `checkResumeConsistency` analog):
   * findings mean the replay repairs could not fully reconcile the log (the
   * request-path projections still self-heal at send time — the audit exists
   * so the drift leaves a trace instead of being papered over). Warn-only:
   * resume must never fail on an audit finding. Repairs the replay layer DID
   * perform are reported too, but log-only: a fully-repaired resume is
   * forensic evidence (telemetry is gone; the log is the drift chain), not a
   * user-facing warning.
   */
  private reportResumeAudit(
    findings: readonly ResumeAuditFinding[],
    repairs: readonly ResumeRepairEntry[],
  ): void {
    if (findings.length === 0) {
      if (repairs.length > 0) {
        this.log.info('resume repaired structural drift', {
          repairs: summarizeResumeRepairs(repairs),
        });
      }
      return;
    }
    const counts = new Map<string, number>();
    for (const finding of findings) {
      counts.set(finding.kind, (counts.get(finding.kind) ?? 0) + 1);
    }
    const summary = [...counts.entries()]
      .map(([kind, count]) => `${kind}=${String(count)}`)
      .join(', ');
    this.log.warn('resume consistency audit found drift', {
      summary,
      findings: findings.slice(0, 10),
      repairs: summarizeResumeRepairs(repairs),
    });
    this.emitEvent({
      type: 'warning',
      code: 'resume-consistency-drift',
      message:
        `The resumed session's history had structural drift (${summary}). ` +
        'It was repaired where possible; request-time safeguards cover the rest.',
    });
  }

  get rpcMethods(): PromisableMethods<AgentAPI> {
    return buildRpcMethods(this);
  }

  emitEvent(event: AgentEvent): void {
    if (this.records.restoring) return;
    void this.rpc?.emitEvent?.(event);
  }

  emitStatusUpdated(includeThinkingEffort = false): void {
    if (this.records.restoring) return;
    if (!this.config.hasModel) return;

    // Report the same effective count the compaction trigger uses (raw stored
    // history minus what the armed graduated layers rewrite away). Reporting
    // the raw stored count instead would let the footer climb to ~99% while
    // the projection the model receives — and the trigger — sit far lower.
    const contextTokens = this.graduatedCompaction.effectiveTokenCount();
    const capability = this.config.modelCapabilities;
    const maxContextTokens = capability.max_input_tokens ?? capability.max_context_tokens;
    const contextUsage =
      maxContextTokens !== undefined && maxContextTokens > 0
        ? contextTokens / maxContextTokens
        : undefined;
    const usage: UsageStatus | undefined = this.usage.status();
    const model = this.config.model;

    this.emitEvent({
      type: 'agent.status.updated',
      model,
      thinkingEffort: includeThinkingEffort ? this.config.thinkingEffort : undefined,
      contextTokens,
      maxContextTokens,
      contextUsage,
      planMode: this.planMode.isActive,
      swarmMode: this.swarmMode.isActive,
      coordinatorMode: this.coordinatorMode.isActive,
      permission: this.permission.mode,
      usage,
    });
  }

  private emitRecordsWriteError(error: unknown, record?: AgentRecord | undefined): void {
    const message = error instanceof Error ? error.message : String(error);
    this.log.error('wire record persist failed', {
      agentHomedir: this.homedir,
      recordType: record?.type,
      error,
    });
    this.emitEvent({
      type: 'error',
      ...makeErrorPayload(
        ErrorCodes.RECORDS_WRITE_FAILED,
        `Failed to write agent records: ${message}`,
        {
          details: { recordType: record?.type },
        },
      ),
    });
  }
}

/**
 * Aggregate the instructions of every connected MCP server for the system
 * prompt. Read at render time so reconnects that happened since the last
 * render are picked up on the next one; `undefined` keeps the template's
 * conditional section omitted.
 */
function currentMcpInstructions(mcp: McpConnectionManager | undefined): string | undefined {
  if (mcp === undefined) return undefined;
  const formatted = formatMcpServerInstructions(mcp.serverInstructions());
  return formatted.length > 0 ? formatted : undefined;
}

/** Per-kind counts of a resume's structural repair ledger, for log payloads. */
function summarizeResumeRepairs(repairs: readonly ResumeRepairEntry[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const repair of repairs) {
    const amount = 'toolCallIds' in repair ? repair.toolCallIds.length : 1;
    counts[repair.kind] = (counts[repair.kind] ?? 0) + amount;
  }
  return counts;
}

/**
 * Matches the rendered "Date and Time" line of the default system prompt
 * template; group 1 is the `CLOUD_CODE_NOW` value rendered into it. Used to restore
 * the fixed session timestamp from a persisted prompt on resume.
 */
const SESSION_NOW_PROMPT_PATTERN = /The current date and time in ISO format is `([^`]+)`/;
