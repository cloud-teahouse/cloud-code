import { errorMessage, isAbortError } from '../../loop/errors';
import type { TokenUsage } from '@cloud-code/kosong';
import {
  type BackgroundTask,
  type BackgroundTaskInfoBase,
  type BackgroundTaskSink,
} from './task';
import type { SessionSubagentHost, SubagentHandle } from '../../session/subagent-host';
import type { TeammateIdentity } from '../swarm/teammate-context';

export interface AgentBackgroundTaskInfo extends BackgroundTaskInfoBase {
  readonly kind: 'agent';
  /** Subagent identifier accepted by Agent(resume=...). */
  readonly agentId?: string;
  /** Subagent profile name. */
  readonly subagentType?: string;
  /**
   * Present when this task is an in-process teammate: the stable
   * teammate identity (name, and team when spawned into one). Surfaced so
   * the task panel and the mailbox/team layer can tell teammates apart
   * from plain background subagents.
   */
  readonly teammate?: TeammateIdentity;
  /**
   * Cumulative token usage of the subagent run, captured when the run
   * completes successfully. Feeds the coordinator-mode `<task-notification>`
   * `<usage>` section; absent on failed/killed runs.
   */
  readonly usage?: TokenUsage;
  /**
   * Tool calls the worker dispatched, captured alongside `usage`. Feeds the
   * `<tool_uses>` field of the coordinator-mode `<task-notification>`.
   */
  readonly toolUses?: number;
}

export class AgentBackgroundTask implements BackgroundTask {
  readonly kind = 'agent' as const;
  readonly idPrefix: string = 'agent';
  readonly agentId: string;
  readonly subagentType: string;
  readonly teammate?: TeammateIdentity;
  private usage?: TokenUsage;
  private toolUses?: number;

  constructor(
    private readonly handle: SubagentHandle,
    readonly description: string,
    private readonly subagentHost: Pick<SessionSubagentHost, 'markActiveChildDetached'>,
    private readonly abortController: AbortController,
    teammate?: TeammateIdentity,
  ) {
    this.agentId = handle.agentId;
    this.subagentType = handle.profileName;
    this.teammate = teammate;
  }

  async start(sink: BackgroundTaskSink): Promise<void> {
    const requestAbort = (): void => {
      this.abortController.abort(sink.signal.reason);
    };
    if (sink.signal.aborted) {
      requestAbort();
    } else {
      sink.signal.addEventListener('abort', requestAbort, { once: true });
    }

    try {
      const outcome = await this.handle.completion;
      sink.appendOutput(outcome.result);
      this.usage = outcome.usage;
      this.toolUses = outcome.toolUses;
      await sink.settle({ status: 'completed' });
    } catch (error: unknown) {
      if (sink.signal.aborted && (isAbortError(error) || error === sink.signal.reason)) {
        await sink.settle({ status: 'killed' });
        return;
      }
      await sink.settle({ status: 'failed', stopReason: errorMessage(error) });
    } finally {
      sink.signal.removeEventListener('abort', requestAbort);
    }
  }

  onDetach(): void {
    this.subagentHost.markActiveChildDetached(this.agentId);
  }

  toInfo(base: BackgroundTaskInfoBase): AgentBackgroundTaskInfo {
    return {
      ...base,
      kind: 'agent',
      agentId: this.agentId,
      subagentType: this.subagentType,
      teammate: this.teammate,
      usage: this.usage,
      toolUses: this.toolUses,
    };
  }
}
