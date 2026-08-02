import type { PermissionPolicy, PermissionPolicyContext, PermissionPolicyResult } from '../types';

/**
 * Read-only / UI helper tools approved by default. Exported so the guardian
 * review policy (F3) can bypass the same set — reviewing these would cost a
 * model call per read with no safety benefit. Keep one shared set so the two
 * policies never drift apart.
 */
export const DEFAULT_APPROVE_TOOLS = new Set([
  'Read',
  'Grep',
  'Glob',
  'ReadMediaFile',
  'SetTodoList',
  'TodoList',
  'TaskList',
  'TaskOutput',
  'CronList',
  'WebSearch',
  'FetchURL',
  'Agent',
  'AskUserQuestion',
  'Skill',
  // Goal control tools have no side effects on the world: GetGoal reads, and
  // mutation tools only record the goal's own runtime state.
  'GetGoal',
  'SetGoalBudget',
  'UpdateGoal',
  // Loading a tool definition into context has no side effects on the world;
  // executing the loaded tool still goes through its own approval.
  'select_tools',
]);

/**
 * Session-transport tools (RFC `docs/rfc/unified-exec-pty.md` §3.4):
 * `WriteStdin` only carries bytes into a persistent session whose initial
 * command already went through the full permission chain at ExecSession
 * creation — 会话传输工具，创建时已评审. Re-running the chain per call
 * would prompt on a 250ms write/poll cadence with zero added safety, so
 * these approve by default too. Kept as a named set separate from
 * DEFAULT_APPROVE_TOOLS: they are NOT read-only, and the Guardian policy
 * exempts them explicitly with the same rationale.
 */
export const SESSION_TRANSPORT_TOOLS = new Set(['WriteStdin']);

export class DefaultToolApprovePermissionPolicy implements PermissionPolicy {
  readonly name = 'default-tool-approve';

  evaluate(context: PermissionPolicyContext): PermissionPolicyResult | undefined {
    if (
      !DEFAULT_APPROVE_TOOLS.has(context.toolCall.name) &&
      !SESSION_TRANSPORT_TOOLS.has(context.toolCall.name)
    ) {
      return;
    }
    return {
      kind: 'approve',
    };
  }
}
