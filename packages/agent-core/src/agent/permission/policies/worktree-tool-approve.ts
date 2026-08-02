import type { Agent } from '../..';
import type { PermissionPolicy, PermissionPolicyContext, PermissionPolicyResult } from '../types';
import { parseArguments, recordArgs } from './tool-args';

/**
 * Approval posture for the worktree tools, mirroring the plan-mode pair:
 * - EnterWorktree is non-destructive (a new directory and branch under
 *   `.cloud-code/worktrees/`, fully reversible via ExitWorktree) → approve.
 * - ExitWorktree with action "keep" only moves the session cwd back → approve.
 * - ExitWorktree with action "remove" destroys a directory and a branch →
 *   fall through so manual mode asks (FallbackAsk), with the tool's own
 *   dirty-work refusal gate on top. Auto/yolo modes keep their existing
 *   semantics via their own policies.
 */
export class WorktreeToolApprovePermissionPolicy implements PermissionPolicy {
  readonly name = 'worktree-tool-approve';

  constructor(private readonly agent: Agent) {}

  evaluate(context: PermissionPolicyContext): PermissionPolicyResult | undefined {
    const toolName = context.toolCall.name;
    if (toolName === 'EnterWorktree') {
      return { kind: 'approve' };
    }
    if (toolName === 'ExitWorktree') {
      const args = recordArgs(context.args) ?? parseArguments(context.toolCall.arguments);
      if (args?.['action'] !== 'remove') {
        return { kind: 'approve' };
      }
    }
    return;
  }
}
