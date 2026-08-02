import type { Agent } from '../..';
import type { PermissionPolicy, PermissionPolicyContext, PermissionPolicyResult } from '../types';

const COORDINATOR_WORKER_SPAWN_DENY_MESSAGE =
  'Workers of a coordinator cannot spawn other workers — the agent graph stays two levels ' +
  'deep, with the coordinator at the root. Do the work yourself in this run, or report back ' +
  'to the coordinator with a concrete spec so it can spawn the additional worker.';

/**
 * Topology constraint: while coordinator mode drives the session,
 * its workers (subagents latched via `Agent.setCoordinatorWorker`) must not
 * fan out further subagents. Runs with the other hard denies, above every
 * approve policy, so no permission mode can unlock nesting.
 */
export class CoordinatorWorkerSpawnDenyPermissionPolicy implements PermissionPolicy {
  readonly name = 'coordinator-worker-spawn-deny';

  constructor(private readonly agent: Agent) {}

  evaluate(context: PermissionPolicyContext): PermissionPolicyResult | undefined {
    if (!this.agent.isCoordinatorWorker) return;
    const toolName = context.toolCall.name;
    if (toolName !== 'Agent' && toolName !== 'AgentSwarm') return;
    return {
      kind: 'deny',
      message: COORDINATOR_WORKER_SPAWN_DENY_MESSAGE,
      reason: { coordinator_worker: true },
    };
  }
}
