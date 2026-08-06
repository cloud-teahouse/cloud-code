/**
 * Git mutation gate permission policy (design doc §3.2.B, C3 P3,
 * docs/phase5/guardian-and-bash-permissions.md).
 *
 * Sits between the session approval history and the guardian: a memorized
 * human grant still unlocks first, mutations the gate stops never spend a
 * guardian review, and the guardian keeps reviewing everything else
 * (read-level git included).
 *
 * Trigger: any segment of the call classified as a git mutation
 * (`config-injection` / `shared-remote` / `history-write` / `local-write` /
 * `unknown`). Classification ran on the wrapper-stripped token view, so
 * `sudo git push` is caught as `shared-remote` instead of hiding behind
 * the wrapper. Read-level git and non-git commands pass through untouched.
 *
 * Self-check before firing: the union of human allow rules (user-configured
 * plus session-runtime grants, exactly the union UserConfiguredAllow below
 * applies) is evaluated with `collectCoveredSubjects` — full coverage
 * approves straight through. This is what makes `allow Bash(git commit *)`
 * a legitimate unlock: UserConfiguredAllow sits below the gate and could
 * never reach these calls otherwise.
 *
 * Decision:
 *   - `permission.git_mutation = "allow"` — gate off, fall through to the
 *     existing chain (guardian in auto mode, generic rules otherwise);
 *   - `permission.git_mutation = "deny"` — hard block, no approval prompt
 *     (configured allow rules above still exempt);
 *   - `"ask"` (default) — interactive: `ask` with a graded prompt line;
 *     headless: `deny` with unlock guidance, because the headless `ask`
 *     path auto-approves (fail-open, permission/index.ts) and must be
 *     avoided, same fail-closed pattern as the guardian fallback;
 *   - `yolo` mode — skipped entirely (yolo contract: only deny rules
 *     intercept, and the design doc promises zero behavior change there).
 */

import type { Agent } from '../..';
import type { GitSegmentClass } from '../../../tools/support/shell-ast/git-classify';
import { collectCoveredSubjects } from '../matches-rule';
import type {
  PermissionPolicy,
  PermissionPolicyContext,
  PermissionPolicyResult,
  PermissionRule,
  PermissionRuleScope,
} from '../types';

/** Git classes the gate intercepts; `read` and non-git pass through. */
type GitMutationClass = Exclude<GitSegmentClass, 'read' | undefined>;

/**
 * The policy name is part of the grant-provenance contract (C3 P5): the
 * permission manager tags session grants issued through this gate by
 * comparing the deciding policy's name against it.
 */
export const GIT_MUTATION_GATE_POLICY_NAME = 'git-mutation-gate';

/**
 * Leading text of every gate approval prompt. Grant replay (C3 P5) derives
 * a replayed grant's surface from this prefix because the wire record
 * schema carries no surface field — keep it stable.
 */
export const GIT_MUTATION_GATE_APPROVAL_ACTION_PREFIX = 'Git mutation gate:';

/**
 * Representative-class ranking when several segments mutate: the most
 * consequential class names the prompt. `unknown` ranks
 * above `local-write` — an alias can hide a push.
 */
const MUTATION_CLASS_RANK: readonly GitMutationClass[] = [
  'config-injection',
  'shared-remote',
  'history-write',
  'unknown',
  'local-write',
];

/** Graded prompt/deny text per class (English constants; agent-core permission policies carry no i18n layer). */
const MUTATION_CLASS_DESCRIPTIONS: Readonly<Record<GitMutationClass, string>> = {
  'config-injection':
    'injects inline git config (-c / --exec-path / --config-env), which can run arbitrary commands through git',
  'shared-remote':
    'sends shared state to a remote — pushed refs cannot be taken back',
  'history-write': 'rewrites git history',
  unknown: 'runs an unknown git subcommand (possibly an alias) — treated as a mutation',
  'local-write': 'modifies local repository state',
};

const CONFIGURED_RULE_SCOPES: ReadonlySet<PermissionRuleScope> = new Set([
  'turn-override',
  'project',
  'user',
]);

export class GitMutationGatePermissionPolicy implements PermissionPolicy {
  readonly name = GIT_MUTATION_GATE_POLICY_NAME;

  constructor(private readonly agent: Agent) {}

  evaluate(context: PermissionPolicyContext): PermissionPolicyResult | undefined {
    // Yolo contract: only deny rules intercept; the gate stays out entirely.
    if (this.agent.permission.mode === 'yolo') return;
    const setting = this.agent.cloudCodeConfig?.permission?.gitMutation ?? 'ask';
    if (setting === 'allow') return;

    const gitClass = representativeMutationClass(context.execution.gitClasses);
    if (gitClass === undefined) return;

    // Human allow union (configured + session grants): a standing human
    // rule is a legitimate unlock (the gate sits above UserConfiguredAllow,
    // so it must check itself).
    if (this.coveredByConfiguredAllow(context)) {
      return {
        kind: 'approve',
        reason: { git_class: gitClass, covered_by: 'configured_allow_rule' },
      };
    }

    if (setting === 'deny') {
      return {
        kind: 'deny',
        reason: { git_class: gitClass, gate_setting: 'deny' },
        message:
          `Tool "${context.toolCall.name}" was not run: this command ` +
          `${MUTATION_CLASS_DESCRIPTIONS[gitClass]}, and git mutations are blocked by ` +
          'permission.git_mutation = "deny". Exempt specific operations with a configured ' +
          'allow rule (e.g. "allow Bash(git push *)"), or change the setting — do not retry ' +
          'the same command.',
      };
    }

    const interactive = this.agent.rpc?.requestApproval !== undefined;
    if (!interactive) {
      // Fail closed: a headless `ask` would auto-approve.
      return {
        kind: 'deny',
        reason: { git_class: gitClass, headless: true },
        message:
          `Tool "${context.toolCall.name}" was not run: this command ` +
          `${MUTATION_CLASS_DESCRIPTIONS[gitClass]}, which requires interactive approval, ` +
          'and no interactive approval channel is available. Unlock it with a configured ' +
          'allow rule (e.g. "allow Bash(git push *)") or set permission.git_mutation = ' +
          '"allow" — do not retry the same command.',
      };
    }

    return {
      kind: 'ask',
      reason: { git_class: gitClass },
      approvalAction:
        `${GIT_MUTATION_GATE_APPROVAL_ACTION_PREFIX} this command ` +
        `${MUTATION_CLASS_DESCRIPTIONS[gitClass]}. Review the command before approving.`,
    };
  }

  /**
   * Union of human allow rules must cover every segment (∀). Configured
   * rules and session-runtime grants are unioned together — mirroring
   * UserConfiguredAllow below — so a session grant and a configured rule
   * can each cover part of one compound command. (Session-only coverage
   * never reaches here: SessionApprovalHistory sits above the gate.)
   */
  private coveredByConfiguredAllow(context: PermissionPolicyContext): boolean {
    const sessionRules: readonly PermissionRule[] = this.agent.permission.sessionApprovalRules;
    const configuredRules: PermissionRule[] = this.agent.permission
      .data()
      .rules.filter(
        (rule) => CONFIGURED_RULE_SCOPES.has(rule.scope) && rule.decision === 'allow',
      );
    const rules = [...sessionRules, ...configuredRules];
    if (rules.length === 0) return false;
    const cover = collectCoveredSubjects({
      rules,
      toolName: context.toolCall.name,
      execution: context.execution,
    });
    return cover?.fullyCovered === true;
  }

}

/** Highest-ranked mutation class among the segments, if any. */
function representativeMutationClass(
  gitClasses: readonly GitSegmentClass[] | undefined,
): GitMutationClass | undefined {
  if (gitClasses === undefined) return undefined;
  let best: GitMutationClass | undefined;
  for (const gitClass of gitClasses) {
    if (gitClass === undefined || gitClass === 'read') continue;
    if (
      best === undefined ||
      MUTATION_CLASS_RANK.indexOf(gitClass) < MUTATION_CLASS_RANK.indexOf(best)
    ) {
      best = gitClass;
    }
  }
  return best;
}
