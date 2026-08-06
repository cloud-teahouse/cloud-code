import { homedir } from 'node:os';
import { join } from 'pathe';
import type { Kaos } from '@cloud-code/kaos';
import type { SessionWarning, TeamWire } from '@cloud-code/protocol';

import { ErrorCodes, CloudCodeError } from '#/errors';
import { getRootLogger, log } from '#/logging/logger';
import type { Logger, SessionLogHandle } from '#/logging/types';
import type { CloudCodeConfig, SDKSessionRPC } from '#/rpc';
import { proxyWithExtraPayload } from '#/rpc/types';

import { Agent, type AgentOptions, type AgentType } from '../agent';
import { renderPluginSessionStartReminder } from '../agent/injection/plugin-session-start';
import type { TeammateIdentity } from '../agent/swarm/teammate-context';
import { MailboxService, mailboxActivityPreview, type MailboxServiceOptions } from '../agent/swarm/mailbox-service';
import type { TeammateKeepAliveOptions } from '../agent/swarm/teammate-keepalive';
import { TeamStore } from '../agent/swarm/team-store';
import { resolveCloudCodeHome } from '../config/path';
import { HookEngine, type HookDef } from './hooks';
import type { PermissionManagerOptions, PermissionRule } from '../agent/permission';
import {
  appendWorkspaceAdditionalDir,
  normalizeAdditionalDirs,
  parseBooleanEnv,
  PRINT_MAX_TURNS_DEFAULT,
  PRINT_WAIT_CEILING_S_DEFAULT,
  readWorkspaceAdditionalDirs,
  resolveWorkspaceAdditionalDirs,
  resolveConfigValue,
  type BackgroundConfig,
  type WorkspaceAdditionalDirsLoadResult,
} from '../config';
import { makeErrorPayload } from '../errors';
import {
  McpAuthCache,
  McpConnectionManager,
  McpOAuthService,
  resolveMcpStartupTimeoutMs,
  resolveMcpToolTimeoutMs,
  type McpServerEntry,
  type SessionMcpConfig,
} from '../mcp';
import type { EnabledPluginSessionStart, EnabledPluginSystemPrompt, PluginAgentDir, PluginCommandDef, PluginOutputStyleDir } from '../plugin';
import {
  AgentProfileCatalogSnapshotSchema,
  DEFAULT_AGENT_PROFILE_NAME,
  DEFAULT_AGENT_PROFILES,
  DEFAULT_INIT_PROMPT,
  formatMcpServerInstructions,
  SessionAgentProfileCatalog,
  loadAgentsMd,
  loadCustomAgentProfiles,
  loadOutputStyles,
  normalizeOutputStyleName,
  onUserLanguageChange,
  prepareSystemPromptContext,
  resolveDefaultAgentProfiles,
  resolveOutputStyle,
  summarizeOutputStyle,
  type AgentFileRoot,
  type AgentProfileCatalogSnapshot,
  type OutputStyleDefinition,
  type OutputStyleSummary,
  type ResolvedAgentProfile,
} from '../profile';
import type { ProviderManager } from './provider-manager';
import {
  resolveSecondaryModelRecipe,
  wrapSubagentModelError,
} from './subagent-binding';
import {
  SECONDARY_DERIVED_MODEL_ALIAS,
  secondaryModelPatch,
} from '../config/secondary-model';
import {
  registerBuiltinSkills,
  SessionSkillRegistry,
  resolveSkillRoots,
  summarizeSkill,
  type SkillRoot,
  type SkillSummary,
} from '../skill';
import { SessionSubagentHost } from './subagent-host';
import { sessionMediaOriginalsDir } from '../tools/support/image-originals';
import type { ToolServices } from '../tools/support/services';
import { FlagResolver, type ExperimentalFlagResolver } from '../flags';
import { ImageLimits } from '../tools/support/image-limits';
import { abortError } from '../utils/abort';
import { resolveMainAgentProfile } from './main-agent-profile';

export interface SessionOptions {
  readonly kaos: Kaos;
  readonly persistenceKaos?: Kaos;
  readonly config?: CloudCodeConfig;
  readonly id?: string | undefined;
  readonly homedir: string;
  readonly cloudCodeHomeDir?: string;
  readonly rpc: SDKSessionRPC;
  readonly toolServices?: ToolServices;
  readonly initializeMainAgent?: boolean | undefined;
  readonly providerManager?: ProviderManager | undefined;
  readonly background?: BackgroundConfig | undefined;
  readonly hooks?: readonly HookDef[];
  readonly permissionRules?: readonly PermissionRule[];
  readonly skills?: SessionSkillConfig;
  readonly agents?: SessionAgentCatalogConfig;
  readonly mcpConfig?: SessionMcpConfig;
  readonly pluginSessionStarts?: readonly EnabledPluginSessionStart[];
  readonly pluginCommands?: readonly PluginCommandDef[];
  /** Plugin-provided agent dirs (`plugin/manager.ts` `pluginAgentDirs()`). */
  readonly pluginAgentDirs?: readonly PluginAgentDir[];
  /** Plugin-provided output-style dirs (`plugin/manager.ts` `pluginOutputStyleDirs()`). */
  readonly pluginOutputStyleDirs?: readonly PluginOutputStyleDir[];
  readonly pluginSystemPrompts?: readonly EnabledPluginSystemPrompt[];
  readonly appVersion?: string;
  readonly experimentalFlags?: ExperimentalFlagResolver;
  /** Owner-scoped [image] limits, threaded from the owning core into every agent. */
  readonly imageLimits?: ImageLimits;
  readonly additionalDirs?: readonly string[];
  /**
   * Print-mode (`cloud-code -p`) only: hold the main turn open while background
   * subagents (`kind === 'agent'`) are still running, idle-waiting until they
   * finish before the run exits. Set via the SDK `createSession` option.
   */
  readonly drainAgentTasksOnStop?: boolean;
  /**
   * Mailbox tuning: delivery poll interval and the shutdown wrap-up
   * grace window. Defaults are production values; tests shrink them.
   */
  readonly mailbox?: MailboxServiceOptions;
  /**
   * Teammate runtime tuning (idle keep-alive): how long a
   * settled teamed teammate waits for new team work before exiting, and the
   * work-check poll cadence. Defaults are production values; tests shrink
   * them. `idleTimeoutMs: 0` disables keep-alive.
   */
  readonly teammate?: TeammateKeepAliveOptions;
}

export interface SessionSkillConfig {
  readonly userHomeDir?: string;
  /** Brand data dir (CLOUD_CODE_HOME); user brand skills live under `<brandHomeDir>/skills`. */
  readonly brandHomeDir?: string;
  readonly explicitDirs?: readonly string[];
  readonly extraDirs?: readonly string[];
  readonly pluginSkillRoots?: readonly SkillRoot[];
  readonly mergeAllAvailableSkills?: boolean;
  readonly builtinDir?: string;
}

/**
 * File-defined agent (agentfile) discovery for a session. Mirrors the skill
 * discovery layout: user brand dir `<kimiHomeDir>/agents` and
 * `~/.agents/agents`, project `.cloud-code/agents` and `.agents/agents`, plus
 * configured extra dirs and explicit single files (`--agent-file`, fatal
 * when invalid). `profileName` selects the main agent's profile (`--agent`).
 */
export interface SessionAgentCatalogConfig {
  readonly userHomeDir?: string;
  readonly explicitFiles?: readonly string[];
  readonly extraDirs?: readonly string[];
  readonly profileName?: string;
  /** Agent directories contributed by enabled plugins (lowest file priority). */
  readonly pluginRoots?: readonly AgentFileRoot[];
  /** Refresh only the plugin contribution when restoring the persisted catalog. */
  readonly refreshPluginAgents?: boolean;
  /** Already-loaded catalog prepared before a persistent session is created. */
  readonly catalog?: SessionAgentProfileCatalog;
}

export interface AgentMeta {
  readonly homedir?: string;
  readonly type: AgentType;
  readonly parentAgentId?: string | null;
  readonly swarmItem?: string;
  /**
   * Set when this agent is an in-process teammate: the stable
   * teammate identity, persisted so resume/retry runs and restored sessions
   * re-establish the AsyncLocalStorage teammate context and the topology
   * latch.
   */
  readonly teammate?: TeammateIdentity;
}

interface ResumedAgent {
  readonly agent: Agent;
  readonly warning?: string;
}

type AgentEntry = Agent | Promise<ResumedAgent>;

export interface CreateAgentOptions {
  readonly profile?: ResolvedAgentProfile;
  readonly parentAgentId?: string;
  readonly swarmItem?: string;
  readonly teammate?: TeammateIdentity;
  readonly persistMetadata?: boolean;
}

export interface SessionMeta {
  createdAt: string;
  updatedAt: string;
  title: string;
  isCustomTitle: boolean;
  lastPrompt?: string;
  forkedFrom?: string;
  /** Absolute working directory the session was created in. Persisted so the
   *  session directory is self-describing and the global session index does not
   *  have to be trusted for the (one-way-hashed) workDir. */
  workDir?: string;
  /** Directories added for this session only. Unlike workspace local config,
   *  these follow the session across close/resume without affecting any other
   *  session opened in the same workspace. */
  additionalDirs?: string[];
  agents: Record<string, AgentMeta>;
  custom: Record<string, any>;
}

interface PersistedSessionState extends SessionMeta {
  /** Internal catalog binding; deliberately excluded from public SessionMeta. */
  readonly agentProfileCatalog?: unknown;
}

const BACKGROUND_KEEP_ALIVE_ON_EXIT_ENV = 'CLOUD_CODE_BACKGROUND_KEEP_ALIVE_ON_EXIT';
const ACTIVE_TURN_CLOSE_TIMEOUT_MS = 8_000;

async function waitForSettlementOrTimeout(
  promise: Promise<unknown>,
  timeoutMs: number,
): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(
        () => true,
        () => true,
      ),
      new Promise<false>((resolve) => {
        timeout = setTimeout(() => {
          resolve(false);
        }, timeoutMs);
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

/**
 * Compaction-boundary metadata tail re-append (fires during compaction
 * and at exit): wraps the
 * session RPC so a live `compaction.completed` event from the MAIN agent
 * schedules a re-append, keeping the lite reader's tail window
 * self-describing between the close-time re-appends of a long session.
 * Replay emissions never reach here (`Agent.emitEvent` gates on
 * `records.restoring`); subagent compactions are ignored because
 * `session.meta` only lives on the main agent's wire.
 */
function wrapSessionRpcForCompactionReappend(
  rpc: SDKSessionRPC,
  scheduleReappend: () => void,
): SDKSessionRPC {
  return {
    ...rpc,
    emitEvent: (event) => {
      if (event.type === 'compaction.completed' && event.agentId === 'main') {
        scheduleReappend();
      }
      return rpc.emitEvent(event);
    },
  };
}

export class Session {
  readonly rpc: SDKSessionRPC;
  readonly skills: SessionSkillRegistry;
  readonly agents: Map<string, AgentEntry> = new Map();
  readonly mcp: McpConnectionManager;
  readonly log: Logger;
  private readonly logHandle: SessionLogHandle | undefined;
  readonly hookEngine: HookEngine;
  readonly experimentalFlags: ExperimentalFlagResolver;
  readonly imageLimits: ImageLimits;
  /**
   * Session-shared team store: team files + shared task lists at
   * `<sessionDir>/teams/`. One instance is handed to every agent the session
   * creates, and to the subagent host for spawn-time team bookkeeping.
   */
  readonly teamStore: TeamStore;
  /**
   * Session-shared mailbox service: per-team inboxes, delivery
   * watchers, and the shutdown protocol. One instance is handed to every
   * agent the session creates, and to the subagent host for teammate
   * delivery wiring.
   */
  readonly mailbox: MailboxService;
  readonly agentCatalog: SessionAgentProfileCatalog;
  private toolKaos: Kaos;
  private persistenceKaos: Kaos;
  private additionalDirs: readonly string[];
  private sessionAdditionalDirs: readonly string[] = [];
  private readonly pluginCommands: readonly PluginCommandDef[];
  private pluginSystemPrompts: readonly EnabledPluginSystemPrompt[];
  private agentIdCounter = 0;
  private readonly skillsReady: Promise<void>;
  private agentProfiles: Record<string, ResolvedAgentProfile> = DEFAULT_AGENT_PROFILES;
  private readonly customAgentsReady: Promise<void>;
  /**
   * Output-style registry (`profile/output-style.ts`): builtin styles plus
   * user/project/plugin dirs, loaded once at session start. Agents read it
   * live through the provider passed at construction; `listOutputStyles` and
   * `setOutputStyle` await `outputStylesReady` first.
   */
  private outputStyles: readonly OutputStyleDefinition[] = [];
  private readonly outputStylesReady: Promise<void>;
  metadata: SessionMeta = {
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    title: 'New Session',
    isCustomTitle: false,
    agents: {},
    custom: {},
  };
  private writeMetadataPromise = Promise.resolve();
  private agentProfileSnapshot: AgentProfileCatalogSnapshot | undefined;
  private agentsMdWarning: string | undefined;
  // Aggregated MCP server instructions last rendered into agent system
  // prompts; compared in `refreshAgentsOnMcpInstructionsChange`.
  private lastMcpInstructionsBlock = '';
  // True while the startup `connectAll` is still in flight: per-server status
  // events arrive one by one, and refreshing on each would bust every ready
  // agent's prompt-cache prefix several times in a row. Refreshes are gated
  // until the initial load settles, then a single aggregated refresh runs.
  private mcpInitialLoadPending = false;
  private printSteerDeadline: number | undefined;
  private printSteerTurns = 0;
  private readonly unsubscribeUserLanguage: () => void;
  /**
   * The session's live config snapshot. Initialized from `options.config`;
   * updated in place by {@link setSecondaryModelConfig} and
   * {@link setOutputStyle} so mid-session switches reach the readers of the
   * snapshot (spawn-binding, tool descriptions, agent construction) without
   * recreating the session.
   */
  private runtimeConfig: CloudCodeConfig | undefined;

  /** The session's current config snapshot (see {@link Session.runtimeConfig}). */
  get cloudCodeConfig(): CloudCodeConfig | undefined {
    return this.runtimeConfig;
  }

  constructor(public readonly options: SessionOptions) {
    this.runtimeConfig = options.config;
    // Attach the per-session log sink up front so the constructor's
    // fire-and-forget `loadSkills` / `loadMcpServers` failures (and
    // anything else that races) land in the session log, not just global.
    this.logHandle =
      options.id === undefined
        ? undefined
        : getRootLogger().attachSession({
          sessionId: options.id,
          sessionDir: options.homedir,
        });
    this.log =
      this.logHandle?.logger ??
      (options.id === undefined ? log : log.createChild({ sessionId: options.id }));
    this.rpc = wrapSessionRpcForCompactionReappend(options.rpc, () => {
      // Best-effort: a failed re-append must never break the event channel.
      void this.reAppendSessionMetadata().catch((error: unknown) => {
        this.log.warn('session metadata re-append after compaction failed', { error });
      });
    });
    this.experimentalFlags = options.experimentalFlags ?? new FlagResolver();
    this.imageLimits = options.imageLimits ?? new ImageLimits();
    this.hookEngine = new HookEngine(options.hooks, {
      cwd: options.kaos.getcwd(),
      sessionId: options.id,
    });
    this.toolKaos = options.kaos;
    this.persistenceKaos = options.persistenceKaos ?? options.kaos;
    this.additionalDirs = normalizeAdditionalDirs(options.additionalDirs ?? []);
    this.pluginCommands = options.pluginCommands ?? [];
    this.teamStore = new TeamStore(options.homedir, {
      onChange: (teamName) => {
        void this.emitTeamSnapshot(teamName).catch(() => {});
      },
    });
    this.mailbox = new MailboxService(options.homedir, {
      roster: () => this.metadata.agents,
      leader: () => this.getReadyAgent('main'),
      stopAgentTask: (agentId, reason) => this.stopAgentTask(agentId, reason),
      emitActivity: (teamName, message) => {
        void this.rpc.emitEvent({
          type: 'mailbox.activity',
          agentId: 'main',
          message: {
            id: message.id,
            teamName,
            from: message.from,
            to: message.to,
            kind: message.kind,
            preview: mailboxActivityPreview(message),
            createdAt: message.createdAt,
          },
        });
      },
    }, options.mailbox);
    this.pluginSystemPrompts = options.pluginSystemPrompts ?? [];
    this.skills = new SessionSkillRegistry({
      sessionId: options.id,
    });
    this.mcp = new McpConnectionManager({
      oauthService: new McpOAuthService({ cloudCodeHomeDir: options.cloudCodeHomeDir }),
      log: this.log,
      stdioCwd: options.kaos.getcwd(),
      defaultStartupTimeoutMs: resolveMcpStartupTimeoutMs(options.config?.mcp?.startupTimeoutMs),
      defaultToolTimeoutMs: resolveMcpToolTimeoutMs(options.config?.mcp?.toolTimeoutMs),
      // Anti-avalanche needs-auth cache: lives next to the OAuth
      // credential store in the brand home.
      authCache: new McpAuthCache({
        path: join(resolveCloudCodeHome(options.cloudCodeHomeDir), 'mcp-needs-auth-cache.json'),
      }),
    });
    this.mcp.onStatusChange((entry) => {
      this.onMcpServerStatusChange(entry);
    });
    // Host-driven UI-language switches (`/language`): fan the new value out
    // to every ready agent; each latches it and does a one-time system-prompt
    // re-render (see Agent.setUserLanguage). Agents spawned afterwards pick
    // up the current value at construction.
    this.unsubscribeUserLanguage = onUserLanguageChange((language) => {
      for (const agent of this.readyAgents()) {
        agent.setUserLanguage(language).catch((error: unknown) => {
          this.log.warn('system prompt refresh after language change failed', { error });
        });
      }
    });
    this.agentCatalog =
      options.agents?.catalog ??
      new SessionAgentProfileCatalog({
        workDir: options.kaos.getcwd(),
        brandHomeDir: options.cloudCodeHomeDir ?? join(homedir(), '.cloud-code'),
        osHomeDir: options.agents?.userHomeDir ?? homedir(),
        extraDirs: options.agents?.extraDirs ?? options.config?.extraAgentDirs,
        explicitFiles: options.agents?.explicitFiles,
        pluginRoots: options.agents?.pluginRoots,
        warn: (message, error) => {
          this.log.warn(message, error === undefined ? undefined : { error });
        },
      });
    this.skillsReady = this.loadSkills()
      .catch((error: unknown) => {
        this.log.error('skills load failed', error);
      })
      // Agentfile discovery rides the same readiness gate: every createAgent
      // caller already awaits it, so profile binding and the Agent tool's
      // subagent list always see the fully merged catalog. A fatal source
      // (an invalid --agent-file) rejects here and fails session creation.
      .then(() => this.agentCatalog.ready)
      .then(() => {
        this.refreshAgentBuiltinTools();
      });
    this.customAgentsReady = this.loadCustomAgents()
      .catch((error: unknown) => {
        this.log.error('custom agents load failed', error);
      })
      .then(() => {
        this.refreshAgentBuiltinTools();
      });
    this.outputStylesReady = this.loadOutputStyles().catch((error: unknown) => {
      this.log.error('output styles load failed', error);
    });
    void this.loadMcpServers().catch((error: unknown) => {
      this.emitInitialMcpLoadError(error);
    });
  }


  setToolKaos(kaos: Kaos) {
    this.toolKaos = kaos;
    for (const agent of this.readyAgents()) {
      agent.setKaos(kaos.withCwd(agent.config.cwd));
    }
    this.refreshAgentBuiltinTools();
  }

  getAdditionalDirs(): readonly string[] {
    return this.additionalDirs;
  }

  async setAdditionalDirs(additionalDirs: readonly string[]): Promise<void> {
    this.additionalDirs = normalizeAdditionalDirs(additionalDirs);
    for (const agent of this.readyAgents()) {
      agent.setAdditionalDirs(this.additionalDirs);
    }
  }

  async setBaseAdditionalDirs(additionalDirs: readonly string[]): Promise<void> {
    await this.setAdditionalDirs([...additionalDirs, ...this.sessionAdditionalDirs]);
  }

  async addAdditionalDir(
    path: string,
    persist = true,
  ): Promise<WorkspaceAdditionalDirsLoadResult & { readonly persisted: boolean }> {
    const cwd = this.toolKaos.getcwd();
    const systemKaos = this.systemContextKaos(cwd);
    if (persist) {
      const result = await appendWorkspaceAdditionalDir(systemKaos, cwd, path, this.additionalDirs);
      const additionalDirs = normalizeAdditionalDirs([...this.additionalDirs, ...result.additionalDirs]);
      await this.setAdditionalDirs(additionalDirs);
      this.notifyAdditionalDirAdded(path, true, result.configPath);
      return { ...result, additionalDirs, persisted: true };
    }

    const workspace = await readWorkspaceAdditionalDirs(systemKaos, cwd);
    const additionalDirs = await resolveWorkspaceAdditionalDirs(systemKaos, cwd, [path]);
    const nextAdditionalDirs = normalizeAdditionalDirs([...this.additionalDirs, ...additionalDirs]);
    const nextSessionAdditionalDirs = normalizeAdditionalDirs([
      ...this.sessionAdditionalDirs,
      ...additionalDirs,
    ]);
    const previousMetadata = this.metadata;
    this.metadata = {
      ...this.metadata,
      additionalDirs: nextSessionAdditionalDirs,
    };
    try {
      await this.writeMetadata();
    } catch (error) {
      this.metadata = previousMetadata;
      throw error;
    }
    this.sessionAdditionalDirs = nextSessionAdditionalDirs;
    await this.setAdditionalDirs(nextAdditionalDirs);
    this.notifyAdditionalDirAdded(path, false, workspace.configPath);
    return {
      projectRoot: workspace.projectRoot,
      configPath: workspace.configPath,
      additionalDirs: nextAdditionalDirs,
      persisted: false,
    };
  }

  private notifyAdditionalDirAdded(path: string, persisted: boolean, configPath: string): void {
    const message = persisted
      ? `Added workspace directory:\n  ${path}\n  Saved to:\n  ${configPath}`
      : `Added workspace directory:\n  ${path}\n  For this session only`;
    this.requireMainAgent().context.appendLocalCommandStdout(message);
  }

  /**
   * Kaos used by session-internal bootstrap (AGENTS.md context, cwd listing)
   * and metadata persistence. Always backed by the persistence sink (typically
   * the local filesystem) so a transient ACP-side failure on system files like
   * `AGENTS.md` never blocks `bootstrapAgentProfile` — tool calls still route
   * through `agent.kaos` and continue to honor the ACP bridge.
   */
  systemContextKaos(cwd: string): Kaos {
    return this.persistenceKaos.withCwd(cwd);
  }

  async createMain() {
    // Await the catalog (chained into skillsReady) before resolving the
    // profile so a fatal agentfile source surfaces here, and so `--agent`
    // sees file-defined profiles.
    await this.skillsReady;
    this.agentProfileSnapshot = this.agentCatalog.snapshot();
    const profile = resolveMainAgentProfile(
      this.agentCatalog,
      this.options.agents?.profileName,
    );
    const { agent } = await this.createAgent({ type: 'main' }, {
      profile,
    });
    if (this.options.drainAgentTasksOnStop) {
      agent.printDrainAgentTasksOnStop = true;
    }
    for (const warning of this.computeSecondaryModelWarnings()) {
      agent.emitEvent({
        type: 'warning',
        message: warning.message,
        code: warning.code,
      });
    }
    await this.triggerSessionStart('startup');
    return agent;
  }

  async resume(): Promise<{ warning?: string }> {
    await this.skillsReady;
    this.log.info('session resume', { app_version: this.options.appVersion });
    const { agents, additionalDirs = [] } = await this.readMetadata();
    const cwd = this.toolKaos.getcwd();
    this.sessionAdditionalDirs = await resolveWorkspaceAdditionalDirs(
      this.systemContextKaos(cwd),
      cwd,
      additionalDirs,
    );
    await this.setBaseAdditionalDirs(this.additionalDirs);
    this.agents.clear();
    // Only the main agent is needed to reopen the session; subagents replay
    // lazily when an RPC or Agent(resume=...) call asks for their state.
    const { warning } =
      agents['main'] === undefined ? { warning: undefined } : await this.resumeAgent('main');
    // A session migrated from an external tool ships a wire without the
    // `config.update` bootstrap events a natively-created agent writes, so the
    // main agent comes back with an empty system prompt and no tools. Apply the
    // default profile so the resumed session is usable. Native sessions always
    // replay a non-empty system prompt and never enter this branch.
    const main = this.getReadyAgent('main');
    const profile = this.agentCatalog.getDefault();
    if (main !== undefined && main.config.systemPrompt === '') {
      await this.bootstrapAgentProfile(main, profile);
    }
    await this.triggerSessionStart('resume');
    return { warning };
  }

  async assertMainProfileSelection(requestedProfileName: string | undefined): Promise<void> {
    if (requestedProfileName === undefined) return;
    const main = await this.ensureAgentResumed('main');
    const currentProfileName = main.config.profileName ?? DEFAULT_AGENT_PROFILE_NAME;
    if (currentProfileName === requestedProfileName) return;
    throw new CloudCodeError(
      ErrorCodes.REQUEST_INVALID,
      `agent is already bound to profile "${currentProfileName}"; cannot switch to "${requestedProfileName}" in this session`,
    );
  }

  async close(): Promise<void> {
    this.unsubscribeUserLanguage();
    try {
      await this.mailbox.close();
      await Promise.allSettled(
        Array.from(this.readyAgents(), async (agent) => {
          // Drop any parked rate-limit auto-resume: a paused session
          // being torn down must not come back to life after close.
          agent.turn.cancelRateLimitResume();
          await agent.cron?.stop();
        }),
      );
      await this.cancelActiveTurnsOnClose();
      await this.stopBackgroundTasksOnExit();
      await this.flushMetadata();
      await this.triggerSessionEnd('exit');
    } finally {
      try {
        await this.mcp.shutdown();
      } finally {
        await this.logHandle?.close();
      }
    }
  }

  async closeForReload(): Promise<void> {
    this.unsubscribeUserLanguage();
    try {
      await this.mailbox.close();
      await Promise.allSettled(
        Array.from(this.readyAgents(), async (agent) => {
          agent.turn.cancelRateLimitResume();
          await agent.cron?.stop();
        }),
      );
      await this.flushMetadata();
    } finally {
      try {
        await this.mcp.shutdown();
      } finally {
        await this.logHandle?.close();
      }
    }
  }

  private async cancelActiveTurnsOnClose(): Promise<void> {
    const backgroundAgentIds = this.activeBackgroundAgentIds();
    const cancellations: Array<Promise<void>> = [];
    for (const [agentId, entry] of this.agents) {
      if (!(entry instanceof Agent) || backgroundAgentIds.has(agentId)) continue;
      cancellations.push(this.cancelAgentTurnOnClose(entry));
    }
    await Promise.allSettled(cancellations);
  }

  private activeBackgroundAgentIds(): Set<string> {
    const agentIds = new Set<string>();
    for (const agent of this.readyAgents()) {
      for (const task of agent.background.list(true)) {
        if (task.kind === 'agent' && task.agentId !== undefined && task.detached !== false) {
          agentIds.add(task.agentId);
        }
      }
    }
    return agentIds;
  }

  private async cancelAgentTurnOnClose(agent: Agent): Promise<void> {
    if (!agent.turn.hasActiveTurn) return;

    let waitForTurn: Promise<unknown>;
    try {
      waitForTurn = agent.turn.waitForCurrentTurn();
    } catch (error: unknown) {
      this.log.debug('active turn wait unavailable during session close', {
        agentType: agent.type,
        agentHomedir: agent.homedir,
        error,
      });
      return;
    }

    agent.turn.cancel(undefined, abortError('Session closed'));
    const settled = await waitForSettlementOrTimeout(waitForTurn, ACTIVE_TURN_CLOSE_TIMEOUT_MS);
    if (!settled) {
      this.log.warn('timed out waiting for active turn to cancel during session close', {
        agentType: agent.type,
        agentHomedir: agent.homedir,
        timeoutMs: ACTIVE_TURN_CLOSE_TIMEOUT_MS,
      });
    }
  }

  private async stopBackgroundTasksOnExit(): Promise<void> {
    const keepAliveOnExit = resolveConfigValue({
      env: process.env,
      envKey: BACKGROUND_KEEP_ALIVE_ON_EXIT_ENV,
      configValue: this.options.background?.keepAliveOnExit,
      defaultValue: false,
      parseEnv: parseBooleanEnv,
    });
    if (keepAliveOnExit) return;
    await Promise.all(
      Array.from(this.readyAgents(), async (agent) => {
        const activeTasks = agent.background.list(true);
        await Promise.all(
          activeTasks.map((task) =>
            agent.background.suppressTerminalNotification(task.taskId),
          ),
        );
        await agent.background.stopAll('Session closed');
      }),
    );
  }

  /**
   * Wait for all still-running background tasks (across every agent) to reach a
   * terminal state before a `cloud-code -p` (print) run exits.
   *
   * Only runs when the resolved print background mode is `'drain'` (see
   * `resolvePrintBackgroundMode`): `print_background_mode = "drain"`, or the
   * legacy `keep_alive_on_exit = true` fallback. In every other mode it returns
   * immediately. The wait is bounded by `background.print_wait_ceiling_s`
   * (default `PRINT_WAIT_CEILING_S_DEFAULT`, effectively unbounded) so a wedged
   * task can still be given up on eventually.
   *
   * Terminal notifications are suppressed for each task while we wait, so a task
   * completing cannot `turn.steer` the (already finished) main agent into launching
   * a new turn. (This is exactly what `'steer'` mode avoids by never calling here.)
   */
  async waitForBackgroundTasksOnPrint(): Promise<void> {
    if (this.resolvePrintBackgroundMode() !== 'drain') return;

    const ceilingS = this.options.background?.printWaitCeilingS ?? PRINT_WAIT_CEILING_S_DEFAULT;
    const timeoutMs = ceilingS * 1000;
    const deadline = Date.now() + timeoutMs;

    // Re-enumerate active background tasks across every agent until none remain
    // (or the ceiling expires). A subagent may fan out new background tasks
    // after a previous enumeration, so a single pass could return while those
    // later tasks are still running — breaking the "every background task"
    // guarantee. Each round waits for the newly discovered tasks, then rescans
    // to catch anything spawned in the meantime.
    const seen = new Set<string>();
    const allWaiters: Promise<unknown>[] = [];
    while (Date.now() < deadline) {
      const batch: Promise<unknown>[] = [];
      const suppressions: Promise<void>[] = [];
      let activeCount = 0;
      for (const agent of this.readyAgents()) {
        for (const task of agent.background.list(true)) {
          activeCount++;
          if (seen.has(task.taskId)) continue;
          seen.add(task.taskId);
          // suppressTerminalNotification sets the suppressed flag synchronously
          // when called; defer awaiting the persist until after the whole
          // enumeration so no task can complete and fire a notification while
          // another task's persist write is pending.
          suppressions.push(agent.background.suppressTerminalNotification(task.taskId));
          const remaining = Math.max(1, deadline - Date.now());
          const waiter = agent.background.wait(task.taskId, remaining);
          batch.push(waiter);
          allWaiters.push(waiter);
        }
      }
      if (suppressions.length > 0) {
        await Promise.all(suppressions);
      }
      if (activeCount === 0 || batch.length === 0) break;
      this.log.info('waiting for background tasks before print exit', {
        active: activeCount,
        new: batch.length,
        timeoutMs,
      });
      await Promise.all(batch);
    }
    if (allWaiters.length > 0) {
      await Promise.all(allWaiters);
      this.log.info('background tasks settled before print exit', {
        count: seen.size,
        timeoutMs,
      });
    }
  }

  /**
   * Resolve the effective print-mode (`cloud-code -p`) background-task policy.
   *
   * `background.print_background_mode` is authoritative when set. Otherwise we
   * fall back to the legacy `background.keep_alive_on_exit` mapping so existing
   * configs keep their behavior: `keep_alive_on_exit = true` ⇒ `'drain'`
   * (suppress + drain background tasks before exit). When neither is set the
   * mode defaults to `'steer'`: a headless run stays alive while background
   * tasks are pending so their completions can steer new main turns.
   */
  private resolvePrintBackgroundMode(): 'exit' | 'drain' | 'steer' {
    const configured = this.options.background?.printBackgroundMode;
    if (configured !== undefined) return configured;
    const keepAliveOnExit = resolveConfigValue({
      env: process.env,
      envKey: BACKGROUND_KEEP_ALIVE_ON_EXIT_ENV,
      configValue: this.options.background?.keepAliveOnExit,
      defaultValue: false,
      parseEnv: parseBooleanEnv,
    });
    return keepAliveOnExit ? 'drain' : 'steer';
  }

  private countActiveBackgroundTasks(): number {
    let count = 0;
    for (const agent of this.readyAgents()) {
      count += agent.background.list(true).length;
    }
    return count;
  }

  /**
   * Decide what the `cloud-code -p` driver should do after the main agent's turn ends
   * with `reason === 'completed'`. Returns `'finish'` when the run may exit, or
   * `'continue'` when the driver must stay alive so a background-task completion
   * can `turn.steer` the main agent into a new turn.
   *
   *  - 'exit'  : finish immediately.
   *  - 'drain' : suppress + drain background tasks, then finish (legacy
   *              `keep_alive_on_exit = true` behavior).
   *  - 'steer' : while background tasks are still pending, return 'continue' so
   *              completions steer new main turns; finish once quiescent, or when
   *              the wall-clock ceiling (`print_wait_ceiling_s`) or the turn cap
   *              (`print_max_turns`) is reached. This is the default mode.
   */
  async handlePrintMainTurnCompleted(): Promise<'finish' | 'continue'> {
    const mode = this.resolvePrintBackgroundMode();
    if (mode === 'exit') return 'finish';
    if (mode === 'drain') {
      await this.waitForBackgroundTasksOnPrint();
      return 'finish';
    }

    // 'steer'
    const ceilingS = this.options.background?.printWaitCeilingS ?? PRINT_WAIT_CEILING_S_DEFAULT;
    const maxTurns = this.options.background?.printMaxTurns ?? PRINT_MAX_TURNS_DEFAULT;
    const now = Date.now();
    this.printSteerDeadline ??= now + ceilingS * 1000;
    this.printSteerTurns += 1;
    if (now >= this.printSteerDeadline) {
      this.log.warn('print steer ceiling reached, finishing', { ceilingS });
      return 'finish';
    }
    if (this.printSteerTurns > maxTurns) {
      this.log.warn('print steer max turns reached, finishing', { maxTurns });
      return 'finish';
    }
    if (this.countActiveBackgroundTasks() > 0) {
      return 'continue';
    }
    return 'finish';
  }

  async createAgent(
    config: Partial<AgentOptions>,
    options: CreateAgentOptions = {},
  ): Promise<{ readonly id: string; readonly agent: Agent }> {
    await this.skillsReady;
    const type = config.type ?? 'main';
    const id = type === 'main' ? 'main' : this.nextGeneratedAgentId();
    const homedir = config.homedir ?? join(this.options.homedir, 'agents', id);
    const parentAgentId = options.parentAgentId ?? null;
    const agent = this.instantiateAgent(id, homedir, type, config, parentAgentId);
    if (options.profile) {
      await this.bootstrapAgentProfile(agent, options.profile);
    }

    this.agents.set(id, agent);
    if (options.persistMetadata !== false) {
      this.metadata.agents[id] = {
        homedir,
        type,
        parentAgentId,
        swarmItem: options.swarmItem,
        teammate: options.teammate,
      };
      void this.writeMetadata();
    }

    return { id, agent };
  }

  async ensureAgentResumed(id: string): Promise<Agent> {
    const entry = this.agents.get(id);
    if (entry !== undefined) return (await this.resolveAgentEntry(entry)).agent;
    if (this.metadata.agents[id] === undefined) {
      throw new CloudCodeError(ErrorCodes.AGENT_NOT_FOUND, `Agent "${id}" was not found`);
    }
    return (await this.resumeAgent(id)).agent;
  }

  /**
   * Applies a profile's derived config — cwd, system prompt, active tools — to
   * an agent. Fresh creation and resume-of-an-incomplete-wire both route
   * through here so the two paths cannot drift apart.
   */
  private async bootstrapAgentProfile(
    agent: Agent,
    profile: ResolvedAgentProfile,
  ): Promise<void> {
    // Styles load asynchronously at session start; the first render must see
    // them or a configured style would silently render as the stock prompt.
    await this.outputStylesReady;
    const context = await prepareSystemPromptContext(
      this.systemContextKaos(agent.kaos.getcwd()),
      this.options.cloudCodeHomeDir,
      { additionalDirs: this.additionalDirs, includeGitStatus: true },
    );
    const subagentNames = Object.keys(this.agentCatalog.delegatableSubagents(profile.name));
    agent.useProfile(profile, context, this.options.cloudCodeHomeDir, subagentNames);
    const { agentsMdWarning } = context;
    if (agentsMdWarning !== undefined) {
      this.agentsMdWarning = agentsMdWarning;
      log.warn('AGENTS.md exceeds recommended size', { message: agentsMdWarning });
      agent.emitEvent({
        type: 'warning',
        message: agentsMdWarning,
        code: 'agents-md-oversized',
      });
    }
  }

  async getSessionWarnings(): Promise<readonly SessionWarning[]> {
    const warnings: SessionWarning[] = [];
    const agentsMdWarning = await this.computeAgentsMdWarning();
    if (agentsMdWarning !== undefined) {
      warnings.push({
        code: 'agents-md-oversized',
        message: agentsMdWarning,
        severity: 'warning',
      });
    }
    warnings.push(...this.computeSecondaryModelWarnings());
    return warnings;
  }

  /**
   * Live-apply the core's fully resolved secondary-model config after a
   * `[secondary_model]` change: the spawn
   * binding (`subagent-host`), the startup-warning computation, and every live
   * agent's `cloudCodeConfig` (tool descriptions, loop control) all read the
   * session snapshot, so a mid-session `/secondary_model` switch takes effect
   * for the next subagent spawn without recreating the session. The core owns
   * config reload, environment overlays, and derived-model synthesis. Copying
   * that complete recipe and its model entries keeps spawn binding and provider
   * resolution aligned without live-applying unrelated session settings.
   */
  setSecondaryModelConfig(config: CloudCodeConfig): void {
    const base = this.runtimeConfig;
    if (base === undefined) {
      throw new CloudCodeError(
        ErrorCodes.CONFIG_INVALID,
        'Cannot set the secondary model: the session has no config.',
      );
    }
    const secondary = config.secondaryModel;
    if (secondary?.model === undefined) {
      throw new CloudCodeError(
        ErrorCodes.CONFIG_INVALID,
        'Cannot set the secondary model: persist its recipe before applying it to a session.',
      );
    }
    try {
      this.options.providerManager?.resolveProviderConfig(secondary.model);
    } catch (error) {
      throw wrapSubagentModelError(error, secondary.model, undefined);
    }
    const models = { ...base.models };
    delete models[SECONDARY_DERIVED_MODEL_ALIAS];
    const pointedModel = config.models?.[secondary.model];
    if (pointedModel !== undefined) models[secondary.model] = pointedModel;
    const derivedModel = config.models?.[SECONDARY_DERIVED_MODEL_ALIAS];
    if (derivedModel !== undefined) models[SECONDARY_DERIVED_MODEL_ALIAS] = derivedModel;
    this.applyRuntimeConfig({ ...base, models, secondaryModel: secondary });
  }

  /**
   * Live-apply a core-side config write: the session snapshot and every live
   * agent follow the persisted file without recreating the session. A
   * session-scoped `outputStyle` overlay survives — the host may never persist
   * it (see {@link setOutputStyle}), so a global push must not silently drop it.
   */
  applyRuntimeConfig(config: CloudCodeConfig): void {
    const sessionStyle = config.outputStyle === undefined ? this.runtimeConfig?.outputStyle : undefined;
    const next = sessionStyle === undefined ? config : { ...config, outputStyle: sessionStyle };
    this.runtimeConfig = next;
    this.secondaryModelWarnings = undefined;
    for (const [, entry] of this.agents) {
      if (entry instanceof Agent) {
        entry.updateCloudCodeConfig(next);
      } else {
        // Resume in flight: push the update once the agent materializes (the
        // rejection is owned by the resume caller, not by this tap).
        void entry.then(({ agent }) => agent.updateCloudCodeConfig(next)).catch(() => {});
      }
    }
  }

  private secondaryModelWarnings: SessionWarning[] | undefined;

  /**
   * Upfront validation of the `[secondary_model]` recipe, mirroring the v2
   * warning service: the pointer is otherwise only validated lazily at spawn
   * time, where a typo becomes a mid-conversation tool failure dumped on the
   * parent model. Advisory only — spawn-time resolution (with the wrapped
   * error) remains the backstop. Computed once per session.
   */
  private computeSecondaryModelWarnings(): SessionWarning[] {
    if (this.secondaryModelWarnings !== undefined) return [...this.secondaryModelWarnings];
    const warnings: SessionWarning[] = [];
    const secondary = resolveSecondaryModelRecipe(this.cloudCodeConfig);
    if (secondary?.model !== undefined) {
      const boundAlias =
        secondaryModelPatch(secondary) === undefined
          ? secondary.model
          : SECONDARY_DERIVED_MODEL_ALIAS;
      try {
        const resolved = this.options.providerManager?.resolveProviderConfig(boundAlias);
        const supported = resolved?.supportEfforts ?? [];
        if (
          secondary.defaultEffort !== undefined &&
          supported.length > 0 &&
          !supported.includes(secondary.defaultEffort)
        ) {
          warnings.push({
            code: 'secondary-model-effort-not-listed',
            message:
              `Secondary model default_effort "${secondary.defaultEffort}" is not in the resolved model's ` +
              `support_efforts (${supported.join(', ')}). Subagents will resolve thinking without it.`,
            severity: 'warning',
          });
        }
      } catch (error) {
        const wrapped = wrapSubagentModelError(error, boundAlias, undefined);
        warnings.push({
          code: 'secondary-model-invalid',
          message: `${wrapped instanceof Error ? wrapped.message : String(wrapped)} Subagent spawns will fail until this is fixed.`,
          severity: 'warning',
        });
      }
    }
    this.secondaryModelWarnings = warnings;
    return [...warnings];
  }

  private async computeAgentsMdWarning(): Promise<string | undefined> {
    if (this.agentsMdWarning !== undefined) {
      return this.agentsMdWarning;
    }
    // Resumed sessions skip bootstrap when their system prompt is already set, so
    // the cached value may be missing; recompute on demand so the warning still
    // surfaces for long-lived sessions.
    try {
      const context = await prepareSystemPromptContext(
        this.systemContextKaos(this.toolKaos.getcwd()),
        this.options.cloudCodeHomeDir,
        { additionalDirs: this.additionalDirs },
      );
      this.agentsMdWarning = context.agentsMdWarning;
    } catch (error) {
      log.warn('failed to compute AGENTS.md warning', { error });
    }
    return this.agentsMdWarning;
  }

  async generateAgentsMd(): Promise<void> {
    await this.skillsReady;
    const mainAgent = this.requireMainAgent();

    try {
      const handle = await mainAgent.subagentHost!.spawn({
        profileName: 'coder',
        parentToolCallId: 'generate-agents-md',
        prompt: DEFAULT_INIT_PROMPT,
        description: 'Initialize AGENTS.md',
        runInBackground: false,
        signal: new AbortController().signal,
      });
      await handle.completion;

      const agentsMd = await loadAgentsMd(mainAgent.kaos, this.options.cloudCodeHomeDir);
      mainAgent.context.appendSystemReminder(initCompletionReminder(agentsMd), {
        kind: 'injection',
        variant: 'init',
      });
      await mainAgent.records.flush();
    } catch (error) {
      throw new CloudCodeError(
        ErrorCodes.SESSION_INIT_FAILED,
        error instanceof Error ? error.message : 'Init failed',
        { cause: error },
      );
    }
  }

  /**
   * Appends a fresh `<plugin_session_start>` system reminder to the main agent
   * using the currently enabled plugins, then flushes records so the reminder is
   * persisted and visible on the wire. Used by the explicit `/reload` flow after
   * the session has been re-resumed with reloaded plugin state.
   *
   * When no plugin session start is currently resolvable but the context may still
   * carry stale plugin guidance — either an earlier `<plugin_session_start>`
   * reminder, or a compaction summary that may have folded one in — appends a
   * neutralizing reminder instead, so the model does not keep following stale
   * plugin instructions and the turn-loop injector does not dedup against them.
   */
  async appendPluginSessionStartReminder(): Promise<void> {
    await this.skillsReady;
    const mainAgent = this.requireMainAgent();
    const reminder = renderPluginSessionStartReminder({
      sessionStarts: mainAgent.pluginSessionStarts,
      registry: mainAgent.skills?.registry,
      log: mainAgent.log,
    });
    if (reminder !== undefined) {
      mainAgent.context.appendSystemReminder(
        `${reminder}\n\nThis supersedes any earlier plugin_session_start reminder in this session.`,
        { kind: 'injection', variant: 'plugin_session_start' },
      );
    } else if (this.shouldNeutralizePluginSessionStart(mainAgent)) {
      mainAgent.context.appendSystemReminder(
        'There are currently no active plugin session starts. This supersedes any earlier plugin_session_start reminder in this session.',
        { kind: 'injection', variant: 'plugin_session_start' },
      );
    } else {
      return;
    }
    await mainAgent.records.flush();
  }

  private shouldNeutralizePluginSessionStart(mainAgent: Agent): boolean {
    return mainAgent.context.history.some((message) => {
      const kind = message.origin?.kind;
      if (kind === 'injection') {
        return message.origin?.variant === 'plugin_session_start';
      }
      // A compaction summary replaces earlier messages (including any plugin
      // session-start reminder) with a single summary that may still carry stale
      // plugin guidance, so the origin-only check above is not sufficient.
      return kind === 'compaction_summary';
    });
  }

  get hasActiveTurn(): boolean {
    for (const agent of this.readyAgents()) {
      if (agent.turn.hasActiveTurn) return true;
    }
    return false;
  }

  protected get metadataPath() {
    return join(this.options.homedir, 'state.json');
  }

  writeMetadata() {
    const text = JSON.stringify(
      {
        ...this.metadata,
        agentProfileCatalog: this.agentProfileSnapshot,
      },
      null,
      2,
    );
    const write = async () => {
      await this.persistenceKaos.mkdir(this.options.homedir, { parents: true, existOk: true });
      await this.persistenceKaos.writeText(this.metadataPath, text);
    };
    this.writeMetadataPromise = this.writeMetadataPromise.then(write, write);
    return this.writeMetadataPromise;
  }

  async readMetadata() {
    const text = await this.persistenceKaos.readText(this.metadataPath);
    const persisted = JSON.parse(text) as PersistedSessionState;
    const { agentProfileCatalog, ...metadata } = persisted;
    this.metadata = metadata;
    if (agentProfileCatalog === undefined) {
      if (this.options.agents?.refreshPluginAgents === true) {
        this.agentProfileSnapshot = this.agentCatalog.snapshot();
      }
    } else {
      const parsed = AgentProfileCatalogSnapshotSchema.safeParse(agentProfileCatalog);
      if (parsed.success) {
        if (this.options.agents?.refreshPluginAgents === true) {
          await this.agentCatalog.restoreSnapshotRefreshingPlugins(
            parsed.data,
            this.options.agents.pluginRoots ?? [],
          );
        } else {
          this.agentCatalog.restoreSnapshot(parsed.data);
        }
        this.agentProfileSnapshot = this.agentCatalog.snapshot();
      } else {
        this.log.warn('stored agent profile catalog is invalid; using discovered profiles', {
          error: parsed.error.message,
        });
        if (this.options.agents?.refreshPluginAgents === true) {
          this.agentProfileSnapshot = this.agentCatalog.snapshot();
        }
      }
    }
    return this.metadata;
  }

  async flushMetadata() {
    await this.skillsReady;
    await this.writeMetadataPromise;
    // Close-time metadata tail re-append: land the final title/lastPrompt
    // at the wire EOF so the lite reader's tail window always carries them,
    // then flush the wire writes behind it.
    await this.reAppendSessionMetadata();
    await Promise.all(Array.from(this.readyAgents()).map((agent) => agent.records.flush()));
  }

  /**
   * Best-effort merge of externally-mutated listing metadata (04i "absorb from
   * the tail before re-appending", adapted: our metadata source of truth is
   * `state.json`, not the wire tail). Another process holding this session (a
   * second TUI, an SDK embedder) may have renamed it or moved lastPrompt since
   * this process last wrote `state.json`; when the on-disk `updatedAt` is
   * newer, the disk's listing fields are adopted so a later whole-file write
   * from our stale cache does not clobber them. Runtime-owned fields (agents,
   * custom, additionalDirs) always stay with the in-memory value.
   *
   * Fail-open: an unreadable or malformed `state.json` leaves the in-memory
   * cache authoritative. Best-effort only — there is no cross-process lock, so
   * this narrows but cannot eliminate the read-modify-write race window.
   */
  async absorbExternalMetadata(): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await this.persistenceKaos.readText(this.metadataPath));
    } catch {
      return;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return;
    const disk = parsed as Record<string, unknown>;
    const diskUpdatedAt =
      typeof disk['updatedAt'] === 'string' ? Date.parse(disk['updatedAt']) : Number.NaN;
    const memoryUpdatedAt = Date.parse(this.metadata.updatedAt);
    // The disk must not be older than the cache: an older timestamp means the
    // read raced this process's own queued write, so the cache is fresher.
    if (!Number.isFinite(diskUpdatedAt) || diskUpdatedAt < memoryUpdatedAt) return;
    const diskTitle = typeof disk['title'] === 'string' ? disk['title'] : undefined;
    const diskIsCustomTitle =
      typeof disk['isCustomTitle'] === 'boolean' ? disk['isCustomTitle'] : undefined;
    const diskLastPrompt = typeof disk['lastPrompt'] === 'string' ? disk['lastPrompt'] : undefined;
    const diskCustomTitle = typeof disk['customTitle'] === 'string' ? disk['customTitle'] : undefined;
    // Absorb only when the listing fields actually moved. The timestamp check
    // alone is not sufficient: the static SessionStore rename path (a second
    // process with the session closed there but open here) does not bump
    // updatedAt, so a field-level diff is the only reliable external-writer
    // signal that covers every writer.
    const moved =
      (diskTitle !== undefined && diskTitle !== this.metadata.title) ||
      (diskIsCustomTitle !== undefined && diskIsCustomTitle !== this.metadata.isCustomTitle) ||
      (diskLastPrompt !== undefined && diskLastPrompt !== this.metadata.lastPrompt) ||
      (diskCustomTitle !== undefined &&
        diskCustomTitle !==
          (this.metadata as SessionMeta & { customTitle?: string }).customTitle);
    if (!moved) return;
    this.metadata = {
      ...this.metadata,
      title: diskTitle ?? this.metadata.title,
      isCustomTitle: diskIsCustomTitle ?? this.metadata.isCustomTitle,
      lastPrompt: diskLastPrompt ?? this.metadata.lastPrompt,
      // Legacy `customTitle` field (hasCustomTitle compat): carried along when
      // an external writer sets it.
      ...(diskCustomTitle === undefined ? {} : { customTitle: diskCustomTitle }),
    } as SessionMeta;
  }

  /**
   * Re-append the cached session listing metadata to the tail of the main
   * agent's wire log as a `session.meta` record (04i metadata tail re-append).
   * Keeps the wire tail window self-describing for the lite reader
   * (`session/store/wire-lite.ts`) and lets title/lastPrompt travel with
   * wire-only exports and migrations. External changes are absorbed first
   * (see {@link absorbExternalMetadata}) so a stale in-memory cache never
   * overwrites a fresher title.
   *
   * Trigger points (mirroring Claude's compaction + exit pair): live
   * `compaction.completed` events (see `wrapSessionRpcForCompactionReappend`),
   * rename-style RPC flows, and close via {@link flushMetadata} (the
   * catch-all). No-op when the main agent is not materialized in this process
   * (e.g. the first prompt has not created it yet). The write rides the
   * normal records batch flush; callers do not flush explicitly except on
   * close.
   */
  async reAppendSessionMetadata(): Promise<void> {
    const main = this.getReadyAgent('main');
    if (main === undefined) return;
    await this.absorbExternalMetadata();
    const { title, isCustomTitle, lastPrompt } = this.metadata;
    if (title === undefined && lastPrompt === undefined) return;
    main.records.logRecord({
      type: 'session.meta',
      ...(title === undefined ? {} : { title }),
      ...(isCustomTitle ? { isCustomTitle: true } : {}),
      ...(lastPrompt === undefined ? {} : { lastPrompt }),
    });
  }

  async listSkills(): Promise<readonly SkillSummary[]> {
    await this.skillsReady;
    return this.skills.listSkills().map(summarizeSkill);
  }

  listPluginCommands(): readonly PluginCommandDef[] {
    return this.pluginCommands;
  }

  /**
   * Every output style visible to this session: the bundled styles plus
   * user/project/plugin dirs (`profile/output-style.ts` precedence).
   */
  async listOutputStyles(): Promise<readonly OutputStyleSummary[]> {
    await this.outputStylesReady;
    return this.outputStyles.map(summarizeOutputStyle);
  }

  /**
   * Live-switch the session's output style: every ready agent latches the new
   * name and does a one-time system-prompt re-render (see
   * `Agent.setOutputStyle`). The session's config snapshot moves with the
   * switch so agents spawned afterwards seed the same style (they read
   * `outputStyle` at construction); persistence to the config file stays with
   * the host, like model selection. `default` (or an unknown name rejected
   * below) restores the stock prompt.
   */
  async setOutputStyle(name: string): Promise<void> {
    await this.outputStylesReady;
    const normalized = normalizeOutputStyleName(name);
    if (normalized !== undefined && resolveOutputStyle(this.outputStyles, normalized) === undefined) {
      throw new CloudCodeError(
        ErrorCodes.SESSION_OUTPUT_STYLE_NOT_FOUND,
        `Unknown output style: "${name}"`,
      );
    }
    if (normalized === undefined) {
      if (this.runtimeConfig?.outputStyle !== undefined) {
        const next = { ...this.runtimeConfig };
        delete next.outputStyle;
        this.runtimeConfig = next;
      }
    } else if (this.runtimeConfig?.outputStyle !== normalized) {
      this.runtimeConfig = { ...(this.runtimeConfig ?? { providers: {} }), outputStyle: normalized };
    }
    await Promise.all(
      [...this.readyAgents()].map((agent) => agent.setOutputStyle(normalized)),
    );
  }

  private async loadOutputStyles(): Promise<void> {
    this.outputStyles = await loadOutputStyles({
      // The brand home already follows CLOUD_CODE_HOME (see resolveCloudCodeHome).
      // Without it there is no user-level location to scan.
      userDir:
        this.options.cloudCodeHomeDir === undefined
          ? undefined
          : join(this.options.cloudCodeHomeDir, 'output-styles'),
      projectDir: join(this.toolKaos.getcwd(), '.cloud-code', 'output-styles'),
      pluginDirs: this.options.pluginOutputStyleDirs,
      onWarning: (message) => this.log.warn(message),
    });
  }

  /**
   * Agent profiles available to this session: the bundled defaults plus any
   * file-based custom agents (`.cloud-code/agents/*.md`). Starts as the
   * defaults and is replaced once custom agents finish loading.
   */
  getAgentProfiles(): Record<string, ResolvedAgentProfile> {
    return this.agentProfiles;
  }

  /** Resolves once file-based custom agents have been loaded and merged. */
  async waitForCustomAgents(): Promise<void> {
    await this.customAgentsReady;
  }

  private async loadCustomAgents(): Promise<void> {
    const customProfiles = await loadCustomAgentProfiles({
      // The brand home already follows CLOUD_CODE_HOME (see resolveCloudCodeHome).
      // Without it there is no user-level location to scan.
      userDir:
        this.options.cloudCodeHomeDir === undefined
          ? undefined
          : join(this.options.cloudCodeHomeDir, 'agents'),
      projectDir: join(this.toolKaos.getcwd(), '.cloud-code', 'agents'),
      pluginDirs: this.options.pluginAgentDirs,
      reservedNames: new Set(Object.keys(DEFAULT_AGENT_PROFILES)),
      log: this.log,
    });
    if (customProfiles.length === 0) return;
    this.agentProfiles = resolveDefaultAgentProfiles(customProfiles);
  }

  private async loadSkills(): Promise<void> {
    const roots = await resolveSkillRoots({
      paths: {
        userHomeDir: this.options.skills?.userHomeDir ?? homedir(),
        brandHomeDir: this.options.skills?.brandHomeDir ?? this.options.cloudCodeHomeDir,
        workDir: this.options.kaos.getcwd(),
      },
      explicitDirs: this.options.skills?.explicitDirs,
      extraDirs: this.options.skills?.extraDirs,
      pluginSkillRoots: this.options.skills?.pluginSkillRoots,
      mergeAllAvailableSkills: this.options.skills?.mergeAllAvailableSkills,
      builtinDir: this.options.skills?.builtinDir,
    });
    await this.skills.loadRoots(roots);
    registerBuiltinSkills(this.skills);
  }

  private async loadMcpServers(): Promise<void> {
    const servers = this.options.mcpConfig?.servers;
    if (servers === undefined || Object.keys(servers).length === 0) return;
    this.mcpInitialLoadPending = true;
    try {
      await this.mcp.connectAll(servers);
    } finally {
      // Settled: run the instructions check once, aggregating every change
      // that arrived during startup into at most one prompt refresh.
      this.mcpInitialLoadPending = false;
      this.refreshAgentsOnMcpInstructionsChange();
    }
  }

  private emitInitialMcpLoadError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.log.error('mcp initial load failed', error);
    void this.rpc.emitEvent({
      type: 'error',
      agentId: 'main',
      ...makeErrorPayload(ErrorCodes.MCP_STARTUP_FAILED, message),
    });
  }

  private onMcpServerStatusChange(entry: McpServerEntry): void {
    // Always surface server-level status changes to clients so the TUI/SDK
    // can keep its dashboard in sync, even before the main agent exists.
    void this.rpc.emitEvent({
      type: 'mcp.server.status',
      agentId: 'main',
      server: {
        name: entry.name,
        transport: entry.transport,
        status: entry.status,
        toolCount: entry.toolCount,
        error: entry.error,
      },
    });
    this.refreshAgentsOnMcpInstructionsChange();
  }

  /**
   * MCP servers connect asynchronously at session startup — usually AFTER
   * the main agent's system prompt was first rendered — and can reconnect or
   * drop at any time. Server instructions are immutable per connection, so
   * whenever the aggregated block changes we re-render every ready agent's
   * system prompt. This busts the prompt-cache prefix by design; connection
   * changes are rare enough for that to be acceptable.
   *
   * Two guardrails keep the rare bust from becoming a storm:
   * - startup: while the initial `connectAll` is in flight, per-server status
   *   events only update the live manager — the refresh runs once, aggregated,
   *   when the initial load settles (`loadMcpServers` finally block).
   * - resume: `lastMcpInstructionsBlock` is primed from the restored system
   *   prompt (`primeMcpInstructionsBaseline`), so the first status event
   *   after a resume does not misread the already-rendered block as a change.
   */
  private refreshAgentsOnMcpInstructionsChange(): void {
    if (this.mcpInitialLoadPending) return;
    const current = formatMcpServerInstructions(this.mcp.serverInstructions());
    if (current === this.lastMcpInstructionsBlock) return;
    this.lastMcpInstructionsBlock = current;
    for (const agent of this.readyAgents()) {
      agent.refreshSystemPrompt().catch((error: unknown) => {
        this.log.warn('system prompt refresh after MCP instructions change failed', { error });
      });
    }
  }

  /**
   * Initialize the instructions-change baseline from a resumed agent's
   * restored system prompt: the block that was rendered when the session was
   * persisted. Without this the baseline (`''`) mismatches the restored
   * render and the first MCP status event after resume triggers a full
   * system-prompt refresh that changes nothing.
   */
  private primeMcpInstructionsBaseline(agent: Agent): void {
    const block = extractMcpInstructionsBlock(agent.config.systemPrompt);
    if (block === undefined) return;
    this.lastMcpInstructionsBlock = block;
  }

  private refreshAgentBuiltinTools(): void {
    for (const agent of this.readyAgents()) {
      if (!agent.config.hasProvider) continue;
      agent.tools.initializeBuiltinTools();
    }
  }

  /**
   * Replace the enabled plugins' system-prompt contributions on every ready
   * agent and re-render prompts. The owning core calls this after an explicit
   * plugin reload — installing, enabling, disabling, or removing a plugin
   * without a reload deliberately leaves live prompts unchanged.
   */
  async setPluginSystemPrompts(sections: readonly EnabledPluginSystemPrompt[]): Promise<void> {
    this.pluginSystemPrompts = sections;
    for (const agent of this.readyAgents()) {
      agent.setPluginSystemPrompts(sections);
      try {
        await agent.refreshSystemPrompt();
      } catch (error) {
        this.log.warn('failed to refresh system prompt after plugin reload', { error });
      }
    }
  }

  private instantiateAgent(
    id: string,
    homedir: string,
    type: AgentType,
    config: Partial<AgentOptions> = {},
    parentAgentId: string | null = null,
  ): Agent {
    const parentAgent = parentAgentId !== null ? this.getReadyAgent(parentAgentId) : undefined;
    const cwd = parentAgent?.config.cwd ?? this.toolKaos.getcwd();
    let agent!: Agent;
    const subagentHost =
      config.subagentHost ?? new SessionSubagentHost(this, id, () => agent);
    agent = new Agent({
      ...config,
      type,
      kaos: this.toolKaos.withCwd(cwd),
      toolServices: this.options.toolServices,
      config: this.cloudCodeConfig,
      homedir,
      brandHomeDir: this.options.cloudCodeHomeDir,
      // Session-level, shared across agents: originals persisted for
      // compression captions live with the session, not the agent.
      mediaOriginalsDir: sessionMediaOriginalsDir(this.options.homedir),
      skills: this.skills,
      rpc: proxyWithExtraPayload(this.rpc, { agentId: id }),
      modelProvider: this.options.providerManager,
      hookEngine: config.hookEngine ?? this.hookEngine,
      subagentHost,
      teamStore: config.teamStore ?? this.teamStore,
      mailbox: config.mailbox ?? this.mailbox,
      mcp: this.mcp,
      permission: this.permissionOptions(parentAgentId, config.permission),
      log: this.log.createChild({ agentId: id }),
      pluginSessionStarts: type === 'main' ? this.options.pluginSessionStarts : undefined,
      pluginCommands: type === 'main' ? this.options.pluginCommands : undefined,
      outputStylesProvider: () => this.outputStyles,
      pluginSystemPrompts: this.pluginSystemPrompts,
      experimentalFlags: this.experimentalFlags,
      imageLimits: this.imageLimits,
      additionalDirs: parentAgent?.getAdditionalDirs() ?? this.additionalDirs,
      systemPromptContextProvider: () =>
        prepareSystemPromptContext(
          this.systemContextKaos(agent.kaos.getcwd()),
          this.options.cloudCodeHomeDir,
          // Git status is main-loop only; the memoized snapshot keeps
          // post-compaction re-renders byte-identical to the bootstrap one.
          { additionalDirs: agent.getAdditionalDirs(), includeGitStatus: type === 'main' },
        ),
    });
    return agent;
  }

  private permissionOptions(
    parentAgentId: string | null,
    input?: PermissionManagerOptions | undefined,
  ): PermissionManagerOptions {
    if (parentAgentId === null) {
      return {
        ...input,
        initialRules: input?.initialRules ?? this.options.permissionRules,
      };
    }
    return {
      ...input,
      parent: input?.parent ?? this.getReadyAgent(parentAgentId)?.permission,
    };
  }

  getReadyAgent(id: string): Agent | undefined {
    const entry = this.agents.get(id);
    return entry instanceof Agent ? entry : undefined;
  }

  /**
   * Stop the background task backing an agent through its parent's
   * BackgroundManager (the mailbox shutdown protocol): resolves the task by
   * agent id and rides the ordinary TaskStop path, so the task settles
   * `killed` with the given reason and the parent gets the usual terminal
   * notification. Returns false when no live task backs the agent.
   */
  async stopAgentTask(agentId: string, reason: string): Promise<boolean> {
    const parentAgentId = this.metadata.agents[agentId]?.parentAgentId;
    const parent =
      parentAgentId !== undefined && parentAgentId !== null
        ? this.getReadyAgent(parentAgentId)
        : undefined;
    if (parent === undefined) return false;
    const task = parent.background
      .list(true)
      .find((info) => info.kind === 'agent' && info.agentId === agentId);
    if (task === undefined) return false;
    await parent.background.stop(task.taskId, reason);
    return true;
  }

  /**
   * Publish the current team snapshot as a `team.updated` protocol event
   * (read-only team viewers). Fired by the TeamStore
   * change hook on every persisted task-list mutation, and directly by the
   * subagent host after a teammate spawn — membership lives in the session
   * metadata (the roster authority), not the team file, so a spawn is a
   * team-view change the store cannot see.
   */
  async emitTeamSnapshot(teamName: string): Promise<void> {
    const team = await this.teamStore.getTeam(teamName);
    if (team === undefined) return;
    const members = Object.entries(this.metadata.agents)
      .filter(([, meta]) => meta.teammate?.teamName === teamName)
      .map(([agentId, meta]) => ({ name: meta.teammate!.name, agentId }))
      .toSorted((a, b) => a.name.localeCompare(b.name));
    const wire: TeamWire = {
      name: team.name,
      createdBy: team.createdBy,
      members,
      tasks: team.tasks.map((task) => ({ ...task })),
    };
    void this.rpc.emitEvent({ type: 'team.updated', agentId: 'main', team: wire });
  }

  *readyAgents(): Iterable<Agent> {
    for (const entry of this.agents.values()) {
      if (entry instanceof Agent) yield entry;
    }
  }

  private async resolveAgentEntry(entry: AgentEntry): Promise<ResumedAgent> {
    if (entry instanceof Agent) return { agent: entry };
    return entry;
  }

  private resumeAgent(
    id: string,
    stack: readonly string[] = [],
  ): Promise<ResumedAgent> {
    if (stack.includes(id)) {
      throw new CloudCodeError(
        ErrorCodes.SESSION_STATE_INVALID,
        `Session agent parent chain contains a cycle: ${[...stack, id].join(' -> ')}`,
      );
    }

    const entry = this.agents.get(id);
    if (entry !== undefined) return this.resolveAgentEntry(entry);

    const promise = this.resumePersistedAgent(id, stack);
    this.agents.set(id, promise);
    return promise;
  }

  private async resumePersistedAgent(
    id: string,
    stack: readonly string[] = [],
  ): Promise<ResumedAgent> {
    await this.skillsReady;
    await this.customAgentsReady;
    const meta = this.metadata.agents[id];
    if (meta === undefined) {
      throw new CloudCodeError(ErrorCodes.SESSION_STATE_INVALID, `Session agent "${id}" is missing`);
    }

    const parentAgentId = meta.parentAgentId ?? null;
    const parent =
      parentAgentId === null
        ? undefined
        : await this.resumeAgent(parentAgentId, [...stack, id]);

    try {
      const agent = this.instantiateAgent(
        id,
        join(this.options.homedir, 'agents', id),
        meta.type,
        {},
        parentAgentId,
      );
      const result = await agent.resume();
      this.restoreAgentProfileHandle(agent, meta, parent?.agent);
      this.primeMcpInstructionsBaseline(agent);
      this.agents.set(id, agent);
      return { agent, warning: parent?.warning ?? result.warning };
    } catch (error) {
      const entry = this.agents.get(id);
      if (entry instanceof Promise) {
        this.agents.delete(id);
      }
      throw error;
    }
  }

  private restoreAgentProfileHandle(
    agent: Agent,
    meta: AgentMeta,
    parentAgent: Agent | undefined,
  ): void {
    if (agent.config.systemPrompt === '') return;
    const profile = this.resolvePersistedProfile(agent, meta, parentAgent);
    if (profile === undefined) return;
    agent.setActiveProfile(profile, this.options.cloudCodeHomeDir);
  }

  private resolvePersistedProfile(
    agent: Agent,
    meta: AgentMeta,
    parentAgent: Agent | undefined,
  ): ResolvedAgentProfile | undefined {
    const profileName = agent.config.profileName;
    if (profileName === undefined) return undefined;
    if (meta.type === 'sub') {
      return this.agentCatalog.delegatableSubagents(parentAgent?.config.profileName ?? 'agent')[
        profileName
      ];
    }
    return this.agentCatalog.get(profileName);
  }

  private nextGeneratedAgentId(): string {
    while (true) {
      const id = `agent-${this.agentIdCounter++}`;
      if (this.agents.has(id)) continue;
      if (this.metadata.agents[id] !== undefined) continue;
      return id;
    }
  }

  private requireMainAgent(): Agent {
    const agent = this.getReadyAgent('main');
    if (agent === undefined) {
      throw new CloudCodeError(ErrorCodes.AGENT_NOT_FOUND, 'Main agent was not found');
    }
    return agent;
  }

  private async triggerSessionStart(source: 'startup' | 'resume'): Promise<void> {
    await this.hookEngine.trigger('SessionStart', {
      matcherValue: source,
      inputData: { source },
    });
  }

  private async triggerSessionEnd(reason: 'exit'): Promise<void> {
    await this.hookEngine.trigger('SessionEnd', {
      matcherValue: reason,
      inputData: { reason },
    });
  }
}

export * from './subagent-host';
export * from './subagent-binding';
export * from './store';
export * from './session-title';

/**
 * Delimiters of the rendered MCP instructions block inside the default system
 * prompt template (`profile/default/system.md`): the fixed intro line
 * immediately precedes the `CLOUD_CODE_MCP_INSTRUCTIONS` body, and the
 * `# Ultimate Reminders` section immediately follows it. Used to recover the
 * block rendered into a persisted system prompt on resume.
 */
const MCP_INSTRUCTIONS_INTRO =
  'The following MCP servers have provided instructions for how to use their tools and resources:\n\n';
const MCP_INSTRUCTIONS_OUTRO = '\n\n# Ultimate Reminders';

/**
 * Recover the aggregated MCP instructions block rendered into a system
 * prompt — the exact string `formatMcpServerInstructions` produced for it —
 * or `undefined` when the prompt carries no MCP section. Inverse of the
 * template's `{% if CLOUD_CODE_MCP_INSTRUCTIONS %}` block; used to prime the
 * instructions-change baseline from a persisted prompt on resume.
 */
export function extractMcpInstructionsBlock(systemPrompt: string): string | undefined {
  const introIndex = systemPrompt.indexOf(MCP_INSTRUCTIONS_INTRO);
  if (introIndex === -1) return undefined;
  const blockStart = introIndex + MCP_INSTRUCTIONS_INTRO.length;
  const blockEnd = systemPrompt.indexOf(MCP_INSTRUCTIONS_OUTRO, blockStart);
  if (blockEnd === -1) return undefined;
  let block = systemPrompt.slice(blockStart, blockEnd);
  // The template puts exactly one newline between the rendered block and the
  // following section; the live aggregate carries no trailing newline.
  if (block.endsWith('\n')) block = block.slice(0, -1);
  return block;
}

function initCompletionReminder(agentsMd: string): string {
  const latest =
    agentsMd.trim().length === 0
      ? 'No AGENTS.md content was found after `/init` completed.'
      : agentsMd;
  return [
    'The user just ran `/init` slash command.',
    'The system has analyzed the codebase and generated an `AGENTS.md` file.',
    '',
    'Latest AGENTS.md file content:',
    latest,
  ].join('\n');
}
