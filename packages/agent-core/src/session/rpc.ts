import { ErrorCodes, CloudCodeError } from '#/errors';
import type { SessionWarning } from '@cloud-code/protocol';
import type {
  ActivateSkillPayload,
  ActivatePluginCommandPayload,
  AddAdditionalDirPayload,
  AddAdditionalDirResult,
  AgentAPI,
  BeginCompactionPayload,
  CancelPayload,
  CancelPlanPayload,
  CancelShellCommandPayload,
  CreateGoalPayload,
  DetachBackgroundPayload,
  EmptyPayload,
  EnterSwarmPayload,
  GetBackgroundOutputPayload,
  GetBackgroundPayload,
  ImportContextPayload,
  McpServerInfo,
  OutputStyleSummary,
  PromptPayload,
  RunShellCommandPayload,
  ReconnectMcpServerPayload,
  RenameSessionPayload,
  RegisterToolPayload,
  SessionAPI,
  SetActiveToolsPayload,
  SetModelPayload,
  SetOutputStylePayload,
  SetPermissionPayload,
  SetServiceTierPayload,
  SetThinkingPayload,
  SkillSummary,
  PluginCommandDef,
  RewindFilesPayload,
  SteerPayload,
  StopBackgroundPayload,
  UndoHistoryPayload,
  UnregisterToolPayload,
  UpdateSessionMetadataPayload,
} from '#/rpc';
import type { PromisableMethods } from '#/utils/types';

import type { Session, SessionMeta } from '.';
import {
  promptMetadataTextFromPayload,
  promptMetadataTextFromPluginCommand,
  promptMetadataTextFromSkill,
  titleFromPromptMetadataText,
} from './prompt-metadata';
import { generateSessionTitle, SESSION_TITLE_TIMEOUT_MS } from './session-title';

type AgentScopedPayload<T> = T & { agentId: string };

export class SessionAPIImpl implements PromisableMethods<SessionAPI> {
  constructor(protected readonly session: Session) {}

  async renameSession(payload: RenameSessionPayload): Promise<void> {
    const title = payload.title.trim();
    if (title.length === 0) {
      throw new CloudCodeError(ErrorCodes.SESSION_TITLE_EMPTY, 'Session title cannot be empty');
    }
    this.session.metadata = {
      ...this.session.metadata,
      title,
      isCustomTitle: true,
      updatedAt: new Date().toISOString(),
    };
    await this.session.writeMetadata();
    // Tail re-append so the wire's lite window picks the new title up even if
    // no further prompt is sent before close.
    await this.session.reAppendSessionMetadata();
  }

  async updateSessionMetadata(payload: UpdateSessionMetadataPayload): Promise<void> {
    this.session.metadata = {
      ...this.session.metadata,
      ...payload.metadata,
      agents: this.session.metadata.agents,
    };
    await this.session.writeMetadata();
  }

  getSessionMetadata(_payload: EmptyPayload): SessionMeta {
    return this.session.metadata;
  }

  listSkills(_payload: EmptyPayload): Promise<readonly SkillSummary[]> {
    return this.session.listSkills();
  }

  listOutputStyles(_payload: EmptyPayload): Promise<readonly OutputStyleSummary[]> {
    return this.session.listOutputStyles();
  }

  setOutputStyle(payload: SetOutputStylePayload): Promise<void> {
    return this.session.setOutputStyle(payload.style);
  }

  listPluginCommands(_payload: EmptyPayload): readonly PluginCommandDef[] {
    return this.session.listPluginCommands();
  }

  listMcpServers(_payload: EmptyPayload): readonly McpServerInfo[] {
    return this.session.mcp.list();
  }

  async reconnectMcpServer(payload: ReconnectMcpServerPayload): Promise<void> {
    await this.session.mcp.reconnect(payload.name);
  }

  generateAgentsMd(_payload: EmptyPayload): Promise<void> {
    return this.session.generateAgentsMd();
  }

  getSessionWarnings(_payload: EmptyPayload): Promise<readonly SessionWarning[]> {
    return this.session.getSessionWarnings();
  }

  waitForBackgroundTasksOnPrint(_payload: EmptyPayload): Promise<void> {
    return this.session.waitForBackgroundTasksOnPrint();
  }

  handlePrintMainTurnCompleted(_payload: EmptyPayload): Promise<'finish' | 'continue'> {
    return this.session.handlePrintMainTurnCompleted();
  }

  addAdditionalDir(payload: AddAdditionalDirPayload): Promise<AddAdditionalDirResult> {
    return this.session.addAdditionalDir(payload.path, payload.persist);
  }

  async prompt({ agentId, ...payload }: AgentScopedPayload<PromptPayload>) {
    if (agentId === 'main') {
      await this.updatePromptMetadata(promptMetadataTextFromPayload(payload));
    }
    return (await this.getAgent(agentId)).prompt(payload);
  }

  async steer({ agentId, ...payload }: AgentScopedPayload<SteerPayload>) {
    if (agentId === 'main') {
      // A steer is user input like a prompt — and can even launch the
      // session's first turn (e.g. goal mode) — so keep title/lastPrompt in
      // sync the same way.
      await this.updatePromptMetadata(promptMetadataTextFromPayload(payload));
    }
    return (await this.getAgent(agentId)).steer(payload);
  }

  async runShellCommand({ agentId, ...payload }: AgentScopedPayload<RunShellCommandPayload>) {
    return (await this.getAgent(agentId)).runShellCommand(payload);
  }

  async cancelShellCommand({ agentId, ...payload }: AgentScopedPayload<CancelShellCommandPayload>) {
    return (await this.getAgent(agentId)).cancelShellCommand(payload);
  }

  async cancel({ agentId, ...payload }: AgentScopedPayload<CancelPayload>) {
    return (await this.getAgent(agentId)).cancel(payload);
  }

  async undoHistory({ agentId, ...payload }: AgentScopedPayload<UndoHistoryPayload>) {
    return (await this.getAgent(agentId)).undoHistory(payload);
  }

  async rewindFiles({ agentId, ...payload }: AgentScopedPayload<RewindFilesPayload>) {
    return (await this.getAgent(agentId)).rewindFiles(payload);
  }

  async setModel({ agentId, ...payload }: AgentScopedPayload<SetModelPayload>) {
    return (await this.getAgent(agentId)).setModel(payload);
  }

  async setThinking({ agentId, ...payload }: AgentScopedPayload<SetThinkingPayload>) {
    return (await this.getAgent(agentId)).setThinking(payload);
  }

  async setServiceTier({ agentId, ...payload }: AgentScopedPayload<SetServiceTierPayload>) {
    return (await this.getAgent(agentId)).setServiceTier(payload);
  }

  async setPermission({ agentId, ...payload }: AgentScopedPayload<SetPermissionPayload>) {
    return (await this.getAgent(agentId)).setPermission(payload);
  }

  async getModel({ agentId, ...payload }: AgentScopedPayload<EmptyPayload>) {
    return (await this.getAgent(agentId)).getModel(payload);
  }

  async enterPlan({ agentId, ...payload }: AgentScopedPayload<EmptyPayload>) {
    return (await this.getAgent(agentId)).enterPlan(payload);
  }

  async cancelPlan({ agentId, ...payload }: AgentScopedPayload<CancelPlanPayload>) {
    return (await this.getAgent(agentId)).cancelPlan(payload);
  }

  async clearPlan({ agentId, ...payload }: AgentScopedPayload<EmptyPayload>) {
    return (await this.getAgent(agentId)).clearPlan(payload);
  }

  async enterSwarm({ agentId, ...payload }: AgentScopedPayload<EnterSwarmPayload>) {
    return (await this.getAgent(agentId)).enterSwarm(payload);
  }

  async exitSwarm({ agentId, ...payload }: AgentScopedPayload<EmptyPayload>) {
    return (await this.getAgent(agentId)).exitSwarm(payload);
  }

  async getSwarmMode({ agentId, ...payload }: AgentScopedPayload<EmptyPayload>) {
    return (await this.getAgent(agentId)).getSwarmMode(payload);
  }

  async enterCoordinator({ agentId, ...payload }: AgentScopedPayload<EmptyPayload>) {
    return (await this.getAgent(agentId)).enterCoordinator(payload);
  }

  async exitCoordinator({ agentId, ...payload }: AgentScopedPayload<EmptyPayload>) {
    return (await this.getAgent(agentId)).exitCoordinator(payload);
  }

  async getCoordinatorMode({ agentId, ...payload }: AgentScopedPayload<EmptyPayload>) {
    return (await this.getAgent(agentId)).getCoordinatorMode(payload);
  }

  async beginCompaction({ agentId, ...payload }: AgentScopedPayload<BeginCompactionPayload>) {
    return (await this.getAgent(agentId)).beginCompaction(payload);
  }

  async cancelCompaction({ agentId, ...payload }: AgentScopedPayload<EmptyPayload>) {
    return (await this.getAgent(agentId)).cancelCompaction(payload);
  }

  async registerTool({ agentId, ...payload }: AgentScopedPayload<RegisterToolPayload>) {
    return (await this.getAgent(agentId)).registerTool(payload);
  }

  async unregisterTool({ agentId, ...payload }: AgentScopedPayload<UnregisterToolPayload>) {
    return (await this.getAgent(agentId)).unregisterTool(payload);
  }

  async setActiveTools({ agentId, ...payload }: AgentScopedPayload<SetActiveToolsPayload>) {
    return (await this.getAgent(agentId)).setActiveTools(payload);
  }

  async stopBackground({ agentId, ...payload }: AgentScopedPayload<StopBackgroundPayload>) {
    return (await this.getAgent(agentId)).stopBackground(payload);
  }

  async detachBackground({ agentId, ...payload }: AgentScopedPayload<DetachBackgroundPayload>) {
    return (await this.getAgent(agentId)).detachBackground(payload);
  }

  async clearContext({ agentId, ...payload }: AgentScopedPayload<EmptyPayload>) {
    return (await this.getAgent(agentId)).clearContext(payload);
  }

  async importContext({ agentId, ...payload }: AgentScopedPayload<ImportContextPayload>) {
    return (await this.getAgent(agentId)).importContext(payload);
  }

  async activateSkill({ agentId, ...payload }: AgentScopedPayload<ActivateSkillPayload>) {
    await (await this.getAgent(agentId)).activateSkill(payload);
    if (agentId === 'main') {
      await this.updatePromptMetadata(promptMetadataTextFromSkill(payload));
    }
  }

  async activatePluginCommand({
    agentId,
    ...payload
  }: AgentScopedPayload<ActivatePluginCommandPayload>) {
    await (await this.getAgent(agentId)).activatePluginCommand(payload);
    if (agentId === 'main') {
      await this.updatePromptMetadata(promptMetadataTextFromPluginCommand(payload));
    }
  }

  async startBtw({ agentId, ...payload }: AgentScopedPayload<EmptyPayload>): Promise<string> {
    return (await this.getAgent(agentId)).startBtw(payload);
  }

  async createGoal({ agentId, ...payload }: AgentScopedPayload<CreateGoalPayload>) {
    return (await this.getAgent(agentId)).createGoal(payload);
  }

  async getGoal({ agentId, ...payload }: AgentScopedPayload<EmptyPayload>) {
    return (await this.getAgent(agentId)).getGoal(payload);
  }

  async pauseGoal({ agentId, ...payload }: AgentScopedPayload<EmptyPayload>) {
    return (await this.getAgent(agentId)).pauseGoal(payload);
  }

  async resumeGoal({ agentId, ...payload }: AgentScopedPayload<EmptyPayload>) {
    return (await this.getAgent(agentId)).resumeGoal(payload);
  }

  async cancelGoal({ agentId, ...payload }: AgentScopedPayload<EmptyPayload>) {
    return (await this.getAgent(agentId)).cancelGoal(payload);
  }

  async getCronTasks({ agentId, ...payload }: AgentScopedPayload<EmptyPayload>) {
    return (await this.getAgent(agentId)).getCronTasks(payload);
  }

  async getBackgroundOutput({
    agentId,
    ...payload
  }: AgentScopedPayload<GetBackgroundOutputPayload>) {
    return (await this.getAgent(agentId)).getBackgroundOutput(payload);
  }

  async getContext({ agentId, ...payload }: AgentScopedPayload<EmptyPayload>) {
    return (await this.getAgent(agentId)).getContext(payload);
  }

  async getConfig({ agentId, ...payload }: AgentScopedPayload<EmptyPayload>) {
    return (await this.getAgent(agentId)).getConfig(payload);
  }

  async getPermission({ agentId, ...payload }: AgentScopedPayload<EmptyPayload>) {
    return (await this.getAgent(agentId)).getPermission(payload);
  }

  async getSandboxStatus({ agentId, ...payload }: AgentScopedPayload<EmptyPayload>) {
    return (await this.getAgent(agentId)).getSandboxStatus(payload);
  }

  async getPlan({ agentId, ...payload }: AgentScopedPayload<EmptyPayload>) {
    return (await this.getAgent(agentId)).getPlan(payload);
  }

  async getUsage({ agentId, ...payload }: AgentScopedPayload<EmptyPayload>) {
    return (await this.getAgent(agentId)).getUsage(payload);
  }

  async getTools({ agentId, ...payload }: AgentScopedPayload<EmptyPayload>) {
    return (await this.getAgent(agentId)).getTools(payload);
  }

  async getBackground({ agentId, ...payload }: AgentScopedPayload<GetBackgroundPayload>) {
    return (await this.getAgent(agentId)).getBackground(payload);
  }

  private async getAgent(agentId: string): Promise<PromisableMethods<AgentAPI>> {
    const agent = await this.session.ensureAgentResumed(agentId);
    return agent.rpcMethods;
  }

  private needUpdateEasyTitle(metadata: SessionMeta): boolean {
    if (hasCustomTitle(metadata)) return false;
    if (!isUntitled(metadata.title)) return false;
    return true;
  }

  private async updatePromptMetadata(lastPrompt: string | undefined): Promise<void> {
    if (lastPrompt === undefined) return;

    // Absorb external listing-metadata changes (a rename from another process
    // holding this session) before our whole-file write would clobber them.
    await this.session.absorbExternalMetadata();
    const title = this.needUpdateEasyTitle(this.session.metadata)
      ? titleFromPromptMetadataText(lastPrompt)
      : undefined;
    const now = new Date().toISOString();
    const nextMetadata = {
      ...this.session.metadata,
      lastPrompt,
      updatedAt: now,
    };
    if (title !== undefined) {
      nextMetadata.title = title;
      nextMetadata.isCustomTitle = false;
    }

    this.session.metadata = nextMetadata;
    await this.session.writeMetadata();
    await this.session.rpc.emitEvent({
      type: 'session.meta.updated',
      agentId: 'main',
      title,
      patch: {
        title,
        isCustomTitle: title === undefined ? undefined : false,
        lastPrompt,
      },
    });
    if (title !== undefined) {
      // A title change is low-frequency and high-value for the lite reader's
      // tail window; lastPrompt re-appends ride the close-time flush instead
      // of growing the wire on every prompt.
      await this.session.reAppendSessionMetadata();
      this.refineSessionTitle(lastPrompt, title);
    }
  }

  /**
   * Best-effort AI title refinement: the truncated first-prompt title is
   * already persisted, so this fire-and-forget side-channel call replaces it
   * only when generation succeeds — any failure (no provider, transport,
   * unparseable output) leaves the fallback in place. Never clobbers a title
   * that changed while generation was in flight (user rename, /fork, or a
   * later prompt's title).
   */
  private refineSessionTitle(lastPrompt: string, fallbackTitle: string): void {
    void (async () => {
      try {
        const agent = await this.session.ensureAgentResumed('main');
        const title = await generateSessionTitle(
          agent,
          lastPrompt,
          AbortSignal.timeout(SESSION_TITLE_TIMEOUT_MS),
        );
        if (title === null) return;
        // Absorb external changes before the never-clobber check: a rename
        // that landed while generation was in flight must win over the
        // generated title.
        await this.session.absorbExternalMetadata();
        const metadata = this.session.metadata;
        if (hasCustomTitle(metadata) || metadata.title !== fallbackTitle) return;
        this.session.metadata = {
          ...metadata,
          title,
          updatedAt: new Date().toISOString(),
        };
        await this.session.writeMetadata();
        await this.session.rpc.emitEvent({
          type: 'session.meta.updated',
          agentId: 'main',
          title,
          patch: { title, isCustomTitle: false },
        });
        await this.session.reAppendSessionMetadata();
      } catch {
        // Title generation is opportunistic; the fallback title stays.
      }
    })();
  }
}

function isUntitled(title: unknown): boolean {
  return typeof title !== 'string' || title.trim().length === 0 || title === 'New Session';
}

function hasCustomTitle(metadata: SessionMeta): boolean {
  if (metadata.isCustomTitle) return true;
  return typeof (metadata as SessionMeta & { customTitle?: unknown }).customTitle === 'string';
}
