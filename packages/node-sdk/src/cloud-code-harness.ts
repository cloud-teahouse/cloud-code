import type { Kaos } from '@cloud-code/kaos';
import {
  ErrorCodes,
  CloudCodeError,
  ImageLimits,
  type ExperimentalFeatureState,
} from '@cloud-code/agent-core';

import { Session } from '#/session';
import type { CloudCodeAuthFacade } from '#/auth';
import type { SDKRpcClientBase } from '#/rpc';
import type {
  AuthenticateMcpServerOptions,
  ConfigDiagnostics,
  CreateSessionOptions,
  ExportSessionInput,
  ExportSessionResult,
  ForkSessionInput,
  GetConfigOptions,
  CloudCodeConfig,
  CloudCodeConfigPatch,
  CloudCodeHostIdentity,
  ListSessionsOptions,
  McpServerConfig,
  McpTestResult,
  ModelAlias,
  ProviderConfig,
  RenameSessionInput,
  ResumeSessionInput,
  ReloadSessionInput,
  SessionSummary,
  SkillSummary,
  TestMcpServerOptions,
  WorkspaceTrustInfo,
} from '#/types';

export interface CloudCodeHarnessRuntimeOptions {
  readonly identity?: CloudCodeHostIdentity;
  readonly homeDir: string;
  readonly configPath: string;
  readonly auth: CloudCodeAuthFacade;
  readonly ensureConfigFile: () => Promise<void>;
  readonly onClose: () => void | Promise<void>;
  /**
   * Owner-scoped [image] limits for prompt-ingestion compression in the
   * client process (paste-time, ACP prompt conversion). In-process cores
   * (SDKRpcClient) hand over their core's instance; daemon-client hosts
   * leave it undefined and ingestion falls back to env/built-in defaults.
   */
  readonly imageLimits?: ImageLimits | undefined;
}

export class CloudCodeHarness {
  readonly homeDir: string;
  readonly configPath: string;
  readonly auth: CloudCodeAuthFacade;

  private readonly identity: CloudCodeHostIdentity | undefined;
  private readonly activeSessions = new Map<string, Session>();
  private readonly ensureConfigFileImpl: () => Promise<void>;
  private readonly closeImpl: () => void | Promise<void>;

  /**
   * Ingestion-side [image] limits owned by this harness's core; undefined for
   * daemon-client hosts, where the env var / built-in defaults apply.
   */
  readonly imageLimits: ImageLimits | undefined;

  constructor(
    private readonly rpc: SDKRpcClientBase,
    options: CloudCodeHarnessRuntimeOptions,
  ) {
    this.identity = options.identity;
    this.homeDir = options.homeDir;
    this.configPath = options.configPath;
    this.auth = options.auth;
    this.ensureConfigFileImpl = options.ensureConfigFile;
    this.closeImpl = options.onClose;
    this.imageLimits = options.imageLimits;
  }

  get sessions(): ReadonlyMap<string, Session> {
    return this.activeSessions;
  }

  get interactiveAgentId(): string {
    return this.rpc.interactiveAgentId;
  }

  withInteractiveAgent<T>(agentId: string, fn: () => T): T {
    return this.rpc.withInteractiveAgent(agentId, fn);
  }

  async createSession(options: CreateSessionOptions): Promise<Session> {
    const { planMode, kaos, persistenceKaos, ...coreOptions } = options;
    const summary =
      kaos === undefined && persistenceKaos === undefined
        ? await this.rpc.createSession(coreOptions)
        : await this.rpc.createSessionWithKaos(coreOptions, kaos ?? persistenceKaos as Kaos, persistenceKaos);
    const session = new Session({
      id: summary.id,
      workDir: summary.workDir,
      summary,
      rpc: this.rpc,
      onClose: () => {
        this.activeSessions.delete(summary.id);
      },
    });
    this.activeSessions.set(session.id, session);
    if (planMode === true) {
      await session.setPlanMode(true);
    }
    return session;
  }

  async resumeSession(input: ResumeSessionInput): Promise<Session> {
    const id = normalizeSessionId(input.id);
    const active = this.activeSessions.get(id);
    const { kaos, persistenceKaos, ...resumeInput } = input;
    if (active !== undefined) {
      if (kaos !== undefined || persistenceKaos !== undefined) {
        await this.rpc.resumeSessionWithKaos({ ...resumeInput, id }, kaos ?? persistenceKaos as Kaos, persistenceKaos);
      } else if (input.agentProfile !== undefined) {
        await this.rpc.resumeSession({ ...resumeInput, id });
      }
      return active;
    }

    const summary =
      kaos === undefined && persistenceKaos === undefined
        ? await this.rpc.resumeSession({ ...resumeInput, id })
        : await this.rpc.resumeSessionWithKaos({ ...resumeInput, id }, kaos ?? persistenceKaos as Kaos, persistenceKaos);
    const session = new Session({
      id: summary.id,
      workDir: summary.workDir,
      summary,
      rpc: this.rpc,
      onClose: () => {
        this.activeSessions.delete(summary.id);
      },
    });
    this.activeSessions.set(session.id, session);
    return session;
  }

  async reloadSession(input: ReloadSessionInput): Promise<Session> {
    const id = normalizeSessionId(input.id);
    const active = this.activeSessions.get(id);
    if (active !== undefined) {
      await active.reloadSession({
        forcePluginSessionStartReminder: input.forcePluginSessionStartReminder,
      });
      return active;
    }

    const summary = await this.rpc.reloadSession({
      sessionId: id,
      forcePluginSessionStartReminder: input.forcePluginSessionStartReminder,
    });
    const session = new Session({
      id: summary.id,
      workDir: summary.workDir,
      summary,
      rpc: this.rpc,
      onClose: () => {
        this.activeSessions.delete(summary.id);
      },
    });
    this.activeSessions.set(session.id, session);
    return session;
  }

  async forkSession(input: ForkSessionInput): Promise<Session> {
    const summary = await this.rpc.forkSession({
      id: normalizeSessionId(input.id),
      forkId: input.forkId,
      title: input.title,
      metadata: input.metadata,
      turnIndex: input.turnIndex,
    });
    const session = new Session({
      id: summary.id,
      workDir: summary.workDir,
      summary,
      rpc: this.rpc,
      onClose: () => {
        this.activeSessions.delete(summary.id);
      },
    });
    this.activeSessions.set(session.id, session);
    return session;
  }

  getSession(id: string): Session | undefined {
    return this.activeSessions.get(id);
  }

  async closeSession(id: string): Promise<void> {
    await this.activeSessions.get(id)?.close();
  }

  async deleteSession(id: string): Promise<void> {
    const sessionId = normalizeSessionId(id);
    await this.activeSessions.get(sessionId)?.close();
    await this.rpc.deleteSession({ sessionId });
  }

  async renameSession(input: RenameSessionInput): Promise<void> {
    await this.rpc.renameSession(input);
    this.activeSessions.get(input.id)?.emitMetaUpdated({ title: input.title });
  }

  async exportSession(input: ExportSessionInput): Promise<ExportSessionResult> {
    const result = await this.rpc.exportSession({
      ...input,
      version: input.version ?? this.identity?.version,
    });
    return result;
  }

  async listSessions(options: ListSessionsOptions = {}): Promise<readonly SessionSummary[]> {
    return this.rpc.listSessions(options);
  }

  /** Skills visible to a new session in `workDir`, without creating that session. */
  async listWorkspaceSkills(workDir: string): Promise<readonly SkillSummary[]> {
    return this.rpc.listWorkspaceSkills(workDir);
  }

  /**
   * Trust state of `workDir`. The v1 engine has no workspace-trust gate and
   * reports an always-trusted workspace.
   */
  async getWorkspaceTrustInfo(workDir: string): Promise<WorkspaceTrustInfo> {
    return this.rpc.getWorkspaceTrustInfo(workDir);
  }

  /** Mark `workDir` as trusted; project-level MCP servers connect live afterwards. */
  async trustWorkspace(workDir: string): Promise<void> {
    return this.rpc.trustWorkspace(workDir);
  }

  async getConfig(options: GetConfigOptions = {}): Promise<CloudCodeConfig> {
    return this.rpc.getConfig(options);
  }

  /** Warnings from the most recent config.toml load; empty when the config is fully valid. */
  async getConfigDiagnostics(): Promise<ConfigDiagnostics> {
    return this.rpc.getConfigDiagnostics();
  }

  async getExperimentalFeatures(): Promise<readonly ExperimentalFeatureState[]> {
    return this.rpc.getExperimentalFeatures();
  }

  async ensureConfigFile(): Promise<void> {
    await this.ensureConfigFileImpl();
  }

  async setConfig(patch: CloudCodeConfigPatch): Promise<CloudCodeConfig> {
    return this.rpc.setConfig(patch);
  }

  async removeProvider(providerId: string): Promise<CloudCodeConfig> {
    return this.rpc.removeProvider(providerId);
  }

  /** Wholesale replacement of one provider entry (edits can clear fields). */
  async setProvider(providerId: string, provider: ProviderConfig): Promise<CloudCodeConfig> {
    return this.rpc.setProvider(providerId, provider);
  }

  /** Wholesale replacement of one model alias (edits can clear fields). */
  async setModelAlias(alias: string, model: ModelAlias): Promise<CloudCodeConfig> {
    return this.rpc.setModelAlias(alias, model);
  }

  /** Delete a single model alias; clears `defaultModel` when it points at it. */
  async removeModel(alias: string): Promise<CloudCodeConfig> {
    return this.rpc.removeModel(alias);
  }

  /**
   * Wholesale replacement of the `[secondary_model]` section (the subagent
   * default); an absent/blank `model` clears it so subagents follow the main
   * model again.
   */
  async setSecondaryModel(input: {
    model?: string;
    effort?: string;
  }): Promise<CloudCodeConfig> {
    return this.rpc.setSecondaryModel(input);
  }

  /**
   * Whether several config sections can be persisted as ONE atomic write
   * (see {@link replaceConfigSections}). False on the v1 harness.
   */
  supportsAtomicSectionReplace(): boolean {
    return this.rpc.supportsAtomicSectionReplace();
  }

  /**
   * Replace several top-level config sections in ONE atomic write: a section
   * mapped to `undefined` is cleared, absent sections are left untouched.
   * Replace semantics (unlike {@link setConfig}'s deep-merge), so staged
   * removals are expressed by the written record itself.
   */
  async replaceConfigSections(sections: Record<string, unknown>): Promise<void> {
    return this.rpc.replaceConfigSections(sections);
  }

  /** User-global MCP entries from `<CLOUD_CODE_HOME>/mcp.json` only. */
  async listMcpServers(): Promise<readonly McpServerConfig[]> {
    return this.rpc.listGlobalMcpServers();
  }

  async addMcpServer(server: McpServerConfig): Promise<readonly McpServerConfig[]> {
    return this.rpc.addGlobalMcpServer(server);
  }

  async updateMcpServer(server: McpServerConfig): Promise<readonly McpServerConfig[]> {
    return this.rpc.updateGlobalMcpServer(server);
  }

  async removeMcpServer(name: string): Promise<readonly McpServerConfig[]> {
    return this.rpc.removeGlobalMcpServer(name);
  }

  async authenticateMcpServer(
    name: string,
    options: AuthenticateMcpServerOptions,
  ): Promise<void> {
    const started = await this.rpc.beginGlobalMcpServerAuth(name);
    if (started.status === 'already-authorized') return;
    try {
      const opened = await options.onAuthorizationUrl(started.authorizationUrl);
      if (opened === false) {
        throw new CloudCodeError(ErrorCodes.REQUEST_INVALID, 'MCP OAuth authorization was cancelled');
      }
      await this.rpc.completeGlobalMcpServerAuth(
        { flowId: started.flowId, timeoutMs: options.timeoutMs },
        options.signal,
      );
    } catch (error) {
      await this.rpc.cancelGlobalMcpServerAuth(started.flowId).catch(() => undefined);
      throw error;
    }
  }

  async resetMcpServerAuth(name: string): Promise<void> {
    return this.rpc.resetGlobalMcpServerAuth(name);
  }

  async testMcpServer(
    name: string,
    options: TestMcpServerOptions = {},
  ): Promise<McpTestResult> {
    return this.rpc.testGlobalMcpServer(name, options);
  }

  async close(): Promise<void> {
    // allSettled: one session refusing to close (e.g. the remote connection
    // is already dead) must not skip closeImpl — for stdio remote transport
    // that would orphan the `cloud-code serve` child process and leak the
    // connection. closeImpl is guaranteed below; failures are aggregated
    // and thrown at the end.
    const results = await Promise.allSettled(
      Array.from(this.activeSessions.values(), (session) => session.close()),
    );
    let closeImplError: unknown;
    try {
      await this.closeImpl();
    } catch (error) {
      closeImplError = error;
    }
    const failures: unknown[] = [];
    for (const result of results) {
      if (result.status === 'rejected') failures.push(result.reason);
    }
    if (closeImplError !== undefined) failures.push(closeImplError);
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(failures, 'CloudCodeHarness failed to close cleanly.');
    }
  }
}

function normalizeSessionId(value: string): string {
  if (typeof value !== 'string') {
    throw new CloudCodeError(ErrorCodes.SESSION_ID_REQUIRED, 'Session id is required.');
  }
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new CloudCodeError(ErrorCodes.SESSION_ID_EMPTY, 'Session id cannot be empty.');
  }
  return normalized;
}
