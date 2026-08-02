import type { Agent } from '../..';
import type { PermissionPolicy, PermissionPolicyContext, PermissionPolicyResult } from '../types';

const TEAMMATE_WORKTREE_DENY_MESSAGE =
  'Teammates cannot enter or exit worktrees — every in-process teammate shares the ' +
  "leader's process and working directory, so re-rooting the session cwd would move " +
  'the whole swarm, not just the caller. The leader manages worktrees; teammates ' +
  'work in the checkout the leader placed them in.';

/**
 * Topology constraint: an agent latched as an in-process teammate
 * (`Agent.setTeammateIdentity`) must never re-root the session working
 * directory. Teammates are separate Agent instances, but they share the
 * leader's process and the workspace the leader set up; a per-teammate
 * worktree would also give the swarm no consistent view of "the project".
 * A hard deny, running with the other topology denies above every approve
 * policy, so no permission mode can unlock it.
 */
export class WorktreeTeammateDenyPermissionPolicy implements PermissionPolicy {
  readonly name = 'worktree-teammate-deny';

  constructor(private readonly agent: Agent) {}

  evaluate(context: PermissionPolicyContext): PermissionPolicyResult | undefined {
    if (!this.agent.isTeammate) return;
    const toolName = context.toolCall.name;
    if (toolName !== 'EnterWorktree' && toolName !== 'ExitWorktree') return;
    return {
      kind: 'deny',
      message: TEAMMATE_WORKTREE_DENY_MESSAGE,
      reason: { teammate_worktree_switch: true },
    };
  }
}
