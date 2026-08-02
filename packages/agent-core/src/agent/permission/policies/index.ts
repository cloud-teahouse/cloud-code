import type { Agent } from '../..';
import type { PermissionPolicy } from '../types';
import { AgentSwarmExclusiveDenyPermissionPolicy } from './agent-swarm-exclusive-deny';
import { AutoModeApprovePermissionPolicy } from './auto-mode-approve';
import { AutoModeAskUserQuestionDenyPermissionPolicy } from './auto-mode-ask-user-question-deny';
import { CoordinatorWorkerSpawnDenyPermissionPolicy } from './coordinator-worker-spawn-deny';
import { DefaultToolApprovePermissionPolicy } from './default-tool-approve';
import { ExitPlanModeReviewAskPermissionPolicy } from './exit-plan-mode-review-ask';
import { FallbackAskPermissionPolicy } from './fallback-ask';
import {
  GitControlPathAccessAskPermissionPolicy,
  SensitiveFileAccessAskPermissionPolicy,
} from './file-access-ask';
import { GitCwdWriteApprovePermissionPolicy } from './git-cwd-write-approve';
import { GitMutationGatePermissionPolicy } from './git-mutation-gate';
import { GoalStartReviewAskPermissionPolicy } from './goal-start-review-ask';
import { GuardianReviewPermissionPolicy } from './guardian-review';
import { PlanModeGuardDenyPermissionPolicy } from './plan-mode-guard-deny';
import { PlanModeToolApprovePermissionPolicy } from './plan-mode-tool-approve';
import { PreToolCallHookPermissionPolicy } from './pre-tool-call-hook';
import { SessionApprovalHistoryPermissionPolicy } from './session-approval-history';
import { SwarmModeAgentSwarmApprovePermissionPolicy } from './swarm-mode-agent-swarm-approve';
import { TeammateSpawnDenyPermissionPolicy } from './teammate-spawn-deny';
import {
  UserConfiguredAllowPermissionPolicy,
  UserConfiguredAskPermissionPolicy,
  UserConfiguredDenyPermissionPolicy,
} from './user-configured-rules';
import { WorktreeTeammateDenyPermissionPolicy } from './worktree-teammate-deny';
import { WorktreeToolApprovePermissionPolicy } from './worktree-tool-approve';
import { YoloModeApprovePermissionPolicy } from './yolo-mode-approve';

/** Permission policies run in order; the first non-undefined result wins. */
export function createPermissionDecisionPolicies(agent: Agent): PermissionPolicy[] {
  return [
    // PreToolUse hook returned a block → deny.
    new PreToolCallHookPermissionPolicy(agent),
    // AgentSwarm is batch-exclusive and must run alone, regardless of permission mode.
    new AgentSwarmExclusiveDenyPermissionPolicy(),
    // Coordinator workers never spawn further workers (agent graph stays two
    // levels deep) — a hard topology deny no permission mode can unlock.
    new CoordinatorWorkerSpawnDenyPermissionPolicy(agent),
    // Teammates never spawn nested teammates or background agents — a
    // hard topology deny no permission mode can unlock.
    new TeammateSpawnDenyPermissionPolicy(agent),
    // Teammates never re-root the session cwd (EnterWorktree/ExitWorktree) —
    // they share the leader's process and checkout; a hard topology deny.
    new WorktreeTeammateDenyPermissionPolicy(agent),
    // auto mode + AskUserQuestion → deny.
    new AutoModeAskUserQuestionDenyPermissionPolicy(agent),
    // plan mode: Write/Edit outside the plan file, or TaskStop → deny.
    new PlanModeGuardDenyPermissionPolicy(agent),
    // User-configured deny rule matches → deny.
    new UserConfiguredDenyPermissionPolicy(agent),
    // Approve-for-session memorized rule matches → approve. Runs before the guardian so a
    // human "approve for session" is a standing grant: re-reviewing it with the AI on every
    // later call would waste a review and could even deny what the user already approved.
    // Also runs before user-configured ask rules so an in-session grant beats a still-matching
    // ask rule on later calls. Still below every deny policy above.
    new SessionApprovalHistoryPermissionPolicy(agent),
    // Git mutation gate (C3 P3): any segment classified as a git mutation
    // (wrapper-stripped view, so `sudo git push` counts) asks with a graded
    // prompt — or is hard-blocked when permission.git_mutation = "deny".
    // Below the session history so memorized grants still unlock; above the
    // guardian so gated mutations never spend a review. No-op in yolo mode
    // and when permission.git_mutation = "allow".
    new GitMutationGatePermissionPolicy(agent),
    // Guardian AI reviewer (F3): auto mode + enabled → review the action;
    // no-op otherwise. Must stay below every deny policy and the session
    // approval history, and above auto approve.
    new GuardianReviewPermissionPolicy(agent),
    // auto mode → approve (any auto-mode block must be a deny rule above this).
    new AutoModeApprovePermissionPolicy(agent),
    // User-configured ask rule matches → ask.
    new UserConfiguredAskPermissionPolicy(agent),
    // User-configured allow rule matches → approve.
    new UserConfiguredAllowPermissionPolicy(agent),
    // ExitPlanMode with active plan_review + non-empty plan + non-auto → ask. Runs AFTER session history on purpose: a configured or session-scoped grant for ExitPlanMode is an explicit user decision that skips the interactive plan review (see the "reuses session approval for ExitPlanMode" test and the wording note in tools/builtin/planning/exit-plan-mode.ts).
    new ExitPlanModeReviewAskPermissionPolicy(agent),
    // CreateGoal (non-auto) → ask with the same start menu as /goal: choose the
    // permission mode to run the goal under, or decline. Applies the mode, then
    // lets the tool create the goal.
    new GoalStartReviewAskPermissionPolicy(agent),
    // EnterPlanMode, Write/Edit on the plan file, or ExitPlanMode with no actionable plan_review → approve.
    new PlanModeToolApprovePermissionPolicy(agent),
    // EnterWorktree and ExitWorktree("keep") are non-destructive → approve;
    // ExitWorktree("remove") falls through to the mode's own ask path.
    new WorktreeToolApprovePermissionPolicy(agent),
    // Access touches a sensitive file (.env, SSH key, credentials) → ask.
    new SensitiveFileAccessAskPermissionPolicy(),
    // Access touches .git or a git control-dir path → ask.
    new GitControlPathAccessAskPermissionPolicy(agent),
    // yolo mode → approve.
    new YoloModeApprovePermissionPolicy(agent),
    // Swarm mode keeps AgentSwarm available without making it a globally default-approved tool.
    new SwarmModeAgentSwarmApprovePermissionPolicy(agent),
    // Tool is in the default-approve list (read-only / UI helpers) → approve.
    new DefaultToolApprovePermissionPolicy(),
    // Write/Edit on POSIX paths inside cwd inside a git work tree → approve.
    new GitCwdWriteApprovePermissionPolicy(agent),
    // Nothing matched → ask.
    new FallbackAskPermissionPolicy(),
  ];
}
