import type { Agent } from '../..';
import type { PermissionPolicy, PermissionPolicyContext, PermissionPolicyResult } from '../types';
import { parseArguments, recordArgs } from './tool-args';

const NESTED_TEAMMATE_DENY_MESSAGE =
  'Teammates cannot spawn other teammates — the team roster stays flat, with the leader at ' +
  'the root. To delegate a bounded task, spawn a plain subagent instead (omit the `name` ' +
  'parameter), or report back to the leader with a concrete spec so it can spawn the ' +
  'additional teammate.';

const BACKGROUND_AGENT_DENY_MESSAGE =
  'In-process teammates cannot launch background agents — a teammate\'s lifecycle is bound ' +
  'to the leader\'s process, and a detached agent could outlive it. Use ' +
  'run_in_background=false for synchronous subagents.';

/**
 * Topology constraints: an agent latched as an in-process teammate
 * (`Agent.setTeammateIdentity`) must not
 *   1. spawn another teammate (Agent with `name`) — the team roster is flat,
 *      nested teammates would land in it with no provenance; and
 *   2. launch background agents (Agent with `run_in_background=true`) — a
 *      detached agent's lifecycle is not tied to the teammate's own task.
 * Plain foreground subagent spawns (Agent without `name`, AgentSwarm) stay
 * allowed: teammates may delegate bounded work, just not grow the team or
 * detach from it. Runs with the other hard denies, above every approve
 * policy, so no permission mode can unlock the escape.
 */
export class TeammateSpawnDenyPermissionPolicy implements PermissionPolicy {
  readonly name = 'teammate-spawn-deny';

  constructor(private readonly agent: Agent) {}

  evaluate(context: PermissionPolicyContext): PermissionPolicyResult | undefined {
    if (!this.agent.isTeammate) return;
    if (context.toolCall.name !== 'Agent') return;
    const args = recordArgs(context.args) ?? parseArguments(context.toolCall.arguments);
    if (typeof args?.['name'] === 'string' && args['name'].trim().length > 0) {
      return {
        kind: 'deny',
        message: NESTED_TEAMMATE_DENY_MESSAGE,
        reason: { teammate_nested_spawn: true },
      };
    }
    if (args?.['run_in_background'] === true) {
      return {
        kind: 'deny',
        message: BACKGROUND_AGENT_DENY_MESSAGE,
        reason: { teammate_background_agent: true },
      };
    }
    return;
  }
}
