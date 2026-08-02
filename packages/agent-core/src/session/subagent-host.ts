import {
  APIProviderRateLimitError,
  isProviderRateLimitError,
  type TokenUsage,
} from '@cloud-code/kosong';

import type { Agent } from '../agent';
import type { ThinkingEffort } from '../agent/config';
import type { PromptOrigin } from '../agent/context';
import { renderReminder } from '../agent/injection/reminder';
import {
  createTeammateContext,
  runWithTeammateContext,
  type TeammateIdentity,
} from '../agent/swarm/teammate-context';
import {
  renderTeammatePromptAddendum,
  TEAMMATE_PROMPT_ADDENDUM_ID,
} from '../agent/swarm/teammate-prompt-addendum';
import {
  findTeammateWork,
  MAX_STAGNANT_NUDGES,
  resolveKeepAliveOptions,
} from '../agent/swarm/teammate-keepalive';
import { renderMailboxMessage } from '../agent/swarm/mailbox-service';
import { ErrorCodes } from '../errors';
import { DenyAllPermissionPolicy } from '../agent/permission/policies/deny-all';
import { InMemoryAgentRecordPersistence } from '../agent/records';
import { isAbortError } from '../loop/errors';
import {
  prepareSystemPromptContext,
  type ResolvedAgentProfile,
} from '../profile';
import {
  abortable,
  isUserCancellation,
  linkAbortSignal,
  userCancellationReason,
} from '../utils/abort';
import { sleep } from '../utils/promise';
import { collectGitContext } from './git-context';
import type { Session } from './index';
import { SECONDARY_MODEL_KEYWORD, resolveSecondaryModel } from './subagent-binding';
import {
  SubagentBatch,
  resolveSwarmMaxConcurrency,
  type SubagentResult,
  type SubagentSuspendedEvent,
  type QueuedSubagentTask,
} from './subagent-batch';
import SUMMARY_CONTINUATION_PROMPT from './summary-continuation.md?raw';


function nonBlank(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

export const DEFAULT_SUBAGENT_TIMEOUT_MS = 2 * 60 * 60 * 1000;
export const DEFAULT_SUBAGENT_TIMEOUT_DESCRIPTION = '2 hours';

const SUBAGENT_TIMEOUT_ENV = 'KIMI_SUBAGENT_TIMEOUT_MS';


/**
 * Resolve the effective subagent per-task timeout. Precedence:
 * `KIMI_SUBAGENT_TIMEOUT_MS` (integer ms) → `configMs` →
 * `DEFAULT_SUBAGENT_TIMEOUT_MS` (2 hours). `0` means no timeout: the value
 * feeds the background-task manager's per-task timeout (where `0` arms no
 * timer), so it governs foreground and background subagents (and AgentSwarm).
 */
export function resolveSubagentTimeoutMs(configMs?: number): number {
  const raw = process.env[SUBAGENT_TIMEOUT_ENV];
  if (raw !== undefined && raw.trim().length > 0) {
    const parsed = Number(raw);
    if (Number.isInteger(parsed) && parsed >= 0) return parsed;
  }
  if (configMs !== undefined && Number.isInteger(configMs) && configMs >= 0) {
    return configMs;
  }
  return DEFAULT_SUBAGENT_TIMEOUT_MS;
}

/** Human-readable duration for the subagent timeout message. */
export function formatSubagentTimeoutDescription(ms: number): string {
  if (ms % (60 * 60 * 1000) === 0) {
    const h = ms / (60 * 60 * 1000);
    return `${h} hour${h === 1 ? '' : 's'}`;
  }
  if (ms % (60 * 1000) === 0) {
    const m = ms / (60 * 1000);
    return `${m} minute${m === 1 ? '' : 's'}`;
  }
  if (ms % 1000 === 0) {
    const s = ms / 1000;
    return `${s} second${s === 1 ? '' : 's'}`;
  }
  return `${ms} ms`;
}

export type {
  SubagentResult as QueuedSubagentRunResult,
  QueuedSubagentTask,
  ResumeQueuedSubagentTask,
  SpawnQueuedSubagentTask,
} from './subagent-batch';

/**
 * A subagent summary shorter than this many characters triggers one
 * follow-up turn that asks the subagent to expand it, so the parent
 * agent receives a technically complete handoff.
 */
const SUMMARY_MIN_LENGTH = 200;
const SUMMARY_CONTINUATION_ATTEMPTS = 1;
const HOOK_TEXT_PREVIEW_LENGTH = 500;
const SUBAGENT_MAX_TOKENS_ERROR =
  'Subagent turn failed before completing its final summary: reason=max_tokens';
const TOOL_CALL_DISABLED_MESSAGE =
  'Tool calls are disabled for side questions. Answer with text only.';
const SUBAGENT_PROMPT_ORIGIN: PromptOrigin = { kind: 'system_trigger', name: 'subagent' };
/**
 * Keep-alive nudge turns (idle work pickup): a settled
 * teamed teammate is prompted back into a turn with the work notification.
 * A `system_trigger` origin — same bookkeeping class as the subagent spawn
 * prompt, not a mailbox delivery.
 */
const TEAMMATE_KEEPALIVE_PROMPT_ORIGIN: PromptOrigin = {
  kind: 'system_trigger',
  name: 'teammate_keepalive',
};
// Standard tier (see agent/injection/reminder.ts): a mode directive over
// same-session user content — the side channel carries no external/untrusted
// content, so there is no trust boundary and no IMPORTANT prefix. The tool
// prohibition closes the prose (recency position).
// Exported for the reminder-grading tests.
export const SIDE_QUESTION_SYSTEM_REMINDER = renderReminder({
  authority: 'standard',
  body: `This is a side-channel conversation with the user. You should answer user questions directly based on what you already know.

- You are a separate, lightweight instance.
- The main agent continues independently; do not reference being interrupted.
- Respond only with text based on what you already know from the conversation
  and this side-channel conversation.
- Follow-up turns may happen in this side-channel conversation.
- If you do not know the answer, say so directly.`,
  prohibition:
    'Do not call any tools. All tool calls are disabled and will be rejected. ' +
    'Even though tool definitions are visible in this request, they exist only ' +
    'for technical reasons (prompt cache). You must not use them.',
});

export interface RunSubagentOptions {
  readonly parentToolCallId: string;
  readonly parentToolCallUuid?: string;
  readonly prompt: string;
  readonly description: string;
  readonly swarmIndex?: number;
  readonly runInBackground: boolean;
  /**
   * Spawn-level model selection: a model alias, or 'secondary' for the
   * `[secondary_model]` config (see resolveChildModel for the full
   * precedence). A profile-pinned model wins over this value.
   */
  readonly model?: string;
  readonly signal: AbortSignal;
  readonly onReady?: () => void;
  readonly suppressRateLimitFailureEvent?: boolean;
}

export interface SpawnSubagentOptions extends RunSubagentOptions {
  readonly profileName: string;
  readonly swarmItem?: string;
  /**
   * When set, the child runs as an in-process teammate: the
   * identity is persisted in the session agent metadata, latched on the
   * child agent for the topology guards, and installed as the
   * AsyncLocalStorage teammate context for every run of this child
   * (spawn/resume/retry).
   */
  readonly teammate?: TeammateIdentity;
  /**
   * Fork semantics (the Agent tool's `inherit_context`): the child's context
   * is seeded with a copy of the parent's projected message history
   * as-of-spawn — the trailing open exchange that made the spawning tool
   * call is trimmed — followed by its prompt. The system prompt and tool
   * definitions still come from the child's own profile, and no records or
   * other agent state are copied. The copy is a snapshot: later parent
   * messages are not seen, and a resume never re-copies.
   */
  readonly inheritContext?: boolean;

}

type SubagentCompletion = {
  readonly result: string;
  readonly usage?: TokenUsage;
  /**
   * Cumulative tool calls the child agent dispatched, captured at completion.
   * Feeds the coordinator-mode `<task-notification>` `<tool_uses>` field;
   * per-worker like `usage` (each subagent run owns its child Agent).
   */
  readonly toolUses?: number;
};

type OwnerAgentResolver = () => Agent;

export type SubagentHandle = {
  readonly agentId: string;
  readonly profileName: string;
  readonly resumed: boolean;
  readonly completion: Promise<SubagentCompletion>;
};

export class SessionSubagentHost {
  private readonly activeChildren = new Map<
    string,
    {
      readonly controller: AbortController;
      runInBackground: boolean;
    }
  >();

  constructor(
    private readonly session: Session,
    private readonly ownerAgentId: string,
    private readonly getOwnerAgent?: OwnerAgentResolver,
  ) {}

  async spawn(options: SpawnSubagentOptions): Promise<SubagentHandle> {
    options.signal.throwIfAborted();

    await this.session.waitForCustomAgents?.();
    const parent = await this.session.ensureAgentResumed(this.ownerAgentId);
    const profile = this.resolveProfile(parent, options.profileName);
    if (options.inheritContext === true) {
      this.assertForkAllowed(parent, options.teammate);
    }
    if (options.teammate?.teamName !== undefined) {
      this.assertTeammateNameAvailable(options.teammate.teamName, options.teammate.name);
      // The team file carries the shared task list; it exists from the
      // first teammate spawn into the team, so task tools never depend on a
      // separate setup step.
      await this.session.teamStore.ensureTeam(options.teammate.teamName, this.ownerAgentId);
    }
    const { id, agent } = await this.session.createAgent(
      { type: 'sub', generate: parent.rawGenerate },
      { parentAgentId: this.ownerAgentId, swarmItem: options.swarmItem, teammate: options.teammate },
    );
    // Team viewers: membership lives in the session metadata, which the
    // TeamStore change hook cannot see — publish the roster change
    // explicitly.
    if (options.teammate?.teamName !== undefined) {
      void this.session.emitTeamSnapshot(options.teammate.teamName).catch(() => {});
    }
    // Topology latch: a worker spawned while the parent coordinates
    // must not fan out further workers — the deny policy reads this marker.
    agent.setCoordinatorWorker(parent.coordinatorMode.isActive);
    // Teammate identity latch: the deny policy reads this marker so the
    // topology guards hold even for turns dispatched outside the
    // AsyncLocalStorage teammate context (e.g. a steered follow-up).
    agent.setTeammateIdentity(options.teammate);
    const inheritContext = options.inheritContext === true;
    const completion = this.runWithActiveChild(id, options, async (runOptions) => {
      this.emitSubagentSpawned(parent, id, profile.name, runOptions);
      try {
        await this.configureChild(parent, agent, profile, runOptions.model, inheritContext);
        return await this.runPromptTurn(parent, id, agent, profile.name, runOptions);
      } catch (error) {
        this.emitSubagentFailed(parent, id, runOptions, error);
        throw error;
      }
    }, agent);
    return {
      agentId: id,
      profileName: profile.name,
      resumed: false,
      completion,
    };
  }

  async resume(agentId: string, options: RunSubagentOptions): Promise<SubagentHandle> {
    options.signal.throwIfAborted();
    const { parent, child, profileName } = await this.ensureIdleSubagent(agentId);
    const completion = this.runWithActiveChild(agentId, options, async (runOptions) => {
      this.emitSubagentSpawned(parent, agentId, profileName, runOptions);
      try {
        this.realignChildModel(parent, child, profileName, runOptions.model);
        return await this.runPromptTurn(parent, agentId, child, profileName, runOptions);
      } catch (error) {
        this.emitSubagentFailed(parent, agentId, runOptions, error);
        throw error;
      }
    }, child);
    return { agentId, profileName, resumed: true, completion };
  }

  async retry(agentId: string, options: RunSubagentOptions): Promise<SubagentHandle> {
    options.signal.throwIfAborted();
    const { parent, child, profileName } = await this.ensureIdleSubagent(agentId);
    const completion = this.runWithActiveChild(agentId, options, async (runOptions) => {
      try {
        runOptions.signal.throwIfAborted();
        this.realignChildModel(parent, child, profileName, runOptions.model);
        this.emitSubagentStarted(parent, agentId);
        const turnId = child.turn.retry('agent-host');
        if (turnId === null) {
          throw new Error(`Agent instance "${agentId}" could not start a retry turn`);
        }
        this.observeFirstRequest(child, runOptions);
        return await this.waitForChildCompletion(parent, agentId, child, profileName, runOptions);
      } catch (error) {
        this.emitSubagentFailed(parent, agentId, runOptions, error);
        throw error;
      }
    }, child);
    return { agentId, profileName, resumed: true, completion };
  }

  private async ensureIdleSubagent(
    agentId: string,
  ): Promise<{ readonly parent: Agent; readonly child: Agent; readonly profileName: string }> {
    const parent = await this.session.ensureAgentResumed(this.ownerAgentId);
    const metadata = this.session.metadata.agents[agentId];
    if (metadata?.type !== 'sub') {
      throw new Error(`Agent instance "${agentId}" is not a subagent`);
    }
    if (metadata.parentAgentId !== this.ownerAgentId) {
      throw new Error(`Agent instance "${agentId}" does not belong to this parent agent`);
    }
    const child = await this.session.ensureAgentResumed(agentId);
    if (this.activeChildren.has(agentId) || child.turn.hasActiveTurn) {
      throw new Error(`Agent instance "${agentId}" is already running and cannot run concurrently`);
    }

    // Re-latch the topology marker per run: a worker resumed under a
    // coordinator parent is constrained again; resumed after the parent left
    // coordinator mode, it regains plain-subagent capabilities.
    child.setCoordinatorWorker(parent.coordinatorMode.isActive);

    // Re-latch the teammate identity per run from the persisted metadata, so
    // a teammate keeps its identity (and its topology guards) across
    // resume/retry and session restores.
    child.setTeammateIdentity(metadata.teammate);

    // Re-register the collaboration addendum: the append bus is session-owned
    // and does not survive a restart, so a resumed teammate would otherwise
    // lose the addendum at the next profile re-render (post-compaction). With
    // the persisted prompt still live this is a no-op push; after a restart
    // the registration stays pending for the next render.
    if (metadata.teammate?.teamName !== undefined) {
      child.setSystemPromptAddendum(
        TEAMMATE_PROMPT_ADDENDUM_ID,
        renderTeammatePromptAddendum(metadata.teammate),
      );
    }

    const profileName = child.config.profileName ?? 'subagent';
    return { parent, child, profileName };
  }

  async runQueued<T>(tasks: readonly QueuedSubagentTask<T>[]): Promise<Array<SubagentResult<T>>> {
    const maxConcurrency = resolveSwarmMaxConcurrency();
    return new SubagentBatch(this, tasks, { maxConcurrency }).run();
  }

  suspended(event: SubagentSuspendedEvent): void {
    const parent = this.session.getReadyAgent?.(this.ownerAgentId);
    parent?.emitEvent({
      type: 'subagent.suspended',
      subagentId: event.agentId,
      reason: event.reason,
    });
  }

  async startBtw(): Promise<string> {
    const parent = await this.session.ensureAgentResumed(this.ownerAgentId);
    const { id, agent: child } = await this.session.createAgent(
      {
        type: 'sub',
        generate: parent.rawGenerate,
        persistence: new InMemoryAgentRecordPersistence(),
      },
      { parentAgentId: this.ownerAgentId, persistMetadata: false },
    );

    child.config.update({
      modelAlias: parent.config.modelAlias,
      thinkingEffort: parent.config.thinkingEffort,
      systemPrompt: parent.config.systemPrompt,
    });
    child.tools.copyLoopToolsFrom(parent.tools);
    child.context.useProjectedHistoryFrom(parent.context);
    child.context.appendSystemReminder(SIDE_QUESTION_SYSTEM_REMINDER, {
      kind: 'system_trigger',
      name: 'btw',
    });
    child.permission.policies.unshift(new DenyAllPermissionPolicy(TOOL_CALL_DISABLED_MESSAGE));
    return id;
  }

  cancelAll(reason: unknown = userCancellationReason()): void {
    const foregroundChildren = Array.from(this.activeChildren).filter(
      ([, child]) => !child.runInBackground,
    );
    for (const [childId, child] of foregroundChildren) {
      this.session.getReadyAgent(childId)?.subagentHost?.cancelAll(reason);
      // Abort with the cancel reason (a user interruption by default) so the
      // subagent's in-flight tools report the cause accurately to the model.
      child.controller.abort(reason);
    }
  }

  markActiveChildDetached(agentId: string): void {
    const child = this.activeChildren.get(agentId);
    if (child !== undefined) child.runInBackground = true;
  }

  async getProfileName(agentId: string): Promise<string | undefined> {
    const metadata = this.session.metadata.agents[agentId];
    if (metadata?.type !== 'sub' || metadata.parentAgentId !== this.ownerAgentId) {
      return undefined;
    }
    return (await this.session.ensureAgentResumed(agentId)).config.profileName;
  }

  getSwarmItem(agentId: string): string | undefined {
    const metadata = this.session.metadata.agents[agentId];
    if (metadata?.type !== 'sub' || metadata.parentAgentId !== this.ownerAgentId) {
      return undefined;
    }
    return metadata.swarmItem;
  }

  private resolveProfile(parent: Agent, profileName: string): ResolvedAgentProfile {
    const profile = this.tryResolveProfile(parent, profileName);
    if (profile === undefined) {
      throw new Error(`Subagent profile "${profileName}" was not found`);
    }
    return profile;
  }

  /**
   * Teammate names are the stable identity used for task ownership and,
   * later, mailbox addressing — so a (team, name) pair must stay
   * unique for the session's lifetime. Reusing a finished teammate's name
   * for a different worker would corrupt task attribution; resume the
   * existing agent instead, or pick a new name. Names are only scoped to
   * their team: the same name in another team is fine.
   */
  private assertTeammateNameAvailable(teamName: string, name: string): void {
    for (const [agentId, meta] of Object.entries(this.session.metadata.agents)) {
      if (meta.teammate?.teamName !== teamName) continue;
      if (meta.teammate.name !== name) continue;
      throw new Error(
        `Teammate "${name}" already exists in team "${teamName}" (agent id "${agentId}"). ` +
          `Resume it with Agent(resume="${agentId}", prompt="...") to keep its context, or choose a different name.`,
      );
    }
  }

  private tryResolveProfile(
    parent: Agent,
    profileName: string,
  ): ResolvedAgentProfile | undefined {
    const profiles = this.session.getAgentProfiles?.();
    if (profiles !== undefined) {
      const fromProfiles =
        profiles[parent.config.profileName ?? 'agent']?.subagents?.[profileName] ??
        profiles['agent']?.subagents?.[profileName];
      if (fromProfiles !== undefined) return fromProfiles;
    }
    return this.resolveDelegatableSubagents(
      parent.config.profileName,
      parent.config.subagentNames,
    )[profileName];
  }

  /**
   * Model and thinking-effort selection for a child agent, shared by the
   * spawn, resume, and retry paths. Precedence:
   *   1. the profile's pinned model (e.g. the `model` field of a file-based
   *      custom agent);
   *   2. an explicit model alias requested at spawn (the Agent/AgentSwarm
   *      `model` parameter);
   *   3. the profile's `model_preference` ('primary' pins the parent's model,
   *      'secondary' selects the `[secondary_model]` config);
   *   4. the 'secondary' keyword resolved through resolveSecondaryModel —
   *      an unconfigured secondary falls through to the parent model;
   *   5. the parent agent's model.
   * The thinking effort follows the parent, except on the secondary path
   * where the resolved secondary effort applies when set (only while the
   * secondary model is actually used).
   */

  private resolveChildModel(
    parent: Agent,
    profile: ResolvedAgentProfile | undefined,
    requestedModel: string | undefined,
  ): { modelAlias: string | undefined; thinkingEffort: ThinkingEffort } {
    const parentSelection = {
      modelAlias: parent.config.modelAlias,
      thinkingEffort: parent.config.thinkingEffort,
    };
    if (profile?.model !== undefined) {
      return { ...parentSelection, modelAlias: profile.model };
    }
    // The profile's own `model_preference` applies when the tool call does
    // not pick a model explicitly; 'primary' pins the parent's model.
    const requested = nonBlank(requestedModel) ?? profile?.modelPreference;
    if (requested === undefined || requested === 'primary') {
      return parentSelection;
    }
    if (requested !== SECONDARY_MODEL_KEYWORD) {
      return { ...parentSelection, modelAlias: requested };
    }
    const secondary = resolveSecondaryModel(parent.kimiConfig?.secondaryModel);
    if (secondary.model === undefined) {
      return parentSelection;
    }
    return {
      modelAlias: secondary.model,
      thinkingEffort: secondary.effort ?? parent.config.thinkingEffort,
    };
  }

  /**
   * Re-derive the child's model and effort on resume/retry with the spawn
   * precedence (resolveChildModel): a profile pin or a freshly requested
   * model is re-applied; otherwise the child realigns to the parent's
   * current model and effort.
   */
  private realignChildModel(
    parent: Agent,
    child: Agent,
    profileName: string,
    requestedModel: string | undefined,
  ): void {
    const profile = this.tryResolveProfile(parent, profileName);
    child.config.update(this.resolveChildModel(parent, profile, requestedModel));
  }

  /**
   * The subagent types the given profile may delegate to (its own linked set,
   * or the default profile's when it declares none). Backs the `Agent` tool's
   * "Available agent types" description.
   */
  delegatableSubagents(callerProfileName?: string): Record<string, ResolvedAgentProfile> {
    const owner = this.getOwnerAgent?.() ?? this.session.getReadyAgent(this.ownerAgentId);
    return this.resolveDelegatableSubagents(callerProfileName, owner?.config.subagentNames);
  }

  private resolveDelegatableSubagents(
    callerProfileName: string | undefined,
    persistedNames: readonly string[] | undefined,
  ): Record<string, ResolvedAgentProfile> {
    const catalogProfiles = this.session.agentCatalog.delegatableSubagents(callerProfileName);
    if (persistedNames === undefined) return catalogProfiles;

    return Object.fromEntries(
      persistedNames.flatMap((name) => {
        const profile = catalogProfiles[name];
        return profile === undefined ? [] : [[name, profile]];
      }),
    );
  }

  private runWithActiveChild(
    childId: string,
    options: RunSubagentOptions,
    run: (options: RunSubagentOptions) => Promise<SubagentCompletion>,
    child: Agent,
  ): Promise<SubagentCompletion> {
    const controller = new AbortController();
    const unlinkAbortSignal = linkAbortSignal(options.signal, controller);
    this.activeChildren.set(childId, {
      controller,
      runInBackground: options.runInBackground,
    });

    // A teammate's whole run — configure, prompt turn, summary continuations,
    // and everything they schedule (tool dispatches included) — executes
    // inside the AsyncLocalStorage teammate context. Keyed off the
    // persisted agent metadata rather than the spawn options so resume/retry
    // runs of the same teammate are scoped identically.
    const teammate = this.session.metadata.agents[childId]?.teammate;
    if (teammate?.teamName !== undefined) {
      // Inbox delivery for this run — messages steer into the teammate's
      // active turn; a shutdown request drives the graceful stop. The watch
      // ends with the run (controller abort).
      this.session.mailbox.startTeammateWatcher({
        teamName: teammate.teamName,
        name: teammate.name,
        agentId: childId,
        agent: child,
        controller,
      });
      // And the reverse direction: anything teammates post to the leader's
      // inbox of this team is steered into the leader's turn.
      this.session.mailbox.ensureLeaderWatcher(teammate.teamName);
    }
    const invoke = (runOptions: RunSubagentOptions): Promise<SubagentCompletion> => {
      if (teammate === undefined) return run(runOptions);
      const context = createTeammateContext({
        agentId: childId,
        parentAgentId: this.ownerAgentId,
        name: teammate.name,
        teamName: teammate.teamName,
        abortController: controller,
      });
      return runWithTeammateContext(context, () => run(runOptions));
    };

    return invoke({ ...options, signal: controller.signal }).finally(() => {
      unlinkAbortSignal();
      this.activeChildren.delete(childId);
    });
  }

  private async runPromptTurn(
    parent: Agent,
    childId: string,
    child: Agent,
    profileName: string,
    options: RunSubagentOptions,
  ): Promise<SubagentCompletion> {
    options.signal.throwIfAborted();
    await this.triggerSubagentStart(parent, profileName, options.prompt, options.signal);
    options.signal.throwIfAborted();

    let childPrompt = options.prompt;
    if (profileName === 'explore') {
      const gitContext = await collectGitContext(child.kaos, child.config.cwd);
      if (gitContext) childPrompt = `${gitContext}\n\n${childPrompt}`;
    }

    this.emitSubagentStarted(parent, childId);
    const turnId = child.turn.prompt([{ type: 'text', text: childPrompt }], SUBAGENT_PROMPT_ORIGIN);
    if (turnId === null) {
      throw new Error(`Agent instance "${childId}" could not start a turn`);
    }
    this.observeFirstRequest(child, options);
    return this.waitForChildCompletion(parent, childId, child, profileName, options);
  }

  private async waitForChildCompletion(
    parent: Agent,
    childId: string,
    child: Agent,
    profileName: string,
    options: RunSubagentOptions,
  ): Promise<SubagentCompletion> {
    await this.settleChildTurn(child, options.signal);
    await this.runTeammateKeepAliveLoop(childId, child, options);

    // A subagent that returns an overly terse summary leaves the parent
    // agent under-informed. Give it a bounded number of chances to expand
    // the handoff; if it is still short after that, accept it as-is rather
    // than retrying indefinitely.
    let result = lastAssistantText(child);
    let remainingContinuations = SUMMARY_CONTINUATION_ATTEMPTS;
    while (remainingContinuations > 0 && result.length < SUMMARY_MIN_LENGTH) {
      remainingContinuations -= 1;
      options.signal.throwIfAborted();
      child.turn.prompt([{ type: 'text', text: SUMMARY_CONTINUATION_PROMPT }], SUBAGENT_PROMPT_ORIGIN);
      await runChildTurnToCompletion(child, options.signal);
      result = lastAssistantText(child);
    }
    const usage = child.usage.data().total;
    const toolUses = child.turn.toolCallCount;
    parent.emitEvent({
      type: 'subagent.completed',
      subagentId: childId,
      resultSummary: result,
      usage,
      contextTokens: child.context.tokenCount,
    });
    this.triggerSubagentStop(parent, profileName, result);
    return { result, usage, toolUses };
  }

  private async configureChild(
    parent: Agent,
    child: Agent,
    profile: ResolvedAgentProfile,
    requestedModel: string | undefined,
    inheritContext: boolean,
  ): Promise<void> {
    // A subagent inherits the parent agent's model and effort unless the
    // spawn-level selection (profile pin, explicit alias, 'secondary') says
    // otherwise — see resolveChildModel.
    child.config.update({
      cwd: parent.config.cwd,
      ...this.resolveChildModel(parent, profile, requestedModel),
    });

    const context = await prepareSystemPromptContext(
      this.session.systemContextKaos(child.kaos.getcwd()),
      this.session.options.cloudCodeHomeDir,
      { additionalDirs: child.getAdditionalDirs() },
    );
    const subagentNames = Object.keys(
      this.session.agentCatalog.delegatableSubagents(profile.name),
    );
    child.useProfile(profile, context, this.session.options.cloudCodeHomeDir, subagentNames);
    child.tools.inheritUserTools(parent.tools);
    // Teamed teammates only: append the collaboration addendum AFTER the
    // profile render (append bus, prompt tail), so plain-subagent prompts —
    // and the shared profile prefix cache — stay byte-exact. Team-less
    // teammates keep the plain prompt: they have no team tools to teach.
    const teammate = child.teammate;
    if (teammate?.teamName !== undefined) {
      child.setSystemPromptAddendum(
        TEAMMATE_PROMPT_ADDENDUM_ID,
        renderTeammatePromptAddendum(teammate),
      );
    }
    // Fork seeding (Agent inherit_context): the child starts from a copy of
    // the parent's projected history as-of-spawn — the projection trims the
    // in-flight exchange that made the spawning call — with its prompt
    // appended after. Seeded messages count toward tokenCountWithPending, so
    // a fork starting near the context limit is handled by the child's own
    // compaction like any other large context.
    if (inheritContext) {
      child.context.useProjectedHistoryFrom(parent.context);
    }
  }

  /**
   * Fork topology guards (Agent inherit_context): coordinator mode owns the
   * orchestration role and its workers always start fresh, and teammate
   * context is team-scoped — neither side of those boundaries may produce or
   * receive a forked copy of this conversation.
   */
  private assertForkAllowed(parent: Agent, teammate: TeammateIdentity | undefined): void {
    if (parent.coordinatorMode.isActive) {
      throw new Error(
        'inherit_context is not available in coordinator mode: coordinator workers start with fresh context.',
      );
    }
    if (parent.teammate !== undefined) {
      throw new Error(
        'inherit_context is not available to teammates: team identity isolation keeps teammate context team-scoped.',
      );
    }
    if (teammate !== undefined) {
      throw new Error(
        'inherit_context cannot spawn a teammate: a teammate keeps its own team-scoped context.',
      );
    }
  }

  /**
   * Bring the child's current turn to rest: the turn itself, then any
   * background tasks it scheduled (drain semantics — see
   * drainChildBackgroundTasks).
   */
  private async settleChildTurn(child: Agent, signal: AbortSignal): Promise<void> {
    await runChildTurnToCompletion(child, signal);
    await this.drainChildBackgroundTasks(child, signal);
  }

  /**
   * Idle keep-alive (modeled on Claude Code's in-process runner main loop).
   * A teamed teammate whose prompt turn just settled stays alive for a
   * bounded idle window: while the team has claimable/assigned tasks or the
   * teammate has unread mailbox messages, a nudge turn puts it back to work
   * inside the same run — the AsyncLocalStorage teammate context of
   * `runWithActiveChild` still wraps these turns, so identity-gated tools
   * (TeamTaskClaim) work exactly as in the spawn turn. Unread messages ride
   * inline in the nudge prompt (marked read once the turn starts); the
   * per-run watcher keeps owning shutdown protocol traffic. Truly idle runs
   * exit cleanly after `idleTimeoutMs`; the run signal (TaskStop / shutdown
   * protocol) aborts the wait like any other stop. Plain subagents and
   * team-less teammates skip the loop entirely.
   */
  private async runTeammateKeepAliveLoop(
    childId: string,
    child: Agent,
    options: RunSubagentOptions,
  ): Promise<void> {
    const teammate = this.session.metadata.agents[childId]?.teammate;
    if (teammate?.teamName === undefined) return;
    const { idleTimeoutMs, pollIntervalMs } = resolveKeepAliveOptions(
      this.session.options.teammate,
    );
    if (idleTimeoutMs <= 0) return;

    let idleSince = Date.now();
    let lastSignature: string | undefined;
    let stagnantNudges = 0;
    for (;;) {
      options.signal.throwIfAborted();
      const work = await findTeammateWork(
        this.session.teamStore,
        this.session.mailbox.store,
        teammate,
      );
      if (work === undefined) {
        if (Date.now() - idleSince >= idleTimeoutMs) return;
        await abortable(sleep(pollIntervalMs), options.signal);
        continue;
      }
      // Anti-churn guard: the same unclaimed work surviving several nudge
      // turns means the model is not picking it up — stop nudging and let
      // the run end instead of looping turns on it forever. A changed
      // signature (new task, new message) resets the budget.
      if (work.signature === lastSignature) {
        stagnantNudges += 1;
        if (stagnantNudges >= MAX_STAGNANT_NUDGES) return;
      } else {
        lastSignature = work.signature;
        stagnantNudges = 0;
      }
      // Unread messages ride INLINE in the nudge prompt (same rendering the
      // watcher uses): steering them through the watcher would race a fast
      // nudge turn (see TeammateWork). They are marked read once the turn
      // actually starts, so the watcher never double-delivers.
      const promptText =
        work.messages.length === 0
          ? work.nudge
          : [
              work.nudge,
              '',
              ...work.messages.map((message) =>
                renderMailboxMessage(teammate.teamName!, message),
              ),
            ].join('\n');
      const turnId = child.turn.prompt(
        [{ type: 'text', text: promptText }],
        TEAMMATE_KEEPALIVE_PROMPT_ORIGIN,
      );
      // A null turn id means the child could not start a turn at all —
      // nothing to keep alive for.
      if (turnId === null) return;
      if (work.messages.length > 0) {
        await this.session.mailbox.store.markRead(
          teammate.teamName,
          teammate.name,
          work.messages.map((message) => message.id),
        );
      }
      await this.settleChildTurn(child, options.signal);
      idleSince = Date.now();
    }
  }

  /**
   * Hold the run open until the child agent's background tasks (background
   * Bash, nested background agents) settle — the print-mode (`cloud-code -p`)
   * drain semantics applied to subagent completion. Drained tasks get their
   * terminal notifications suppressed: without that, a task outliving the
   * child's final turn steers a fresh turn on the finished subagent
   * (`steer` degrades to `launch`), which runs unobserved and whose output
   * never reaches the parent. Bounded by the run's signal — the Agent
   * tool's per-run timeout / user-cancel envelope covers the drain too.
   */
  private async drainChildBackgroundTasks(child: Agent, signal: AbortSignal): Promise<void> {
    for (;;) {
      signal.throwIfAborted();
      await this.suppressChildTaskNotifications(child);
      await child.background.waitForActiveTasks(() => true, { signal });
      // Suppress again after the wait: notification delivery re-checks
      // suppression after its async output snapshot, so this pass still
      // blocks notifications for tasks that settled during the wait.
      await this.suppressChildTaskNotifications(child);
      // A terminal effect that slipped past the suppression race may have
      // steered a follow-up turn onto the child; let it finish (it can fan
      // out new tasks) before declaring the child drained.
      if (child.turn.hasActiveTurn) {
        await runChildTurnToCompletion(child, signal);
        continue;
      }
      if (child.background.list(true).length === 0) return;
    }
  }

  /**
   * Suppress terminal notifications for every child background task —
   * including already-settled ones whose notification may still be in
   * flight. `list(false)` is required: the active-only list drops a task
   * the moment it terminates, which is exactly when an unsuppressed
   * notification can still steer an orphan turn onto the finished child.
   */
  private async suppressChildTaskNotifications(child: Agent): Promise<void> {
    for (const task of child.background.list(false)) {
      await child.background.suppressTerminalNotification(task.taskId);
    }
  }

  private async triggerSubagentStart(
    parent: Agent,
    profileName: string,
    prompt: string,
    signal: AbortSignal,
  ): Promise<void> {
    await parent.hooks?.trigger('SubagentStart', {
      matcherValue: profileName,
      signal,
      inputData: {
        agentName: profileName,
        prompt: prompt.slice(0, HOOK_TEXT_PREVIEW_LENGTH),
      },
    });
  }

  private triggerSubagentStop(parent: Agent, profileName: string, result: string): void {
    void parent.hooks?.fireAndForgetTrigger('SubagentStop', {
      matcherValue: profileName,
      inputData: {
        agentName: profileName,
        response: result.slice(0, HOOK_TEXT_PREVIEW_LENGTH),
      },
    });
  }

  private observeFirstRequest(
    child: Agent,
    options: RunSubagentOptions,
  ): void {
    if (options.onReady === undefined) return;
    void child.turn
      .waitForTurnFirstRequest()
      .then(() => {
        options.onReady?.();
      })
      .catch(() => {});
  }

  private emitSubagentSpawned(
    parent: Agent,
    childId: string,
    profileName: string,
    options: RunSubagentOptions,
  ): void {
    parent.emitEvent({
      type: 'subagent.spawned',
      subagentId: childId,
      subagentName: profileName,
      parentToolCallId: options.parentToolCallId,
      parentToolCallUuid: options.parentToolCallUuid,
      parentAgentId: this.ownerAgentId,
      description: options.description,
      swarmIndex: options.swarmIndex,
      runInBackground: options.runInBackground,
    });
  }

  private emitSubagentStarted(
    parent: Agent,
    childId: string,
  ): void {
    parent.emitEvent({
      type: 'subagent.started',
      subagentId: childId,
    });
  }

  private emitSubagentFailed(
    parent: Agent,
    childId: string,
    options: RunSubagentOptions,
    error: unknown,
  ): void {
    if (shouldSuppressQueuedAttemptFailureEvent(options, error)) return;
    parent.emitEvent({
      type: 'subagent.failed',
      subagentId: childId,
      error: error instanceof Error ? error.message : String(error),
      // Lets clients classify a deliberate user interruption without
      // matching the English error text.
      ...(isUserCancellation(error) ? { errorKind: 'user_cancelled' as const } : {}),
    });
  }
}

async function runChildTurnToCompletion(child: Agent, signal: AbortSignal): Promise<void> {  const completion = await child.turn.waitForCurrentTurn(signal);
  const turnEnded = completion.event;
  if (turnEnded.reason !== 'completed') {
    if (turnEnded.error?.code === ErrorCodes.PROVIDER_FILTERED) {
      throw new Error('Subagent turn blocked by provider safety policy');
    }
    if (turnEnded.error?.code === ErrorCodes.PROVIDER_RATE_LIMIT) {
      throw providerRateLimitErrorFromPayload(turnEnded.error);
    }
    throw new Error(
      turnEnded.error === undefined
        ? `Subagent turn ${turnEnded.reason}`
        : `[${turnEnded.error.code}] ${turnEnded.error.message}`,
    );
  }
  if (completion.stopReason === 'max_tokens') {
    throw new Error(`${SUBAGENT_MAX_TOKENS_ERROR}.`);
  }
}

function providerRateLimitErrorFromPayload(error: {
  readonly message: string;
  readonly details?: Record<string, unknown>;
}): APIProviderRateLimitError {
  const requestId =
    typeof error.details?.['requestId'] === 'string' ? error.details['requestId'] : null;
  return new APIProviderRateLimitError(error.message, requestId);
}

function lastAssistantText(agent: Agent): string {
  for (const message of [...agent.context.history].toReversed()) {
    if (message.role !== 'assistant') continue;
    const text = message.content
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('');
    if (text.trim().length > 0) return text.trim();
  }
  return '';
}

function shouldSuppressQueuedAttemptFailureEvent(
  options: RunSubagentOptions,
  error: unknown,
): boolean {
  if (options.suppressRateLimitFailureEvent !== true) return false;
  if (isProviderRateLimitError(error)) return true;
  return isAbortError(error) || options.signal.aborted;
}
